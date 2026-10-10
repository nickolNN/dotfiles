import type { PromptMode } from '@issue-resolver/shared';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { createDb } from '../src/db/client';
import { issues, iterations } from '../src/db/schema';
import {
  InMemoryStepSessionRegistry,
  type StepSessionControl,
  type UiResponsePayload,
} from '../src/pi/session-registry';

/** Прямой insert issue + iteration с заданным id (FK для question_answers). */
function seedIteration(db: ReturnType<typeof createDb>, id: string): void {
  const now = new Date().toISOString();
  db.insert(issues)
    .values({
      id: `issue-${id}`,
      title: 'ctx',
      jira_issue_url: null,
      pipeline_steps: ['refine'],
      container_name: null,
      status: 'running',
      created_at: now,
      updated_at: now,
    })
    .run();
  db.insert(iterations)
    .values({
      id,
      issue_id: `issue-${id}`,
      number: 1,
      context: '',
      steps: ['refine'],
      status: 'running',
      created_at: now,
      updated_at: now,
    })
    .run();
}

/** Шпион-control: фиксирует steer/abort/respond/prompt/send без процесса. */
function spyControl(): {
  control: StepSessionControl;
  steers: string[];
  aborts: number[];
  responses: UiResponsePayload[];
  prompts: Array<{ message: string; mode?: PromptMode }>;
  commands: Array<Record<string, unknown>>;
} {
  const steers: string[] = [];
  const aborts: number[] = [];
  const responses: UiResponsePayload[] = [];
  const prompts: Array<{ message: string; mode?: PromptMode }> = [];
  const commands: Array<Record<string, unknown>> = [];
  return {
    control: {
      steer: (text: string) => steers.push(text),
      abort: () => aborts.push(aborts.length + 1),
      respond: (payload: UiResponsePayload) => responses.push(payload),
      prompt: (message, mode) => {
        prompts.push({ message, ...(mode ? { mode } : {}) });
        return Promise.resolve({ ok: true, disposition: 'queued' });
      },
      send: (command) => {
        commands.push(command);
        return Promise.resolve({ ok: true, data: command });
      },
    },
    steers,
    aborts,
    responses,
    prompts,
    commands,
  };
}

describe('InMemoryStepSessionRegistry', () => {
  it('steer/abort неизвестного stepRunId → false и control не вызван', () => {
    const registry = new InMemoryStepSessionRegistry();
    const spy = spyControl();

    expect(registry.steer('missing', 'hi')).toBe(false);
    expect(registry.abort('missing')).toBe(false);
    expect(spy.steers).toEqual([]);
    expect(spy.aborts).toEqual([]);
  });

  it('register → steer/abort по stepRunId возвращают true и вызывают control', () => {
    const registry = new InMemoryStepSessionRegistry();
    const spy = spyControl();
    registry.register('run-1', 'iter-1', spy.control);

    expect(registry.steer('run-1', 'уточни')).toBe(true);
    expect(registry.abort('run-1')).toBe(true);
    expect(spy.steers).toEqual(['уточни']);
    expect(spy.aborts).toHaveLength(1);
  });

  it('steerByIteration/abortByIteration резолвят iterationId → активный stepRunId', () => {
    const registry = new InMemoryStepSessionRegistry();
    const spy = spyControl();
    registry.register('run-1', 'iter-1', spy.control);

    expect(registry.steerByIteration('iter-1', 'текст')).toBe(true);
    expect(registry.abortByIteration('iter-1')).toBe(true);
    expect(spy.steers).toEqual(['текст']);
    expect(spy.aborts).toHaveLength(1);

    expect(registry.steerByIteration('iter-unknown', 'nope')).toBe(false);
    expect(registry.abortByIteration('iter-unknown')).toBe(false);
  });

  it('unregister убирает из обоих мап: steer/steerByIteration → false', () => {
    const registry = new InMemoryStepSessionRegistry();
    const spy = spyControl();
    registry.register('run-1', 'iter-1', spy.control);

    registry.unregister('run-1');

    expect(registry.steer('run-1', 'hi')).toBe(false);
    expect(registry.steerByIteration('iter-1', 'hi')).toBe(false);
    expect(registry.abortByIteration('iter-1')).toBe(false);
    expect(spy.steers).toEqual([]);
    expect(spy.aborts).toEqual([]);
  });

  it('перерегистрация iteration ведёт на новый stepRunId; stale unregister его не сносит', () => {
    const registry = new InMemoryStepSessionRegistry();
    const first = spyControl();
    const second = spyControl();
    registry.register('run-1', 'iter-1', first.control);
    registry.register('run-2', 'iter-1', second.control);

    expect(registry.steerByIteration('iter-1', 'second')).toBe(true);
    expect(second.steers).toEqual(['second']);
    expect(first.steers).toEqual([]);

    // Удаление уже неактивного run-1 не должно ломать обратную ссылку на run-2.
    registry.unregister('run-1');
    expect(registry.steerByIteration('iter-1', 'still-second')).toBe(true);
    expect(second.steers).toEqual(['second', 'still-second']);
  });

  it('promptByIteration/sendByIteration резолвят активную сессию; без → null', async () => {
    const registry = new InMemoryStepSessionRegistry();
    const spy = spyControl();

    expect(await registry.promptByIteration('iter-x', 'hi')).toBeNull();
    expect(registry.sendByIteration('iter-x', { type: 'get_state' })).toBeNull();
    expect(registry.hasByIteration('iter-x')).toBe(false);

    registry.register('run-1', 'iter-1', spy.control);
    expect(registry.hasByIteration('iter-1')).toBe(true);

    const promptResult = await registry.promptByIteration('iter-1', 'привет', 'steer');
    const sendResult = await registry.sendByIteration('iter-1', {
      type: 'set_model',
      provider: 'anthropic',
      modelId: 'claude',
    });

    expect(promptResult).toEqual({ ok: true, disposition: 'queued' });
    expect(sendResult).toEqual({
      ok: true,
      data: { type: 'set_model', provider: 'anthropic', modelId: 'claude' },
    });
    expect(spy.prompts).toEqual([{ message: 'привет', mode: 'steer' }]);
    expect(spy.commands).toEqual([
      { type: 'set_model', provider: 'anthropic', modelId: 'claude' },
    ]);

    registry.unregister('run-1');
    expect(registry.hasByIteration('iter-1')).toBe(false);
    expect(registry.promptByIteration('iter-1', 'после')).toBeNull();
    expect(registry.sendByIteration('iter-1', { type: 'get_state' })).toBeNull();
  });

  it('respond/respondByIteration резолвят сессию и шлют payload', () => {
    const registry = new InMemoryStepSessionRegistry();
    const spy = spyControl();
    registry.register('run-1', 'iter-1', spy.control);

    expect(registry.respond('run-1', { id: 'ui-1', value: 'yes' })).toBe(true);
    expect(registry.respondByIteration('iter-1', { id: 'ui-2', cancelled: true })).toBe(
      true,
    );
    expect(spy.responses).toEqual([
      { id: 'ui-1', value: 'yes' },
      { id: 'ui-2', cancelled: true },
    ]);

    expect(registry.respond('missing', { id: 'ui-3', confirmed: true })).toBe(false);
    expect(registry.respondByIteration('iter-unknown', { id: 'ui-4', value: 'x' })).toBe(
      false,
    );
    expect(spy.responses).toHaveLength(2);
  });
});

describe('POST /iterations/:id/message', () => {
  it('200 {ok:true} при активной сессии; 409 без; steer вызван', async () => {
    const db = createDb(':memory:');
    const control = new InMemoryStepSessionRegistry();
    const spy = spyControl();
    const app = buildApp(db, { control });

    try {
      const inactive = await app.inject({
        method: 'POST',
        url: '/issue-resolver/api/v1/iterations/it1/message',
        payload: { message: 'привет' },
      });
      expect(inactive.statusCode).toBe(409);
      expect(inactive.json()).toEqual({ error: 'no active step session' });

      control.register('run-1', 'it1', spy.control);
      const active = await app.inject({
        method: 'POST',
        url: '/issue-resolver/api/v1/iterations/it1/message',
        payload: { message: 'привет' },
      });
      expect(active.statusCode).toBe(200);
      expect(active.json()).toEqual({ ok: true });
      expect(spy.steers).toEqual(['привет']);
    } finally {
      await app.close();
    }
  });

  it('пустой message → 400', async () => {
    const app = buildApp(createDb(':memory:'), {
      control: new InMemoryStepSessionRegistry(),
    });

    try {
      const response = await app.inject({
        method: 'POST',
        url: '/issue-resolver/api/v1/iterations/it1/message',
        payload: { message: '' },
      });
      expect(response.statusCode).toBe(400);
      expect(typeof response.json().error).toBe('string');
    } finally {
      await app.close();
    }
  });
});

describe('POST /iterations/:id/abort', () => {
  it('200 {ok:true} всегда: активная сессия → abort; без → терминализация', async () => {
    const db = createDb(':memory:');
    const control = new InMemoryStepSessionRegistry();
    const spy = spyControl();
    const app = buildApp(db, { control });

    try {
      // Нет активной сессии — не 409, а гарантированный terminal (200).
      const inactive = await app.inject({
        method: 'POST',
        url: '/issue-resolver/api/v1/iterations/it1/abort',
      });
      expect(inactive.statusCode).toBe(200);
      expect(inactive.json()).toEqual({ ok: true });

      control.register('run-1', 'it1', spy.control);
      const active = await app.inject({
        method: 'POST',
        url: '/issue-resolver/api/v1/iterations/it1/abort',
      });
      expect(active.statusCode).toBe(200);
      expect(active.json()).toEqual({ ok: true });
      expect(spy.aborts).toHaveLength(1);
    } finally {
      await app.close();
    }
  });
});

describe('POST /iterations/:id/ui-response', () => {
  it('без активной сессии → 200 {ok:true}; с сессией → respond вызван', async () => {
    const db = createDb(':memory:');
    seedIteration(db, 'it1');
    const control = new InMemoryStepSessionRegistry();
    const spy = spyControl();
    const app = buildApp(db, { control });

    try {
      const inactive = await app.inject({
        method: 'POST',
        url: '/issue-resolver/api/v1/iterations/it1/ui-response',
        payload: { id: 'ui-1', value: 'да' },
      });
      expect(inactive.statusCode).toBe(200);
      expect(inactive.json()).toEqual({ ok: true });

      control.register('run-1', 'it1', spy.control);
      const active = await app.inject({
        method: 'POST',
        url: '/issue-resolver/api/v1/iterations/it1/ui-response',
        payload: { id: 'ui-1', confirmed: true },
      });
      expect(active.statusCode).toBe(200);
      expect(active.json()).toEqual({ ok: true });
      expect(spy.responses).toEqual([{ id: 'ui-1', confirmed: true }]);
    } finally {
      await app.close();
    }
  });

  it('нет id или нет ответа → 400', async () => {
    const app = buildApp(createDb(':memory:'), {
      control: new InMemoryStepSessionRegistry(),
    });

    try {
      const noId = await app.inject({
        method: 'POST',
        url: '/issue-resolver/api/v1/iterations/it1/ui-response',
        payload: { value: 'x' },
      });
      expect(noId.statusCode).toBe(400);

      const noAnswer = await app.inject({
        method: 'POST',
        url: '/issue-resolver/api/v1/iterations/it1/ui-response',
        payload: { id: 'ui-1' },
      });
      expect(noAnswer.statusCode).toBe(400);
      expect(typeof noAnswer.json().error).toBe('string');
    } finally {
      await app.close();
    }
  });
});