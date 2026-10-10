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

describe('model — POST /issues', () => {
  it('model из тела → iteration#1.model в GET /:id/iterations', async () => {
    const { app } = makeApp();

    const created = await app.inject({
      method: 'POST',
      url: ENDPOINT,
      payload: { title: 'T', repositories: REPOSITORIES, model: 'gpt-test' },
    });
    expect(created.statusCode).toBe(201);
    const issueId = created.json().id as string;

    const list = await app.inject({
      method: 'GET',
      url: `${ENDPOINT}/${issueId}/iterations`,
    });

    expect(list.statusCode).toBe(200);
    const body = list.json();
    expect(body).toHaveLength(1);
    expect(body[0].model).toBe('gpt-test');
  });

  it('model не передан → iteration#1.model === null', async () => {
    const { app } = makeApp();

    const created = await app.inject({
      method: 'POST',
      url: ENDPOINT,
      payload: { title: 'No model', repositories: REPOSITORIES },
    });
    expect(created.statusCode).toBe(201);
    const issueId = created.json().id as string;

    const list = await app.inject({
      method: 'GET',
      url: `${ENDPOINT}/${issueId}/iterations`,
    });

    expect(list.json()[0].model).toBeNull();
  });
});

describe('model — POST /issues/:id/iterations', () => {
  it('model из тела → новая итерация model = other', async () => {
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
      payload: { context: 'x', model: 'other' },
    });

    expect(second.statusCode).toBe(201);
    expect(second.json().model).toBe('other');

    const list = await app.inject({
      method: 'GET',
      url: `${ENDPOINT}/${issueId}/iterations`,
    });
    const iterationsBody = list.json();
    expect(iterationsBody).toHaveLength(2);
    expect(iterationsBody[1].model).toBe('other');
  });
});

describe('model — runIssueIteration → pi.run', () => {
  it('input.model доходит до FakePiRunner.calls[].options.model', async () => {
    const db = createDb(':memory:');
    const issueId = randomUUID();
    const iterationId = randomUUID();
    const steps: PipelineStep[] = ['resolve'];

    db.insert(issues)
      .values({
        id: issueId,
        title: 'Задача с моделью',
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
        issue: { id: issueId, title: 'Задача с моделью', pipelineSteps: steps },
        iteration: {
          id: iterationId,
          issueId,
          number: 1,
          context: 'ctx',
          steps,
        },
        repositories: REPOSITORIES,
        model: 'M',
      },
    );

    expect(result).toEqual({ iterationStatus: 'completed', needsInput: false });
    expect(pi.calls).toHaveLength(1);
    expect(pi.calls[0].options?.model).toBe('M');
  });
});

describe('step_models — персистентность', () => {
  it('POST /issues: step_models сохраняется в issue и iteration#1', async () => {
    const { app } = makeApp();
    const stepModels = { resolve: 'm-resolve', review: 'm-review' };

    const created = await app.inject({
      method: 'POST',
      url: ENDPOINT,
      payload: { title: 'T', repositories: REPOSITORIES, step_models: stepModels },
    });
    expect(created.statusCode).toBe(201);
    const issueId = created.json().id as string;
    expect(created.json().step_models).toEqual(stepModels);

    const detail = await app.inject({ method: 'GET', url: `${ENDPOINT}/${issueId}` });
    expect(detail.json().step_models).toEqual(stepModels);

    const list = await app.inject({
      method: 'GET',
      url: `${ENDPOINT}/${issueId}/iterations`,
    });
    expect(list.json()[0].step_models).toEqual(stepModels);
  });

  it('POST /issues без step_models → в итерации #1 поле отсутствует', async () => {
    const { app } = makeApp();

    const created = await app.inject({
      method: 'POST',
      url: ENDPOINT,
      payload: { title: 'T', repositories: REPOSITORIES },
    });
    const issueId = created.json().id as string;

    const list = await app.inject({
      method: 'GET',
      url: `${ENDPOINT}/${issueId}/iterations`,
    });
    expect(list.json()[0].step_models).toBeUndefined();
  });

  it('POST /issues/:id/iterations: step_models сохраняется', async () => {
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
      payload: { context: 'x', step_models: { pr: 'm-pr' } },
    });

    expect(second.statusCode).toBe(201);
    expect(second.json().step_models).toEqual({ pr: 'm-pr' });

    const list = await app.inject({
      method: 'GET',
      url: `${ENDPOINT}/${issueId}/iterations`,
    });
    expect(list.json()[1].step_models).toEqual({ pr: 'm-pr' });
  });

  it('POST /issues/:id/iterations: невалидный ключ step_models → 400', async () => {
    const { app } = makeApp();

    const created = await app.inject({
      method: 'POST',
      url: ENDPOINT,
      payload: { title: 'T', repositories: REPOSITORIES },
    });
    const issueId = created.json().id as string;

    const bad = await app.inject({
      method: 'POST',
      url: `${ENDPOINT}/${issueId}/iterations`,
      payload: { context: 'x', step_models: { bogus: 'm' } },
    });

    expect(bad.statusCode).toBe(400);
  });
});

describe('step_models — runIssueIteration → pi.run', () => {
  it('каждый шаг получает свою модель, остальные — фолбек model', async () => {
    const db = createDb(':memory:');
    const issueId = randomUUID();
    const iterationId = randomUUID();
    const steps: PipelineStep[] = ['resolve', 'review'];

    db.insert(issues)
      .values({
        id: issueId,
        title: 'Пер-шаговые модели',
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
        issue: { id: issueId, title: 'Пер-шаговые модели', pipelineSteps: steps },
        iteration: {
          id: iterationId,
          issueId,
          number: 1,
          context: 'ctx',
          steps,
        },
        repositories: REPOSITORIES,
        model: 'fallback',
        step_models: { review: 'review-only' },
      },
    );

    expect(result).toEqual({ iterationStatus: 'completed', needsInput: false });
    expect(pi.calls.map((call) => call.options?.model)).toEqual([
      'fallback',
      'review-only',
    ]);
  });
});