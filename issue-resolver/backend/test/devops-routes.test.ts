import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SessionEvent, SSEEvent } from '@issue-resolver/shared';
import { SessionAddress } from '@issue-resolver/shared';
import { afterEach, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/client';
import { createDb } from '../src/db/client';
import { issueRepositories, issues, repositories } from '../src/db/schema';
import { FakeContainerController } from '../src/docker/controller';
import { FakeGitService } from '../src/git/service';
import { FakePiRunner } from '../src/pi/runner';
import { InMemoryStepSessionRegistry } from '../src/pi/session-registry';
import { FakeMrClient } from '../src/pr/mr';
import { InMemorySseHub } from '../src/sse/hub';
import type { SseHub } from '../src/sse/hub';
import type { DevOpsAgent, DevOpsResult } from '../src/workflow/devops';
import type { DevOpsFactory } from '../src/workflow/engine';
import { buildApp } from '../src/app';

const ENDPOINT = '/issue-resolver/api/v1/issues';
const REPO_URL = 'https://example.com/acme/app.git';
const NOW = '2026-06-01T00:00:00.000Z';

const openApps: Array<{ close: () => Promise<void> }> = [];
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(openApps.splice(0).map((app) => app.close()));
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'ir-devops-routes-'));
  roots.push(root);
  return root;
}

function seedIssue(db: Db, repoName = 'app'): string {
  const issueId = randomUUID();
  db.insert(issues)
    .values({
      id: issueId,
      title: 'DevOps routes',
      jira_issue_url: null,
      pipeline_steps: ['resolve'],
      container_name: null,
      status: 'pending',
      created_at: NOW,
      updated_at: NOW,
    })
    .run();
  db.insert(repositories)
    .values({
      id: randomUUID(),
      url: REPO_URL,
      full_name: `acme/${repoName}`,
      created_at: NOW,
      updated_at: NOW,
    })
    .run();
  db.insert(issueRepositories)
    .values({
      id: randomUUID(),
      issue_id: issueId,
      repository_url: REPO_URL,
      branch_name: 'main',
      create_mr: false,
      bootstrap_enabled: true,
      created_at: NOW,
      updated_at: NOW,
    })
    .run();
  return issueId;
}

function makeClone(root: string, issueId: string, repoName = 'app'): void {
  mkdirSync(join(root, issueId, repoName, '.git'), { recursive: true });
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

function factoryReturning(
  result: DevOpsResult,
  events: SessionEvent[] = [],
): DevOpsFactory {
  return (params) => {
    const agent: DevOpsAgent = {
      async runDevOps() {
        params.onStdout?.('devops stdout');
        for (const event of events) params.onEvent?.(event);
        return result;
      },
    };
    return agent;
  };
}

function makeApp(
  db: Db,
  overrides: { devopsFactory?: DevOpsFactory; sse?: SseHub; workspaceRoot: string },
) {
  const app = buildApp(db, {
    container: new FakeContainerController(),
    git: new FakeGitService(),
    pi: new FakePiRunner(),
    mr: new FakeMrClient(),
    control: new InMemoryStepSessionRegistry(),
    local: true,
    ...overrides,
  });
  openApps.push(app);
  return app;
}

async function waitFor(
  probe: () => Promise<boolean> | boolean,
  attempts = 50,
): Promise<void> {
  for (let index = 0; index < attempts; index += 1) {
    if (await probe()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('условие не наступило за отведённое время');
}

describe('POST /issues/:id/devops', () => {
  it('202: прогон стартует и доходит до success', async () => {
    const db = createDb(':memory:');
    const root = tempRoot();
    const issueId = seedIssue(db);
    makeClone(root, issueId);
    const app = makeApp(db, {
      workspaceRoot: root,
      devopsFactory: factoryReturning({
        success: true,
        instructions: '# Run',
        stats: null,
      }),
    });

    const response = await app.inject({
      method: 'POST',
      url: `${ENDPOINT}/${issueId}/devops`,
    });
    expect(response.statusCode).toBe(202);
    expect(response.json()).toMatchObject({ ok: true });

    const status = await waitForStatus(app, issueId, 'success');
    expect(status.status).toBe('success');
    expect(status.runId).toBeTruthy();
  });

  it('404: чужая задача', async () => {
    const db = createDb(':memory:');
    const root = tempRoot();
    const app = makeApp(db, {
      workspaceRoot: root,
      devopsFactory: factoryReturning({ success: true, instructions: 'x' }),
    });

    const response = await app.inject({
      method: 'POST',
      url: `${ENDPOINT}/${randomUUID()}/devops`,
    });
    expect(response.statusCode).toBe(404);
  });

  it('400: devops-агент не настроен', async () => {
    const db = createDb(':memory:');
    const root = tempRoot();
    const issueId = seedIssue(db);
    const app = makeApp(db, { workspaceRoot: root });

    const response = await app.inject({
      method: 'POST',
      url: `${ENDPOINT}/${issueId}/devops`,
    });
    expect(response.statusCode).toBe(400);
  });

  it('409: второй прогон, пока первый активен', async () => {
    const db = createDb(':memory:');
    const root = tempRoot();
    const issueId = seedIssue(db);
    makeClone(root, issueId);
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const factory: DevOpsFactory = () => ({
      async runDevOps() {
        await gate;
        return { success: true, instructions: 'x', stats: null };
      },
    });
    const app = makeApp(db, { workspaceRoot: root, devopsFactory: factory });

    const first = await app.inject({
      method: 'POST',
      url: `${ENDPOINT}/${issueId}/devops`,
    });
    expect(first.statusCode).toBe(202);
    await waitFor(async () => {
      const running = await app.inject({
        method: 'GET',
        url: `${ENDPOINT}/${issueId}/devops/status`,
      });
      return running.json().status === 'running';
    });

    const second = await app.inject({
      method: 'POST',
      url: `${ENDPOINT}/${issueId}/devops`,
    });
    expect(second.statusCode).toBe(409);

    release();
    await waitForStatus(app, issueId, 'success');
  });

  it('failed: прогон с ошибкой отражается в статусе и feedback', async () => {
    const db = createDb(':memory:');
    const root = tempRoot();
    const issueId = seedIssue(db);
    makeClone(root, issueId);
    const app = makeApp(db, {
      workspaceRoot: root,
      devopsFactory: factoryReturning({
        success: false,
        instructions: null,
        error: 'сборка не найдена',
        stats: null,
      }),
    });

    await app.inject({ method: 'POST', url: `${ENDPOINT}/${issueId}/devops` });
    const status = await waitForStatus(app, issueId, 'failed');
    expect(status.status).toBe('failed');
    expect(status.feedback).toContain('сборка не найдена');
  });
});

describe('GET /issues/:id/devops/status', () => {
  it('idle: прогонов не было', async () => {
    const db = createDb(':memory:');
    const root = tempRoot();
    const issueId = seedIssue(db);
    const app = makeApp(db, { workspaceRoot: root });

    const response = await app.inject({
      method: 'GET',
      url: `${ENDPOINT}/${issueId}/devops/status`,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'idle' });
  });

  it('404: чужая задача', async () => {
    const db = createDb(':memory:');
    const root = tempRoot();
    const app = makeApp(db, { workspaceRoot: root });

    const response = await app.inject({
      method: 'GET',
      url: `${ENDPOINT}/${randomUUID()}/devops/status`,
    });
    expect(response.statusCode).toBe(404);
  });
});

describe('GET /issues/:id/devops/run', () => {
  it('возвращает последний прогон с логами и событиями', async () => {
    const db = createDb(':memory:');
    const root = tempRoot();
    const issueId = seedIssue(db);
    makeClone(root, issueId);
    const sse = new RecordingSseHub();
    const app = makeApp(db, {
      workspaceRoot: root,
      sse,
      devopsFactory: factoryReturning(
        { success: true, instructions: '# Run', stats: null },
        [{ type: 'text', text: 'готово' }],
      ),
    });

    await app.inject({ method: 'POST', url: `${ENDPOINT}/${issueId}/devops` });
    await waitForStatus(app, issueId, 'success');

    const response = await app.inject({
      method: 'GET',
      url: `${ENDPOINT}/${issueId}/devops/run`,
    });
    expect(response.statusCode).toBe(200);
    const payload = response.json();
    expect(payload.step).toBe('devops');
    expect(payload.stdout).toContain('devops stdout');
    expect(payload.events.map((event: SessionEvent) => event.type)).toContain(
      'text',
    );
  });

  it('404: прогона ещё нет', async () => {
    const db = createDb(':memory:');
    const root = tempRoot();
    const issueId = seedIssue(db);
    const app = makeApp(db, { workspaceRoot: root });

    const response = await app.inject({
      method: 'GET',
      url: `${ENDPOINT}/${issueId}/devops/run`,
    });
    expect(response.statusCode).toBe(404);
  });

  it('сессия стримится SSE с адресом задачи issue.<id>.devops', async () => {
    const db = createDb(':memory:');
    const root = tempRoot();
    const issueId = seedIssue(db);
    makeClone(root, issueId);
    const sse = new RecordingSseHub();
    const app = makeApp(db, {
      workspaceRoot: root,
      sse,
      devopsFactory: factoryReturning(
        { success: true, instructions: '# Run', stats: null },
        [{ type: 'thinking', thinking: 'думаю' }],
      ),
    });

    await app.inject({ method: 'POST', url: `${ENDPOINT}/${issueId}/devops` });
    await waitForStatus(app, issueId, 'success');

    const sessionId = SessionAddress.forIssueRun(issueId, 'devops').toString();
    const stepEvents = sse.events.filter(
      (event) => event.type === 'step_event' && event.stepRunId === sessionId,
    );
    expect(stepEvents.length).toBeGreaterThan(0);
    expect(sse.events.some((event) => event.type === 'log')).toBe(true);
  });
});

type StatusPayload = {
  status: 'idle' | 'running' | 'success' | 'failed';
  runId?: string;
  feedback?: string;
};

async function waitForStatus(
  app: ReturnType<typeof buildApp>,
  issueId: string,
  expected: StatusPayload['status'],
): Promise<StatusPayload> {
  let last: StatusPayload = { status: 'idle' };
  await waitFor(async () => {
    const response = await app.inject({
      method: 'GET',
      url: `${ENDPOINT}/${issueId}/devops/status`,
    });
    last = response.json() as StatusPayload;
    return last.status === expected;
  });
  return last;
}
