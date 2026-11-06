import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { TaskStatus } from '@issue-resolver/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IterationRunDeps } from '../src/workflow/service-contracts';
import { createDb, type Db } from '../src/db/client';
import { issues } from '../src/db/schema';
import { FakeContainerController } from '../src/docker/controller';
import { FakeGitService } from '../src/git/service';
import { FakePiRunner } from '../src/pi/runner';
import { InMemoryStepSessionRegistry } from '../src/pi/session-registry';
import { FakeMrClient } from '../src/pr/mr';
import { InMemorySseHub } from '../src/sse/hub';

const mocks = vi.hoisted(() => ({
  prepareIssueWorkspace: vi.fn(),
  runIssueIteration: vi.fn(),
}));

vi.mock('../src/workflow/prepare-issue-workspace', () => ({
  prepareIssueWorkspace: mocks.prepareIssueWorkspace,
}));
vi.mock('../src/workflow/run-issue-iteration', () => ({
  runIssueIteration: mocks.runIssueIteration,
}));

const { startIteration } = await import('../src/workflow/start-iteration');

const REPO_WORKSPACES = [
  { repoUrl: 'https://example.com/acme/app.git', path: '/w/app', branch: 'main' },
];

let db: Db;
let workspaceRoot: string;

function seedIssue(status: TaskStatus = TaskStatus.draft): string {
  const id = randomUUID();
  const now = new Date().toISOString();
  db.insert(issues)
    .values({
      id,
      title: 'Запуск итерации',
      jira_issue_url: null,
      pipeline_steps: ['resolve'],
      container_name: null,
      status,
      created_at: now,
      updated_at: now,
    })
    .run();
  return id;
}

function issueStatus(id: string): TaskStatus | undefined {
  return db.select().from(issues).where(eq(issues.id, id)).get()?.status;
}

function makeDeps(): IterationRunDeps {
  return {
    container: new FakeContainerController(),
    git: new FakeGitService(),
    mr: new FakeMrClient(),
    pi: new FakePiRunner(),
    sse: new InMemorySseHub(),
    control: new InMemoryStepSessionRegistry(),
    workspaceRoot,
    local: true,
  } as IterationRunDeps;
}

function input(issueId: string, extra: Record<string, unknown> = {}) {
  return {
    issue: {
      id: issueId,
      title: 'Запуск итерации',
      pipelineSteps: ['resolve' as const],
      description: '',
      desiredResult: 'md' as const,
      jiraIssueUrl: null,
    },
    iteration: {
      id: randomUUID(),
      issueId,
      number: 1,
      context: 'ctx',
      steps: ['resolve' as const],
    },
    models: {},
    repositories: [],
    devops: {},
    ...extra,
  };
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
  db = createDb(':memory:');
  workspaceRoot = mkdtempSync(join(tmpdir(), 'start-iteration-'));
  mocks.prepareIssueWorkspace.mockReset();
  mocks.runIssueIteration.mockReset();
  mocks.runIssueIteration.mockResolvedValue(undefined);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(workspaceRoot, { recursive: true, force: true });
});

describe('startIteration — путь ошибки подготовки', () => {
  it('с markIssueFailedOnPrepareError переводит issue в failed', async () => {
    const issueId = seedIssue(TaskStatus.running);
    mocks.prepareIssueWorkspace.mockRejectedValue(new Error('container refused'));

    startIteration(
      db,
      makeDeps(),
      input(issueId, { markIssueFailedOnPrepareError: true }),
    );
    await flush();

    expect(issueStatus(issueId)).toBe(TaskStatus.failed);
    expect(mocks.runIssueIteration).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith(
      'preparation failed',
      expect.objectContaining({ issueId }),
    );
    expect(console.error).toHaveBeenCalledWith(
      'issue marked failed after prepare error',
      issueId,
    );
  });

  it('без флага статус issue не меняется', async () => {
    const issueId = seedIssue(TaskStatus.running);
    mocks.prepareIssueWorkspace.mockRejectedValue(new Error('container refused'));

    startIteration(db, makeDeps(), input(issueId));
    await flush();

    expect(issueStatus(issueId)).toBe(TaskStatus.running);
    expect(mocks.runIssueIteration).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith(
      'preparation failed',
      expect.objectContaining({ issueId }),
    );
    expect(console.error).not.toHaveBeenCalledWith(
      'issue marked failed after prepare error',
      expect.anything(),
    );
  });

  it('ошибка подготовки не всплывает наружу и не мешает следующему запуску', async () => {
    const issueId = seedIssue(TaskStatus.running);
    mocks.prepareIssueWorkspace.mockRejectedValueOnce(new Error('boom'));

    expect(() =>
      startIteration(db, makeDeps(), input(issueId, { markIssueFailedOnPrepareError: true })),
    ).not.toThrow();
    await flush();
    expect(issueStatus(issueId)).toBe(TaskStatus.failed);

    mocks.prepareIssueWorkspace.mockResolvedValueOnce(REPO_WORKSPACES);
    startIteration(db, makeDeps(), input(issueId));
    await flush();
    expect(mocks.runIssueIteration).toHaveBeenCalledTimes(1);
  });
});

describe('startIteration — успешная подготовка', () => {
  it('запускает итерацию с тем же workspace и моделями', async () => {
    const issueId = seedIssue(TaskStatus.running);
    mocks.prepareIssueWorkspace.mockResolvedValue(REPO_WORKSPACES);
    const payload = input(issueId, {
      models: { model: 'model-1', thinking_level: 'high' },
    });

    startIteration(db, makeDeps(), payload);
    await flush();

    expect(issueStatus(issueId)).toBe(TaskStatus.running);
    expect(mocks.prepareIssueWorkspace).toHaveBeenCalledTimes(1);
    expect(mocks.prepareIssueWorkspace).toHaveBeenCalledWith(
      db,
      expect.objectContaining({ workspaceRoot }),
      {
        issueId,
        iterationId: payload.iteration.id,
        repositories: [],
      },
    );
    expect(mocks.runIssueIteration).toHaveBeenCalledTimes(1);
    expect(mocks.runIssueIteration).toHaveBeenCalledWith(
      db,
      expect.anything(),
      expect.objectContaining({
        issue: expect.objectContaining({ id: issueId }),
        iteration: payload.iteration,
        repoWorkspaces: REPO_WORKSPACES,
        model: 'model-1',
        thinking_level: 'high',
      }),
    );
  });

  it('вызывает beforePrepare до подготовки', async () => {
    const issueId = seedIssue(TaskStatus.running);
    mocks.prepareIssueWorkspace.mockResolvedValue(REPO_WORKSPACES);
    const order: string[] = [];
    mocks.prepareIssueWorkspace.mockImplementation(async () => {
      order.push('prepare');
      return REPO_WORKSPACES;
    });

    startIteration(
      db,
      makeDeps(),
      input(issueId, { beforePrepare: () => order.push('before') }),
    );
    await flush();

    expect(order).toEqual(['before', 'prepare']);
  });
});