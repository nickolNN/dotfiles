import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import type { Db } from '../src/db/client';
import { createDb } from '../src/db/client';
import {
  listAnsweredQuestionIds,
  recordQuestionAnswer,
} from '../src/db/question-answers.repo';
import { questionAnswers } from '../src/db/schema';
import { issues, iterations } from '../src/db/schema';
import { InMemoryStepSessionRegistry } from '../src/pi/session-registry';

const ITERATIONS_PATH = '/issue-resolver/api/v1/iterations';

const openApps: Array<{ close: () => Promise<void> }> = [];
afterEach(async () => {
  await Promise.all(openApps.splice(0).map((app) => app.close()));
});

/** Прямой insert issue + iteration #1 (в обход фонового прогона). */
function seedIteration(db: Db): string {
  const now = new Date().toISOString();
  const issueId = randomUUID();
  const iterationId = randomUUID();

  db.insert(issues)
    .values({
      id: issueId,
      title: 'Задача с вопросами',
      jira_issue_url: null,
      pipeline_steps: ['refine'],
      container_name: null,
      status: 'pending',
      created_at: now,
      updated_at: now,
    })
    .run();

  db.insert(iterations)
    .values({
      id: iterationId,
      issue_id: issueId,
      number: 1,
      context: '',
      steps: ['refine'],
      status: 'running',
      created_at: now,
      updated_at: now,
    })
    .run();

  return iterationId;
}

describe('recordQuestionAnswer / listAnsweredQuestionIds', () => {
  it('сохраняет ответ и возвращает его id в списке', async () => {
    const db = createDb(':memory:');
    const iterationId = seedIteration(db);

    await recordQuestionAnswer(db, {
      iterationId,
      questionId: 'q1',
      value: 'вариант A',
    });

    expect(await listAnsweredQuestionIds(db, iterationId)).toEqual(['q1']);
  });

  it('повторный ответ идемпотентен: одна строка, без throw', async () => {
    const db = createDb(':memory:');
    const iterationId = seedIteration(db);

    await recordQuestionAnswer(db, {
      iterationId,
      questionId: 'q1',
      value: 'A',
    });
    await recordQuestionAnswer(db, {
      iterationId,
      questionId: 'q1',
      value: 'B',
    });

    const rows = db
      .select()
      .from(questionAnswers)
      .all()
      .filter((row) => row.iteration_id === iterationId);
    expect(rows).toHaveLength(1);
    expect(await listAnsweredQuestionIds(db, iterationId)).toEqual(['q1']);
  });

  it('cancelled-ответ тоже считается отвеченным', async () => {
    const db = createDb(':memory:');
    const iterationId = seedIteration(db);

    await recordQuestionAnswer(db, {
      iterationId,
      questionId: 'q-cancel',
      cancelled: true,
    });

    expect(await listAnsweredQuestionIds(db, iterationId)).toEqual(['q-cancel']);
  });

  it('ответы соседних итераций не смешиваются', async () => {
    const db = createDb(':memory:');
    const first = seedIteration(db);
    const second = seedIteration(db);

    await recordQuestionAnswer(db, { iterationId: first, questionId: 'a' });
    await recordQuestionAnswer(db, { iterationId: second, questionId: 'b' });

    expect(await listAnsweredQuestionIds(db, first)).toEqual(['a']);
    expect(await listAnsweredQuestionIds(db, second)).toEqual(['b']);
  });
});

describe('POST /iterations/:id/ui-response (персистентность)', () => {
  it('нет живой сессии → всё равно 200 {ok:true} и ответ сохранён', async () => {
    const db = createDb(':memory:');
    const iterationId = seedIteration(db);
    const control = new InMemoryStepSessionRegistry();
    const app = buildApp(db, { control });
    openApps.push(app);

    const response = await app.inject({
      method: 'POST',
      url: `${ITERATIONS_PATH}/${iterationId}/ui-response`,
      payload: { id: 'q1', value: 'да' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true });
    expect(await listAnsweredQuestionIds(db, iterationId)).toEqual(['q1']);
  });

  it('повторный POST того же вопроса не дублирует строку', async () => {
    const db = createDb(':memory:');
    const iterationId = seedIteration(db);
    const app = buildApp(db, { control: new InMemoryStepSessionRegistry() });
    openApps.push(app);

    await app.inject({
      method: 'POST',
      url: `${ITERATIONS_PATH}/${iterationId}/ui-response`,
      payload: { id: 'q1', value: 'A' },
    });
    const again = await app.inject({
      method: 'POST',
      url: `${ITERATIONS_PATH}/${iterationId}/ui-response`,
      payload: { id: 'q1', confirmed: true },
    });

    expect(again.statusCode).toBe(200);
    expect(await listAnsweredQuestionIds(db, iterationId)).toEqual(['q1']);
  });

  it('валидный ответ + активная сессия → forward в control', async () => {
    const db = createDb(':memory:');
    const iterationId = seedIteration(db);
    const control = new InMemoryStepSessionRegistry();
    const responses: unknown[] = [];
    control.register('run-1', iterationId, {
      steer: () => undefined,
      abort: () => undefined,
      respond: (payload) => responses.push(payload),
      prompt: () => Promise.resolve({ ok: true, disposition: 'started' }),
      send: () => Promise.resolve({ ok: true }),
    });
    const app = buildApp(db, { control });
    openApps.push(app);

    const response = await app.inject({
      method: 'POST',
      url: `${ITERATIONS_PATH}/${iterationId}/ui-response`,
      payload: { id: 'q1', confirmed: true },
    });

    expect(response.statusCode).toBe(200);
    expect(responses).toEqual([{ id: 'q1', confirmed: true }]);
  });

  it('неизвестная итерация → всё равно 200 {ok:true} (не 500 из-за FK)', async () => {
    const app = buildApp(createDb(':memory:'), {
      control: new InMemoryStepSessionRegistry(),
    });
    openApps.push(app);

    const response = await app.inject({
      method: 'POST',
      url: `${ITERATIONS_PATH}/${randomUUID()}/ui-response`,
      payload: { id: 'q1', value: 'x' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true });
  });

  it('нет id или нет ответа → 400', async () => {
    const app = buildApp(createDb(':memory:'), {
      control: new InMemoryStepSessionRegistry(),
    });
    openApps.push(app);

    const noId = await app.inject({
      method: 'POST',
      url: `${ITERATIONS_PATH}/it1/ui-response`,
      payload: { value: 'x' },
    });
    expect(noId.statusCode).toBe(400);

    const noAnswer = await app.inject({
      method: 'POST',
      url: `${ITERATIONS_PATH}/it1/ui-response`,
      payload: { id: 'q1' },
    });
    expect(noAnswer.statusCode).toBe(400);
  });
});

describe('GET /iterations/:id/question-answers', () => {
  it('200: answered_ids содержит сохранённые вопросы', async () => {
    const db = createDb(':memory:');
    const iterationId = seedIteration(db);
    await recordQuestionAnswer(db, {
      iterationId,
      questionId: 'q1',
      value: 'A',
    });
    await recordQuestionAnswer(db, {
      iterationId,
      questionId: 'q2',
      cancelled: true,
    });
    const app = buildApp(db);
    openApps.push(app);

    const response = await app.inject({
      method: 'GET',
      url: `${ITERATIONS_PATH}/${iterationId}/question-answers`,
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as { answered_ids: string[] };
    expect(body.answered_ids.sort()).toEqual(['q1', 'q2']);
  });

  it('нет ответов → 200 {answered_ids: []}', async () => {
    const db = createDb(':memory:');
    const iterationId = seedIteration(db);
    const app = buildApp(db);
    openApps.push(app);

    const response = await app.inject({
      method: 'GET',
      url: `${ITERATIONS_PATH}/${iterationId}/question-answers`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ answered_ids: [] });
  });

  it('неизвестная итерация → 404 {error: iteration not found}', async () => {
    const app = buildApp(createDb(':memory:'));
    openApps.push(app);

    const response = await app.inject({
      method: 'GET',
      url: `${ITERATIONS_PATH}/${randomUUID()}/question-answers`,
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: 'iteration not found' });
  });
});