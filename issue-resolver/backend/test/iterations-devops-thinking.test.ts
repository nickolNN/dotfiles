import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ThinkingLevel } from '@issue-resolver/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { createDb } from '../src/db/client';
import type { Db } from '../src/db/client';
import { iterations } from '../src/db/schema';
import { resetPortAllocator } from '../src/port-allocator';
import type { DevOpsFactory } from '../src/workflow/engine';

const ISSUES = '/issue-resolver/api/v1/issues';
const ITERATIONS = '/issue-resolver/api/v1/iterations';

const REPOSITORIES = [
  { repository_url: 'https://github.com/acme/app.git', base_branch: 'main' },
];

interface CapturedDevOpsParams {
  model?: string;
  thinkingLevel?: ThinkingLevel;
}

interface TestEnv {
  db: Db;
  app: ReturnType<typeof buildApp>;
  calls: CapturedDevOpsParams[];
  cleanup: () => Promise<void>;
}

const openCleanups: Array<() => Promise<void>> = [];

function makeEnv(): TestEnv {
  const db = createDb(':memory:');
  const root = mkdtempSync(join(tmpdir(), 'devops-iter-thinking-'));
  const calls: CapturedDevOpsParams[] = [];
  const devopsFactory: DevOpsFactory = (params) => {
    calls.push({ model: params.model, thinkingLevel: params.thinkingLevel });
    return {
      runDevOps: async () => ({ success: true, instructions: 'RUN' }),
    };
  };
  const app = buildApp(db, { devopsFactory, workspaceRoot: root });
  const cleanup = async (): Promise<void> => {
    await app.close();
    rmSync(root, { recursive: true, force: true });
    resetPortAllocator();
  };
  openCleanups.push(cleanup);
  return { db, app, calls, cleanup };
}

afterEach(async () => {
  await Promise.all(openCleanups.splice(0).map((cleanup) => cleanup()));
});

async function waitFor<T>(
  probe: () => T | undefined,
  timeoutMs = 3000,
  stepMs = 10,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = probe();
    if (value !== undefined) return value;
    if (Date.now() > deadline) {
      throw new Error('waitFor: таймаут ожидания условия');
    }
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
}

async function lastDevOpsCall(
  calls: CapturedDevOpsParams[],
): Promise<CapturedDevOpsParams> {
  await waitFor(() => (calls.length > 0 ? calls.length : undefined));
  return calls[calls.length - 1];
}

describe('devops_thinking_level доезжает до DevOps-агента', () => {
  it('POST /issues/:id/iterations передаёт devops_model/devops_thinking_level из тела', async () => {
    const { app, calls } = makeEnv();

    const created = await app.inject({
      method: 'POST',
      url: ISSUES,
      payload: {
        title: 'Итерация с thinking',
        repositories: REPOSITORIES,
        run_immediately: false,
      },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().status).toBe('draft');
    const issueId = created.json().id as string;
    expect(calls).toHaveLength(0);

    const iteration = await app.inject({
      method: 'POST',
      url: `${ISSUES}/${issueId}/iterations`,
      payload: {
        context: 'analyze',
        devops_model: 'opus',
        devops_thinking_level: 'high',
      },
    });
    expect(iteration.statusCode).toBe(201);

    expect(await lastDevOpsCall(calls)).toEqual({
      model: 'opus',
      thinkingLevel: 'high',
    });
  });

  it('POST /iterations/:id/repeat берёт настройки из сохранённой задачи', async () => {
    const { db, app, calls } = makeEnv();

    const created = await app.inject({
      method: 'POST',
      url: ISSUES,
      payload: {
        title: 'Повтор с thinking',
        repositories: REPOSITORIES,
        run_immediately: false,
        devops_model: 'opus',
        devops_thinking_level: 'xhigh',
      },
    });
    expect(created.statusCode).toBe(201);
    const issueId = created.json().id as string;

    const now = new Date().toISOString();
    const sourceId = randomUUID();
    db.insert(iterations)
      .values({
        id: sourceId,
        issue_id: issueId,
        number: 1,
        context: 'исходный',
        steps: ['resolve'],
        status: 'completed',
        created_at: now,
        updated_at: now,
      })
      .run();

    const repeat = await app.inject({
      method: 'POST',
      url: `${ITERATIONS}/${sourceId}/repeat`,
    });
    expect(repeat.statusCode).toBe(201);

    expect(await lastDevOpsCall(calls)).toEqual({
      model: 'opus',
      thinkingLevel: 'xhigh',
    });
  });

  it('POST /issues с run_immediately:true передаёт настройки из тела в первый же прогон', async () => {
    const { app, calls } = makeEnv();

    const created = await app.inject({
      method: 'POST',
      url: ISSUES,
      payload: {
        title: 'Немедленный запуск',
        repositories: REPOSITORIES,
        run_immediately: true,
        devops_model: 'opus',
        devops_thinking_level: 'high',
      },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().status).toBe('pending');

    expect(await lastDevOpsCall(calls)).toEqual({
      model: 'opus',
      thinkingLevel: 'high',
    });
  });
});