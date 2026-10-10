import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  ContainerSpec,
  SpawnContainerResult,
} from '@issue-resolver/shared';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
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

const ROUTE_PATH = '/issue-resolver/api/v1/issues';

/** ContainerController-шпион: пишет spawn/remove, реальный Docker не трогает. */
class SpyContainerController implements ContainerController {
  readonly spawned: string[] = [];
  readonly removed: string[] = [];

  async spawn(spec: ContainerSpec): Promise<SpawnContainerResult> {
    this.spawned.push(spec.containerName);
    return {
      containerId: `cid-${spec.containerName}`,
      containerName: spec.containerName,
      workspacePath: spec.workspaceHostPath,
    };
  }

  async remove(containerName: string): Promise<void> {
    this.removed.push(containerName);
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
): ReturnType<typeof buildApp> {
  const app = buildApp(db, { container, workspaceRoot });
  openApps.push(app);
  return app;
}

/** Ждёт, пока предикат станет истинным (фоновый прогон после POST). */
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

const REPOSITORIES = [
  { repository_url: 'https://github.com/acme/app.git', base_branch: 'main' },
];

describe('DELETE /issues/:id — полная зачистка', () => {
  it('удаление чистит БД-каскад + папку + контейнер', async () => {
    const db = createDb(':memory:');
    const container = new SpyContainerController();
    const workspaceRoot = await makeRoot();
    const app = makeApp(db, container, workspaceRoot);

    const created = await app.inject({
      method: 'POST',
      url: ROUTE_PATH,
      payload: { title: 'Задача на удаление', repositories: REPOSITORIES },
    });
    expect(created.statusCode).toBe(201);
    const issueId = created.json().id as string;

    // Дожидаемся завершения фонового прогона, чтобы DELETE не гонялся с ним.
    await waitFor(async () => {
      const fetched = await app.inject({
        method: 'GET',
        url: `${ROUTE_PATH}/${issueId}`,
      });
      return ['completed', 'failed'].includes(fetched.json().status);
    });

    // Дополнительный step_run + step_output для итерации (прямой insert).
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

    // Реальная рабочая подпапка задачи с файлом внутри.
    const issueDir = join(workspaceRoot, issueId);
    mkdirSync(issueDir, { recursive: true });
    writeFileSync(join(issueDir, 'work.txt'), 'artifact');

    const response = await app.inject({
      method: 'DELETE',
      url: `${ROUTE_PATH}/${issueId}`,
    });
    expect(response.statusCode).toBe(204);

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