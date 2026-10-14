import { randomUUID } from 'node:crypto';
import { PassThrough } from 'node:stream';
import type {
  ContainerSpec,
  ContainerStats,
  SSEEvent,
  SpawnContainerResult,
} from '@issue-resolver/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app';
import { createDb } from '../src/db/client';
import type { Db } from '../src/db/client';
import { issues } from '../src/db/schema';
import type { ContainerController } from '../src/docker/controller';
import { InMemorySseHub } from '../src/sse/hub';

const ROUTE_PATH = '/issue-resolver/api/v1/issues';

/** ContainerController с управляемым результатом `stats`; Docker не трогается. */
class StubContainerController implements ContainerController {
  result: ContainerStats | null = null;
  error: (Error & { statusCode?: number }) | null = null;
  readonly statsCalls: string[] = [];
  /** Поток для SSE-теста: тест пишет в него docker-stats NDJSON. */
  readonly stream = new PassThrough();
  streamError: (Error & { statusCode?: number }) | null = null;
  readonly statsStreamCalls: string[] = [];

  async spawn(spec: ContainerSpec): Promise<SpawnContainerResult> {
    return {
      containerId: `cid-${spec.containerName}`,
      containerName: spec.containerName,
      workspacePath: spec.workspaceHostPath,
    };
  }

  async remove(): Promise<void> {}

  async stats(containerName: string): Promise<ContainerStats> {
    this.statsCalls.push(containerName);
    if (this.error) throw this.error;
    return (
      this.result ?? {
        containerName,
        cpuPercent: null,
        memoryUsageBytes: 0,
        memoryLimitBytes: 0,
        pids: 0,
      }
    );
  }

  async statsStream(containerName: string): Promise<NodeJS.ReadableStream> {
    this.statsStreamCalls.push(containerName);
    if (this.streamError) throw this.streamError;
    return this.stream;
  }
}

const openApps: Array<{ close: () => Promise<void> }> = [];

afterEach(async () => {
  await Promise.all(openApps.splice(0).map((app) => app.close()));
  vi.restoreAllMocks();
});

/** Прямой insert задачи: POST /issues запускает фоновый прогон, он здесь не нужен. */
function seedIssue(db: Db): string {
  const now = new Date().toISOString();
  const id = randomUUID();
  db.insert(issues)
    .values({
      id,
      title: 'Задача со статами',
      jira_issue_url: null,
      pipeline_steps: ['resolve'],
      container_name: null,
      status: 'pending',
      created_at: now,
      updated_at: now,
    })
    .run();
  return id;
}

function makeApp(
  db: Db,
  container: ContainerController,
): ReturnType<typeof buildApp> {
  const app = buildApp(db, { container });
  openApps.push(app);
  return app;
}

describe('GET /issues/:id/container-stats', () => {
  it('200: ContainerStats контроллера + имя контейнера задачи', async () => {
    const db = createDb(':memory:');
    const container = new StubContainerController();
    const id = seedIssue(db);
    container.result = {
      containerName: `issue-resolver-${id}`,
      cpuPercent: 12.5,
      memoryUsageBytes: 1024,
      memoryLimitBytes: 2048,
      pids: 7,
    };
    const app = makeApp(db, container);

    const response = await app.inject({
      method: 'GET',
      url: `${ROUTE_PATH}/${id}/container-stats`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      containerName: `issue-resolver-${id}`,
      cpuPercent: 12.5,
      memoryUsageBytes: 1024,
      memoryLimitBytes: 2048,
      pids: 7,
    });
    expect(container.statsCalls).toEqual([`issue-resolver-${id}`]);
  });

  it('контейнера нет (Dockerode 404) → 200 { containerName, error }', async () => {
    const db = createDb(':memory:');
    const container = new StubContainerController();
    const id = seedIssue(db);
    container.error = Object.assign(new Error('No such container'), {
      statusCode: 404,
    });
    const app = makeApp(db, container);

    const response = await app.inject({
      method: 'GET',
      url: `${ROUTE_PATH}/${id}/container-stats`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      containerName: `issue-resolver-${id}`,
      error: 'container_not_found',
    });
  });

  it('прочий сбой stats → 200 с null/0 полями, запрос не падает', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const db = createDb(':memory:');
    const container = new StubContainerController();
    const id = seedIssue(db);
    container.error = new Error('docker socket down');
    const app = makeApp(db, container);

    const response = await app.inject({
      method: 'GET',
      url: `${ROUTE_PATH}/${id}/container-stats`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      containerName: `issue-resolver-${id}`,
      cpuPercent: null,
      memoryUsageBytes: 0,
      memoryLimitBytes: 0,
      pids: 0,
    });
    expect(errorSpy).toHaveBeenCalled();
  });

  it('несуществующая задача → 404 { error }', async () => {
    const app = makeApp(createDb(':memory:'), new StubContainerController());

    const response = await app.inject({
      method: 'GET',
      url: `${ROUTE_PATH}/${randomUUID()}/container-stats`,
    });

    expect(response.statusCode).toBe(404);
    expect(typeof response.json().error).toBe('string');
  });
});

describe('GET /issues/:id/container-stats-stream', () => {
  it('несуществующая задача → 404 { error } без открытия потока', async () => {
    const container = new StubContainerController();
    const app = makeApp(createDb(':memory:'), container);

    const response = await app.inject({
      method: 'GET',
      url: `${ROUTE_PATH}/${randomUUID()}/container-stats-stream`,
    });

    expect(response.statusCode).toBe(404);
    expect(typeof response.json().error).toBe('string');
    expect(container.statsStreamCalls).toEqual([]);
  });

  it('контейнера нет (Dockerode 404) → 404 до hijack', async () => {
    const container = new StubContainerController();
    container.streamError = Object.assign(new Error('No such container'), {
      statusCode: 404,
    });
    const db = createDb(':memory:');
    const id = seedIssue(db);
    const app = makeApp(db, container);

    const response = await app.inject({
      method: 'GET',
      url: `${ROUTE_PATH}/${id}/container-stats-stream`,
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({
      containerName: `issue-resolver-${id}`,
      error: 'container_not_found',
    });
  });

  it('SSE: docker-stats NDJSON → container_stats в общую шину', async () => {
    const db = createDb(':memory:');
    const container = new StubContainerController();
    const id = seedIssue(db);
    const hub = new InMemorySseHub();
    const received: SSEEvent[] = [];
    hub.subscribeByIssue(id, (event) => received.push(event));
    const app = buildApp(db, { container, sse: hub });
    openApps.push(app);

    await app.listen({ port: 0, host: '127.0.0.1' });
    const address = app.server.address();
    if (address === null || typeof address === 'string') {
      throw new Error('server has no TCP address');
    }

    const controller = new AbortController();
    try {
      const response = await fetch(
        `http://127.0.0.1:${address.port}${ROUTE_PATH}/${id}/container-stats-stream`,
        { signal: controller.signal },
      );

      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toContain(
        'text/event-stream',
      );
      expect(container.statsStreamCalls).toEqual([`issue-resolver-${id}`]);

      container.stream.write(
        `${JSON.stringify({
          cpu_stats: {
            cpu_usage: { total_usage: 300 },
            system_cpu_usage: 5000,
            online_cpus: 2,
          },
          precpu_stats: {
            cpu_usage: { total_usage: 100 },
            system_cpu_usage: 1000,
          },
          memory_stats: { usage: 1024, limit: 2048 },
          pids_stats: { current: 7 },
        })}\n`,
      );

      // Роут пишет метрики не в свой ответ, а в шину — читаем её.
      await vi.waitFor(() => expect(received).toHaveLength(1));
      expect(received[0]).toMatchObject({
        type: 'container_stats',
        issueId: id,
        data: JSON.stringify({
          cpuPercent: 10,
          memoryUsageBytes: 1024,
          memoryLimitBytes: 2048,
          pids: 7,
        }),
      });

      controller.abort();
    } finally {
      controller.abort();
    }
  });
});

describe('GET /container-stats-stream (глобальный, без issueId)', () => {
  const GLOBAL_URL = '/issue-resolver/api/v1/container-stats-stream';

  it('SSE: NDJSON → container_stats c issueId "__global__" в глобальную шину', async () => {
    const container = new StubContainerController();
    const hub = new InMemorySseHub();
    const received: SSEEvent[] = [];
    hub.subscribeGlobal((event) => received.push(event));
    const app = buildApp(createDb(':memory:'), { container, sse: hub });
    openApps.push(app);

    await app.listen({ port: 0, host: '127.0.0.1' });
    const address = app.server.address();
    if (address === null || typeof address === 'string') {
      throw new Error('server has no TCP address');
    }

    const controller = new AbortController();
    try {
      const response = await fetch(
        `http://127.0.0.1:${address.port}${GLOBAL_URL}`,
        { signal: controller.signal },
      );

      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toContain(
        'text/event-stream',
      );
      // Задача не нужна: глобальный поток всегда спрашивает контейнер 'host'.
      expect(container.statsStreamCalls).toEqual(['host']);

      container.stream.write(
        `${JSON.stringify({
          cpu_stats: {
            cpu_usage: { total_usage: 300 },
            system_cpu_usage: 5000,
            online_cpus: 2,
          },
          precpu_stats: {
            cpu_usage: { total_usage: 100 },
            system_cpu_usage: 1000,
          },
          memory_stats: { usage: 1024, limit: 2048 },
          pids_stats: { current: 7 },
        })}\n`,
      );

      await vi.waitFor(() => expect(received).toHaveLength(1));
      expect(received[0]).toMatchObject({
        type: 'container_stats',
        issueId: '__global__',
        data: JSON.stringify({
          cpuPercent: 10,
          memoryUsageBytes: 1024,
          memoryLimitBytes: 2048,
          pids: 7,
        }),
      });

      controller.abort();
    } finally {
      controller.abort();
    }
  });

  it('сбой statsStream → 503 container_stats_unavailable', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const container = new StubContainerController();
    container.streamError = new Error('no host container');
    const app = makeApp(createDb(':memory:'), container);

    const response = await app.inject({ method: 'GET', url: GLOBAL_URL });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ error: 'container_stats_unavailable' });
    expect(container.statsStreamCalls).toEqual(['host']);
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});