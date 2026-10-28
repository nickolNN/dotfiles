import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type {
  ContainerSpec,
  ContainerStats,
  SSEEvent,
  SpawnContainerResult,
} from '@issue-resolver/shared';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app';
import type { Db } from '../src/db/client';
import { createDb } from '../src/db/client';
import {
  issueRepositories,
  issues,
  iterations,
  stepOutputs,
  stepRuns,
} from '../src/db/schema';
import type { ContainerController } from '../src/docker/controller';
import type { SseHub } from '../src/sse/hub';

const ROUTE_PATH = '/issue-resolver/api/v1/issues';

class SpyContainerController implements ContainerController {
  readonly spawned: string[] = [];
  readonly removed: string[] = [];
  private pendingError: Error | null = null;

  failNextWith(error: Error): void {
    this.pendingError = error;
  }

  async spawn(spec: ContainerSpec): Promise<SpawnContainerResult> {
    this.throwIfPending();
    this.spawned.push(spec.containerName);
    return {
      containerId: `cid-${spec.containerName}`,
      containerName: spec.containerName,
      workspacePath: spec.workspaceHostPath,
    };
  }

  async remove(containerName: string): Promise<void> {
    this.throwIfPending();
    this.removed.push(containerName);
  }

  async stats(containerName: string): Promise<ContainerStats> {
    this.throwIfPending();
    return {
      containerName,
      cpuPercent: 0,
      memoryUsageBytes: 0,
      memoryLimitBytes: 0,
      pids: 0,
    };
  }

  async statsStream(_containerName: string): Promise<NodeJS.ReadableStream> {
    this.throwIfPending();
    return new PassThrough();
  }

  private throwIfPending(): void {
    if (this.pendingError) {
      const error = this.pendingError;
      this.pendingError = null;
      throw error;
    }
  }
}

class RecordingSseHub implements SseHub {
  readonly events: SSEEvent[] = [];

  publish(event: SSEEvent): void {
    this.events.push(event);
  }

  subscribe(): () => void {
    return () => {};
  }

  subscribeByIssue(): () => void {
    return () => {};
  }

  subscribeGlobal(): () => void {
    return () => {};
  }
}

const openApps: Array<{ close: () => Promise<void> }> = [];
const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(openApps.splice(0).map((app) => app.close()));
  await Promise.all(
    tempRoots.splice(0).map((root) =>
      rm(root, { recursive: true, force: true }),
    ),
  );
});

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'issue-delete-'));
  tempRoots.push(root);
  return root;
}

function makeApp(
  db: Db,
  container: SpyContainerController,
  workspaceRoot: string,
  sse?: SseHub,
): ReturnType<typeof buildApp> {
  const app = buildApp(db, {
    container,
    workspaceRoot,
    ...(sse ? { sse } : {}),
  });
  openApps.push(app);
  return app;
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 3000,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('waitFor: timeout');
}

function phasesOf(sse: RecordingSseHub, issueId: string): string[] {
  return sse.events
    .filter(
      (event) => event.type === 'issue_deleting' && event.issueId === issueId,
    )
    .map((event) => (JSON.parse(event.data) as { phase: string }).phase);
}

function hasEvent(
  sse: RecordingSseHub,
  type: SSEEvent['type'],
  issueId: string,
): boolean {
  return sse.events.some(
    (event) => event.type === type && event.issueId === issueId,
  );
}

function seedIssue(db: Db): string {
  const id = randomUUID();
  const now = new Date().toISOString();
  db.insert(issues)
    .values({
      id,
      title: 'Задача на удаление',
      description: '',
      desired_result: 'md',
      pipeline_steps: [],
      status: 'pending',
      created_at: now,
      updated_at: now,
    })
    .run();
  return id;
}

function sqliteOf(db: Db): { exec: (sql: string) => void } {
  return (db as unknown as { $client: { exec: (sql: string) => void } })
    .$client;
}

const REPOSITORIES = [
  { repository_url: 'https://github.com/acme/app.git', base_branch: 'main' },
];

describe('DELETE /issues/:id — полная зачистка', () => {
  it('удаление чистит БД-каскад + папку + контейнер', async () => {
    const db = createDb(':memory:');
    const container = new SpyContainerController();
    const sse = new RecordingSseHub();
    const workspaceRoot = await makeRoot();
    const app = makeApp(db, container, workspaceRoot, sse);

    const created = await app.inject({
      method: 'POST',
      url: ROUTE_PATH,
      payload: { title: 'Задача на удаление', repositories: REPOSITORIES },
    });
    expect(created.statusCode).toBe(201);
    const issueId = created.json().id as string;

    await waitFor(async () => {
      const fetched = await app.inject({
        method: 'GET',
        url: `${ROUTE_PATH}/${issueId}`,
      });
      return ['completed', 'failed'].includes(fetched.json().status);
    });

    const iteration = db
      .select()
      .from(iterations)
      .where(eq(iterations.issue_id, issueId))
      .get();
    expect(iteration).toBeDefined();
    const now = new Date().toISOString();
    const stepRunId = randomUUID();
    db.insert(stepRuns)
      .values({
        id: stepRunId,
        issue_id: issueId,
        iteration_id: iteration!.id,
        step: 'test',
        attempt: 1,
        status: 'success',
        context: '',
        feedback: null,
        created_at: now,
        updated_at: now,
      })
      .run();
    db.insert(stepOutputs)
      .values({
        id: randomUUID(),
        step_run_id: stepRunId,
        report: '"ok"',
        screenshots_dir: null,
        created_at: now,
        updated_at: now,
      })
      .run();

    const issueDir = join(workspaceRoot, issueId);
    mkdirSync(issueDir, { recursive: true });
    writeFileSync(join(issueDir, 'work.txt'), 'artifact');

    const response = await app.inject({
      method: 'DELETE',
      url: `${ROUTE_PATH}/${issueId}`,
    });
    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({ ok: true });

    await waitFor(() => hasEvent(sse, 'issue_deleted', issueId));

    const fetched = await app.inject({
      method: 'GET',
      url: `${ROUTE_PATH}/${issueId}`,
    });
    expect(fetched.statusCode).toBe(404);

    expect(db.select().from(issues).all()).toHaveLength(0);
    expect(db.select().from(issueRepositories).all()).toHaveLength(0);
    expect(db.select().from(iterations).all()).toHaveLength(0);
    expect(db.select().from(stepRuns).all()).toHaveLength(0);
    expect(db.select().from(stepOutputs).all()).toHaveLength(0);

    expect(container.removed).toContain(`issue-resolver-${issueId}`);
    expect(existsSync(issueDir)).toBe(false);

    expect(phasesOf(sse, issueId)).toEqual([
      'stopping_processes',
      'removing_db_record',
      'removing_container',
      'removing_workspace',
    ]);
    expect(hasEvent(sse, 'issue_deleted', issueId)).toBe(true);
  });

  it('DELETE неизвестного id → 404', async () => {
    const db = createDb(':memory:');
    const container = new SpyContainerController();
    const workspaceRoot = await makeRoot();
    const app = makeApp(db, container, workspaceRoot);

    const response = await app.inject({
      method: 'DELETE',
      url: `${ROUTE_PATH}/${randomUUID()}`,
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: 'issue not found' });
    expect(container.removed).toEqual([]);
  });
});

describe('DELETE /issues/:id — corner cases', () => {
  it('сбой db.delete → phase error, папка и контейнер НЕ тронуты', async () => {
    const db = createDb(':memory:');
    const container = new SpyContainerController();
    const sse = new RecordingSseHub();
    const workspaceRoot = await makeRoot();
    const app = makeApp(db, container, workspaceRoot, sse);
    const issueId = seedIssue(db);

    const issueDir = join(workspaceRoot, issueId);
    mkdirSync(issueDir, { recursive: true });
    writeFileSync(join(issueDir, 'work.txt'), 'artifact');

    sqliteOf(db).exec(
      "CREATE TRIGGER fail_delete BEFORE DELETE ON issues BEGIN SELECT RAISE(ABORT, 'db delete failed'); END;",
    );

    const response = await app.inject({
      method: 'DELETE',
      url: `${ROUTE_PATH}/${issueId}`,
    });
    expect(response.statusCode).toBe(202);

    await waitFor(() => phasesOf(sse, issueId).includes('error'));

    const fetched = await app.inject({
      method: 'GET',
      url: `${ROUTE_PATH}/${issueId}`,
    });
    expect(fetched.statusCode).toBe(200);
    expect(existsSync(issueDir)).toBe(true);
    expect(container.removed).toEqual([]);
    expect(hasEvent(sse, 'issue_deleted', issueId)).toBe(false);

    expect(phasesOf(sse, issueId)).toEqual([
      'stopping_processes',
      'removing_db_record',
      'error',
    ]);
    const errorEvent = sse.events.find(
      (event) =>
        event.type === 'issue_deleting' &&
        event.issueId === issueId &&
        (JSON.parse(event.data) as { phase: string }).phase === 'error',
    );
    expect(JSON.parse(errorEvent!.data)).toMatchObject({
      phase: 'error',
      message: expect.stringContaining('db delete failed'),
    });
  });

  it('сбой container.remove → идём к папке, финал issue_deleted', async () => {
    const db = createDb(':memory:');
    const container = new SpyContainerController();
    const sse = new RecordingSseHub();
    const workspaceRoot = await makeRoot();
    const app = makeApp(db, container, workspaceRoot, sse);
    const issueId = seedIssue(db);

    const issueDir = join(workspaceRoot, issueId);
    mkdirSync(issueDir, { recursive: true });
    writeFileSync(join(issueDir, 'work.txt'), 'artifact');

    container.failNextWith(new Error('docker down'));

    const response = await app.inject({
      method: 'DELETE',
      url: `${ROUTE_PATH}/${issueId}`,
    });
    expect(response.statusCode).toBe(202);

    await waitFor(() => hasEvent(sse, 'issue_deleted', issueId));

    expect(container.removed).toEqual([]);
    expect(db.select().from(issues).all()).toHaveLength(0);
    expect(existsSync(issueDir)).toBe(false);
    expect(phasesOf(sse, issueId)).toEqual([
      'stopping_processes',
      'removing_db_record',
      'removing_container',
      'removing_workspace',
    ]);
  });

  it('сбой rm рабочей папки → запись уже удалена, финал issue_deleted', async () => {
    const db = createDb(':memory:');
    const container = new SpyContainerController();
    const sse = new RecordingSseHub();
    const root = await makeRoot();
    const blocker = join(root, 'not-a-dir');
    writeFileSync(blocker, 'x');
    const app = makeApp(db, container, blocker, sse);
    const issueId = seedIssue(db);

    const response = await app.inject({
      method: 'DELETE',
      url: `${ROUTE_PATH}/${issueId}`,
    });
    expect(response.statusCode).toBe(202);

    await waitFor(() => hasEvent(sse, 'issue_deleted', issueId));

    expect(db.select().from(issues).all()).toHaveLength(0);
    expect(container.removed).toContain(`issue-resolver-${issueId}`);
    expect(phasesOf(sse, issueId)).toEqual([
      'stopping_processes',
      'removing_db_record',
      'removing_container',
      'removing_workspace',
    ]);
  });

  it('неожиданная ошибка (не-Error) → phase error с String(error)', async () => {
    const db = createDb(':memory:');
    const container = new SpyContainerController();
    const sse = new RecordingSseHub();
    const workspaceRoot = await makeRoot();
    const app = makeApp(db, container, workspaceRoot, sse);
    const issueId = seedIssue(db);

    const issueDir = join(workspaceRoot, issueId);
    mkdirSync(issueDir, { recursive: true });

    const deleteSpy = vi.spyOn(db, 'delete').mockImplementation(() => {
      throw 'boom';
    });

    const response = await app.inject({
      method: 'DELETE',
      url: `${ROUTE_PATH}/${issueId}`,
    });
    expect(response.statusCode).toBe(202);

    await waitFor(() => phasesOf(sse, issueId).includes('error'));

    const errorEvent = sse.events.find(
      (event) =>
        event.type === 'issue_deleting' &&
        event.issueId === issueId &&
        (JSON.parse(event.data) as { phase: string }).phase === 'error',
    );
    expect(JSON.parse(errorEvent!.data)).toMatchObject({
      phase: 'error',
      message: 'boom',
    });
    expect(existsSync(issueDir)).toBe(true);
    expect(container.removed).toEqual([]);

    deleteSpy.mockRestore();
  });

  it('202 возвращается сразу, удаление идёт в фоне', async () => {
    const db = createDb(':memory:');
    const container = new SpyContainerController();
    const sse = new RecordingSseHub();
    const workspaceRoot = await makeRoot();
    const app = makeApp(db, container, workspaceRoot, sse);
    const issueId = seedIssue(db);

    const issueDir = join(workspaceRoot, issueId);
    mkdirSync(issueDir, { recursive: true });

    const response = await app.inject({
      method: 'DELETE',
      url: `${ROUTE_PATH}/${issueId}`,
    });
    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({ ok: true });

    expect(hasEvent(sse, 'issue_deleted', issueId)).toBe(false);

    await waitFor(() => hasEvent(sse, 'issue_deleted', issueId));
    expect(db.select().from(issues).all()).toHaveLength(0);
  });

  it('SSE-фазы идут в порядке db → container → workspace', async () => {
    const db = createDb(':memory:');
    const container = new SpyContainerController();
    const sse = new RecordingSseHub();
    const workspaceRoot = await makeRoot();
    const app = makeApp(db, container, workspaceRoot, sse);
    const issueId = seedIssue(db);

    const issueDir = join(workspaceRoot, issueId);
    mkdirSync(issueDir, { recursive: true });

    await app.inject({
      method: 'DELETE',
      url: `${ROUTE_PATH}/${issueId}`,
    });

    await waitFor(() => hasEvent(sse, 'issue_deleted', issueId));

    expect(phasesOf(sse, issueId)).toEqual([
      'stopping_processes',
      'removing_db_record',
      'removing_container',
      'removing_workspace',
    ]);
  });
});