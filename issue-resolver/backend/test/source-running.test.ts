import { randomUUID } from 'node:crypto';
import type { Iteration, PipelineStep, SSEEvent } from '@issue-resolver/shared';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import type { Db } from '../src/db/client';
import { createDb } from '../src/db/client';
import { issues, iterations } from '../src/db/schema';
import { FakeContainerController } from '../src/docker/controller';
import { FakeGitService } from '../src/git/service';
import { FakePiRunner } from '../src/pi/runner';
import { InMemoryStepSessionRegistry } from '../src/pi/session-registry';
import { FakeMrClient } from '../src/pr/mr';
import { InMemorySseHub } from '../src/sse/hub';
import { runIssueIteration } from '../src/workflow/run-iteration.service';

const ENDPOINT = '/issue-resolver/api/v1/issues';
const NOW = '2026-06-01T00:00:00.000Z';

const REPOSITORIES = [
  { repository_url: 'https://github.com/acme/app.git', base_branch: 'main' },
];

const openApps: Array<{ close: () => Promise<void> }> = [];

function makeApp(): { app: ReturnType<typeof buildApp>; db: Db } {
  const db = createDb(':memory:');
  const app = buildApp(db);
  openApps.push(app);
  return { app, db };
}

afterEach(async () => {
  await Promise.all(openApps.splice(0).map((app) => app.close()));
});

describe('source-колонка', () => {
  it('jira_issue_url → issue.source === "jira" в GET', async () => {
    const { app } = makeApp();

    const created = await app.inject({
      method: 'POST',
      url: ENDPOINT,
      payload: {
        jira_issue_url: 'https://jira.example.com/browse/KLA-5672',
        repositories: REPOSITORIES,
      },
    });
    expect(created.statusCode).toBe(201);

    const fetched = await app.inject({
      method: 'GET',
      url: `${ENDPOINT}/${created.json().id}`,
    });
    expect(fetched.statusCode).toBe(200);
    expect(fetched.json().source).toBe('jira');
  });

  it('без jira_issue_url → issue.source === null', async () => {
    const { app } = makeApp();

    const created = await app.inject({
      method: 'POST',
      url: ENDPOINT,
      payload: { title: 'Локальная', repositories: REPOSITORIES },
    });

    const fetched = await app.inject({
      method: 'GET',
      url: `${ENDPOINT}/${created.json().id}`,
    });
    expect(fetched.json().source).toBeNull();
  });
});

function seedIteration(
  db: Db,
  steps: PipelineStep[] = ['resolve'],
): { issueId: string; iteration: Iteration } {
  const issueId = randomUUID();
  const iterationId = randomUUID();

  db.insert(issues)
    .values({
      id: issueId,
      title: 'Running-задача',
      jira_issue_url: null,
      pipeline_steps: steps,
      container_name: null,
      status: 'pending',
      created_at: NOW,
      updated_at: NOW,
    })
    .run();

  const iteration: Iteration = {
    id: iterationId,
    issue_id: issueId,
    number: 1,
    context: 'ctx',
    review_context: '',
    is_review_need: false,
    steps,
    status: 'pending',
    created_at: NOW,
    updated_at: NOW,
  };
  db.insert(iterations).values(iteration).run();

  return { issueId, iteration };
}

function makeDeps(): {
  deps: Parameters<typeof runIssueIteration>[1];
  pi: FakePiRunner;
  sse: InMemorySseHub;
} {
  const pi = new FakePiRunner();
  const sse = new InMemorySseHub();
  return {
    pi,
    sse,
    deps: {
      container: new FakeContainerController(),
      git: new FakeGitService(),
      pi,
      sse,
      mr: new FakeMrClient(),
      control: new InMemoryStepSessionRegistry(),
    },
  };
}

const pass = () => ({ step: 'resolve' as const, exitCode: 0, report: { status: 'pass' as const, summary: 'ok' }, stdout: '', stderr: '' });
const fail = () => ({ step: 'resolve' as const, exitCode: 1, report: { status: 'fail' as const, summary: 'no' }, stdout: '', stderr: '' });

describe('runIssueIteration — статус running', () => {
  it('success: iteration_status running до completed; итог completed в БД', async () => {
    const db = createDb(':memory:');
    const { issueId, iteration } = seedIteration(db);
    const { deps, pi, sse } = makeDeps();
    pi.enqueue(pass());

    const events: SSEEvent[] = [];
    sse.subscribe(iteration.id, (event) => events.push(event));

    const result = await runIssueIteration(db, deps, {
      issue: { id: issueId, title: 'Running-задача', pipelineSteps: ['resolve'] },
      iteration: {
        id: iteration.id,
        issueId,
        number: 1,
        context: 'ctx',
        steps: ['resolve'],
      },
      repositories: REPOSITORIES,
    });

    expect(result).toEqual({ iterationStatus: 'completed', needsInput: false });

    const statuses = events
      .filter((event) => event.type === 'iteration_status')
      .map((event) => JSON.parse(event.data).status as string);
    expect(statuses[0]).toBe('running');
    expect(statuses.at(-1)).toBe('completed');
    expect(statuses.indexOf('running')).toBeLessThan(
      statuses.indexOf('completed'),
    );

    expect(
      db.select().from(iterations).where(eq(iterations.id, iteration.id)).get()
        ?.status,
    ).toBe('completed');
    expect(
      db.select().from(issues).where(eq(issues.id, issueId)).get()?.status,
    ).toBe('completed');
  });

  it('fail: итог failed в БД', async () => {
    const db = createDb(':memory:');
    const { issueId, iteration } = seedIteration(db);
    const { deps, pi } = makeDeps();
    pi.enqueue(fail());

    const result = await runIssueIteration(db, deps, {
      issue: { id: issueId, title: 'Running-задача', pipelineSteps: ['resolve'] },
      iteration: {
        id: iteration.id,
        issueId,
        number: 1,
        context: 'ctx',
        steps: ['resolve'],
      },
      repositories: REPOSITORIES,
    });

    expect(result).toEqual({ iterationStatus: 'failed', needsInput: false });
    expect(
      db.select().from(iterations).where(eq(iterations.id, iteration.id)).get()
        ?.status,
    ).toBe('failed');
    expect(
      db.select().from(issues).where(eq(issues.id, issueId)).get()?.status,
    ).toBe('failed');
  });
});