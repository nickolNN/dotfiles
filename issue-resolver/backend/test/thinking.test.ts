import { randomUUID } from 'node:crypto';
import type { PipelineStep } from '@issue-resolver/shared';
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

describe('thinking_level — персистентность', () => {
  it('POST /issues: thinking_level/step_thinking_levels в issue и iteration#1', async () => {
    const { app } = makeApp();
    const stepLevels = { resolve: 'low', review: 'xhigh' };

    const created = await app.inject({
      method: 'POST',
      url: ENDPOINT,
      payload: {
        title: 'T',
        repositories: REPOSITORIES,
        thinking_level: 'high',
        step_thinking_levels: stepLevels,
      },
    });
    expect(created.statusCode).toBe(201);
    const issueId = created.json().id as string;
    // Ответ создания отдаёт оба поля.
    expect(created.json().thinking_level).toBe('high');
    expect(created.json().step_thinking_levels).toEqual(stepLevels);

    // GET /:id — issue-level поля.
    const detail = await app.inject({
      method: 'GET',
      url: `${ENDPOINT}/${issueId}`,
    });
    expect(detail.json().thinking_level).toBe('high');
    expect(detail.json().step_thinking_levels).toEqual(stepLevels);

    // GET /:id/iterations — iteration#1 (та же итерация создаётся сразу).
    const list = await app.inject({
      method: 'GET',
      url: `${ENDPOINT}/${issueId}/iterations`,
    });
    expect(list.json()[0].thinking_level).toBe('high');
    expect(list.json()[0].step_thinking_levels).toEqual(stepLevels);
  });

  it('POST /issues без thinking → null/undefined', async () => {
    const { app } = makeApp();

    const created = await app.inject({
      method: 'POST',
      url: ENDPOINT,
      payload: { title: 'T', repositories: REPOSITORIES },
    });
    const issueId = created.json().id as string;
    expect(created.json().thinking_level).toBeNull();
    expect(created.json().step_thinking_levels).toBeUndefined();

    const list = await app.inject({
      method: 'GET',
      url: `${ENDPOINT}/${issueId}/iterations`,
    });
    expect(list.json()[0].thinking_level).toBeNull();
    expect(list.json()[0].step_thinking_levels).toBeUndefined();
  });

  it('POST /issues/:id/iterations: thinking сохраняется в новой итерации', async () => {
    const { app } = makeApp();

    const created = await app.inject({
      method: 'POST',
      url: ENDPOINT,
      payload: { title: 'T', repositories: REPOSITORIES },
    });
    const issueId = created.json().id as string;

    const second = await app.inject({
      method: 'POST',
      url: `${ENDPOINT}/${issueId}/iterations`,
      payload: {
        context: 'x',
        thinking_level: 'minimal',
        step_thinking_levels: { pr: 'max' },
      },
    });

    expect(second.statusCode).toBe(201);
    expect(second.json().thinking_level).toBe('minimal');
    expect(second.json().step_thinking_levels).toEqual({ pr: 'max' });

    const list = await app.inject({
      method: 'GET',
      url: `${ENDPOINT}/${issueId}/iterations`,
    });
    expect(list.json()[1].thinking_level).toBe('minimal');
    expect(list.json()[1].step_thinking_levels).toEqual({ pr: 'max' });
  });
});

describe('thinking_level — валидация', () => {
  it('валидный thinking_level → 201', async () => {
    const { app } = makeApp();
    const response = await app.inject({
      method: 'POST',
      url: ENDPOINT,
      payload: { title: 'T', repositories: [], thinking_level: 'max' },
    });
    expect(response.statusCode).toBe(201);
  });

  it('невалидный thinking_level → 400', async () => {
    const { app } = makeApp();
    const response = await app.inject({
      method: 'POST',
      url: ENDPOINT,
      payload: { title: 'T', repositories: [], thinking_level: 'nope' },
    });
    expect(response.statusCode).toBe(400);
    expect(typeof response.json().error).toBe('string');
  });

  it('step_thinking_levels с невалидным ключом шага → 400', async () => {
    const { app } = makeApp();
    const response = await app.inject({
      method: 'POST',
      url: ENDPOINT,
      payload: {
        title: 'T',
        repositories: [],
        step_thinking_levels: { bogus: 'high' },
      },
    });
    expect(response.statusCode).toBe(400);
  });

  it('step_thinking_levels с невалидным уровнем → 400', async () => {
    const { app } = makeApp();
    const response = await app.inject({
      method: 'POST',
      url: ENDPOINT,
      payload: {
        title: 'T',
        repositories: [],
        step_thinking_levels: { resolve: 'nope' },
      },
    });
    expect(response.statusCode).toBe(400);
  });

  it('POST /issues/:id/iterations: невалидный thinking_level → 400', async () => {
    const { app } = makeApp();
    const created = await app.inject({
      method: 'POST',
      url: ENDPOINT,
      payload: { title: 'T', repositories: [] },
    });
    const issueId = created.json().id as string;

    const bad = await app.inject({
      method: 'POST',
      url: `${ENDPOINT}/${issueId}/iterations`,
      payload: { context: 'x', thinking_level: 'nope' },
    });
    expect(bad.statusCode).toBe(400);
  });
});

describe('thinking_level — runIssueIteration → pi.run', () => {
  it('step_thinking_levels[step] переопределяет общий thinking_level', async () => {
    const db = createDb(':memory:');
    const issueId = randomUUID();
    const iterationId = randomUUID();
    const steps: PipelineStep[] = ['resolve', 'review'];

    db.insert(issues)
      .values({
        id: issueId,
        title: 'Уровни размышления',
        jira_issue_url: null,
        pipeline_steps: steps,
        container_name: null,
        status: 'pending',
        created_at: NOW,
        updated_at: NOW,
      })
      .run();
    db.insert(iterations)
      .values({
        id: iterationId,
        issue_id: issueId,
        number: 1,
        context: 'ctx',
        steps,
        status: 'pending',
        created_at: NOW,
        updated_at: NOW,
      })
      .run();

    const pi = new FakePiRunner();
    const result = await runIssueIteration(
      db,
      {
        container: new FakeContainerController(),
        git: new FakeGitService(),
        pi,
        sse: new InMemorySseHub(),
        mr: new FakeMrClient(),
        control: new InMemoryStepSessionRegistry(),
      },
      {
        issue: {
          id: issueId,
          title: 'Уровни размышления',
          pipelineSteps: steps,
        },
        iteration: {
          id: iterationId,
          issueId,
          number: 1,
          context: 'ctx',
          steps,
        },
        repositories: REPOSITORIES,
        thinking_level: 'medium',
        step_thinking_levels: { review: 'high' },
      },
    );

    expect(result).toEqual({ iterationStatus: 'completed', needsInput: false });
    expect(pi.calls.map((call) => call.options?.thinkingLevel)).toEqual([
      'medium',
      'high',
    ]);
  });

  it('без thinking → thinkingLevel undefined', async () => {
    const db = createDb(':memory:');
    const issueId = randomUUID();
    const iterationId = randomUUID();
    const steps: PipelineStep[] = ['resolve'];

    db.insert(issues)
      .values({
        id: issueId,
        title: 'Без thinking',
        jira_issue_url: null,
        pipeline_steps: steps,
        container_name: null,
        status: 'pending',
        created_at: NOW,
        updated_at: NOW,
      })
      .run();
    db.insert(iterations)
      .values({
        id: iterationId,
        issue_id: issueId,
        number: 1,
        context: 'ctx',
        steps,
        status: 'pending',
        created_at: NOW,
        updated_at: NOW,
      })
      .run();

    const pi = new FakePiRunner();
    await runIssueIteration(
      db,
      {
        container: new FakeContainerController(),
        git: new FakeGitService(),
        pi,
        sse: new InMemorySseHub(),
        mr: new FakeMrClient(),
        control: new InMemoryStepSessionRegistry(),
      },
      {
        issue: { id: issueId, title: 'Без thinking', pipelineSteps: steps },
        iteration: {
          id: iterationId,
          issueId,
          number: 1,
          context: 'ctx',
          steps,
        },
        repositories: REPOSITORIES,
      },
    );

    expect(pi.calls[0].options?.thinkingLevel).toBeUndefined();
  });
});