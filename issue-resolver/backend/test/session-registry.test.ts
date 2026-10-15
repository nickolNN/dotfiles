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

  it('multi-session: steerByIteration/abortByIteration broadcast на все сессии', () => {
    const registry = new InMemoryStepSessionRegistry();
    const first = spyControl();
    const second = spyControl();
    registry.register('run-1', 'iter-1', first.control);
    registry.register('run-2', 'iter-1', second.control);

    expect(registry.steerByIteration('iter-1', 'all')).toBe(true);
    expect(registry.abortByIteration('iter-1')).toBe(true);

    // Broadcast: обе сессии итерации получили и steer, и abort.
    expect(first.steers).toEqual(['all']);
    expect(second.steers).toEqual(['all']);
    expect(first.aborts).toHaveLength(1);
    expect(second.aborts).toHaveLength(1);
  });

  it('multi-session: unregister одной оставляет hasByIteration, последней — снимает', () => {
    const registry = new InMemoryStepSessionRegistry();
    registry.register('run-1', 'iter-1', spyControl().control);
    registry.register('run-2', 'iter-1', spyControl().control);

    registry.unregister('run-1');
    expect(registry.hasByIteration('iter-1')).toBe(true);

    registry.unregister('run-2');
    expect(registry.hasByIteration('iter-1')).toBe(false);
    expect(registry.abortByIteration('iter-1')).toBe(false);
  });

  it('anchor: prompt/send/respond идут на последнюю зарегистрированную сессию', async () => {
    const registry = new InMemoryStepSessionRegistry();
    const first = spyControl();
    const second = spyControl();
    registry.register('run-1', 'iter-1', first.control);
    registry.register('run-2', 'iter-1', second.control);

    await registry.promptByIteration('iter-1', 'anchor');
    await registry.sendByIteration('iter-1', { type: 'get_state' });
    registry.respondByIteration('iter-1', { id: 'ui-1', value: 'y' });

    // Anchor = последняя зарегистрированная (в фазе room — координатор).
    expect(second.prompts).toEqual([{ message: 'anchor' }]);
    expect(second.commands).toEqual([{ type: 'get_state' }]);
    expect(second.responses).toEqual([{ id: 'ui-1', value: 'y' }]);
    expect(first.prompts).toEqual([]);
    expect(first.commands).toEqual([]);
    expect(first.responses).toEqual([]);
  });

  it('anchor: после снятия последней сессии якорем становится предыдущая', async () => {
    const registry = new InMemoryStepSessionRegistry();
    const first = spyControl();
    const second = spyControl();
    registry.register('run-1', 'iter-1', first.control);
    registry.register('run-2', 'iter-1', second.control);

    registry.unregister('run-2');
    expect(registry.steerByIteration('iter-1', 'now-first')).toBe(true);
    expect(first.steers).toEqual(['now-first']);
    expect(second.steers).toEqual([]);
  });

  it('single-режим: одна сессия — поведение как раньше (без регресса)', () => {
    const registry = new InMemoryStepSessionRegistry();
    const spy = spyControl();
    registry.register('run-1', 'iter-1', spy.control);

    expect(registry.steerByIteration('iter-1', 'hi')).toBe(true);
    expect(registry.abortByIteration('iter-1')).toBe(true);
    expect(spy.steers).toEqual(['hi']);
    expect(spy.aborts).toHaveLength(1);
  });

  it('listAgents: агенты комнаты в порядке регистрации, статус меняется при unregister', () => {
    const registry = new InMemoryStepSessionRegistry();
    registry.register('base/worker/0', 'iter-1', spyControl().control, {
      id: 'base/worker/0',
      role: 'worker',
      index: 1,
      label: 'Воркер 1',
    });
    registry.register('base/worker/1', 'iter-1', spyControl().control, {
      id: 'base/worker/1',
      role: 'worker',
      index: 2,
      label: 'Воркер 2',
    });
    registry.register('base', 'iter-1', spyControl().control, {
      id: 'base',
      role: 'coordinator',
      index: null,
      label: 'Координатор',
    });

    expect(registry.listAgents('iter-1')).toEqual([
      {
        id: 'base/worker/0',
        role: 'worker',
        index: 1,
        label: 'Воркер 1',
        stage: null,
        stageName: null,
        status: 'running',
        startedAt: expect.any(String),
        endedAt: null,
        stats: null,
      },
      {
        id: 'base/worker/1',
        role: 'worker',
        index: 2,
        label: 'Воркер 2',
        stage: null,
        stageName: null,
        status: 'running',
        startedAt: expect.any(String),
        endedAt: null,
        stats: null,
      },
      {
        id: 'base',
        role: 'coordinator',
        index: null,
        label: 'Координатор',
        stage: null,
        stageName: null,
        status: 'running',
        startedAt: expect.any(String),
        endedAt: null,
        stats: null,
      },
    ]);

    registry.unregister('base/worker/0', 'failed');
    // Вкладка завершённого агента остаётся, но живой сессии уже нет.
    expect(registry.listAgents('iter-1')[0].status).toBe('failed');
    expect(registry.steer('base/worker/0', 'x')).toBe(false);
    expect(registry.listAgents('iter-1')).toHaveLength(3);
    expect(registry.listAgents('iter-unknown')).toEqual([]);
  });

  it('listAgents: unregister без статуса → finished; single-сессия без agent не попадает', () => {
    const registry = new InMemoryStepSessionRegistry();
    registry.register('run-single', 'iter-2', spyControl().control);
    registry.register('base', 'iter-2', spyControl().control, {
      id: 'base',
      role: 'coordinator',
      index: null,
      label: 'Координатор',
    });

    registry.unregister('base');
    expect(registry.listAgents('iter-2')).toEqual([
      {
        id: 'base',
        role: 'coordinator',
        index: null,
        label: 'Координатор',
        stage: null,
        stageName: null,
        status: 'finished',
        startedAt: expect.any(String),
        endedAt: expect.any(String),
        stats: null,
      },
    ]);
  });

  it('listAgents: stage/stageName агента комнаты попадают в снимок', () => {
    const registry = new InMemoryStepSessionRegistry();
    registry.register('base/stage/1/worker/0', 'iter-stage', spyControl().control, {
      id: 'base/stage/1/worker/0',
      role: 'worker',
      index: 1,
      label: 'Этап 1 · Воркер 1',
      stage: 1,
      stageName: 'Сбор контекста',
    });
    registry.register('base', 'iter-stage', spyControl().control, {
      id: 'base',
      role: 'coordinator',
      index: null,
      label: 'Координатор',
    });

    expect(registry.listAgents('iter-stage')).toEqual([
      {
        id: 'base/stage/1/worker/0',
        role: 'worker',
        index: 1,
        label: 'Этап 1 · Воркер 1',
        stage: 1,
        stageName: 'Сбор контекста',
        status: 'running',
        startedAt: expect.any(String),
        endedAt: null,
        stats: null,
      },
      {
        id: 'base',
        role: 'coordinator',
        index: null,
        label: 'Координатор',
        stage: null,
        stageName: null,
        status: 'running',
        startedAt: expect.any(String),
        endedAt: null,
        stats: null,
      },
    ]);
  });

  it('recordEvent: usage агрегируется в stats, cost null пока его не было', () => {
    const registry = new InMemoryStepSessionRegistry();
    registry.register('base/worker/0', 'iter-3', spyControl().control, {
      id: 'base/worker/0',
      role: 'worker',
      index: 1,
      label: 'Воркер 1',
    });

    // До событий — тайминг есть, телеметрии нет.
    const before = registry.listAgents('iter-3')[0];
    expect(before.startedAt).toEqual(expect.any(String));
    expect(before.stats).toBeNull();

    registry.recordEvent('base/worker/0', {
      type: 'usage',
      usage: { input: 10, output: 2, cacheRead: 3, cacheWrite: 1, total: 16 },
      cost: null,
    });
    registry.recordEvent('base/worker/0', {
      type: 'usage',
      usage: { input: 5, output: 1, cacheRead: 0, cacheWrite: 0, total: 6 },
      cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, total: 3 },
    });

    expect(registry.listAgents('iter-3')[0].stats).toEqual({
      userMessages: 0,
      assistantMessages: 0,
      toolCalls: 0,
      toolResults: 0,
      totalMessages: 0,
      tokens: { input: 15, output: 3, cacheRead: 3, cacheWrite: 1, total: 22 },
      cost: 3,
      contextUsage: null,
    });
  });

  it('recordEvent: кумулятивные снапшоты одного ответа схлопываются, ответы суммируются', () => {
    const registry = new InMemoryStepSessionRegistry();
    registry.register('base/worker/0', 'iter-cumulative', spyControl().control, {
      id: 'base/worker/0',
      role: 'worker',
      index: 1,
      label: 'Воркер 1',
    });

    // Ответ 1: total растёт 50 → 100 (кумулятив) — берём последний снапшот.
    registry.recordEvent('base/worker/0', {
      type: 'usage',
      usage: { input: 40, output: 10, cacheRead: 0, cacheWrite: 0, total: 50 },
      cost: null,
    });
    registry.recordEvent('base/worker/0', {
      type: 'usage',
      usage: { input: 80, output: 20, cacheRead: 0, cacheWrite: 0, total: 100 },
      cost: null,
    });
    // Ответ 2: total упал → новая граница, предыдущий ответ суммируется.
    registry.recordEvent('base/worker/0', {
      type: 'usage',
      usage: { input: 4, output: 1, cacheRead: 0, cacheWrite: 0, total: 5 },
      cost: null,
    });

    expect(registry.listAgents('iter-cumulative')[0].stats?.tokens).toEqual({
      input: 84,
      output: 21,
      cacheRead: 0,
      cacheWrite: 0,
      total: 105,
    });
  });

  it('recordEvent: последнее stats-событие даёт contextUsage/счётчики/model; токены — из usage', () => {
    const registry = new InMemoryStepSessionRegistry();
    registry.register('base', 'iter-4', spyControl().control, {
      id: 'base',
      role: 'coordinator',
      index: null,
      label: 'Координатор',
    });

    registry.recordEvent('base', {
      type: 'usage',
      usage: { input: 7, output: 1, cacheRead: 0, cacheWrite: 0, total: 8 },
      cost: null,
    });
    registry.recordEvent('base', {
      type: 'stats',
      stats: {
        model: 'Claude Sonnet 4',
        userMessages: 2,
        assistantMessages: 3,
        toolCalls: 4,
        toolResults: 5,
        totalMessages: 5,
        tokens: { input: 999, output: 999, cacheRead: 0, cacheWrite: 0, total: 1998 },
        cost: 42,
        contextUsage: { tokens: 100, contextWindow: 1000, percent: 10 },
      },
    });

    const stats = registry.listAgents('iter-4')[0].stats;
    expect(stats).toMatchObject({
      model: 'Claude Sonnet 4',
      userMessages: 2,
      assistantMessages: 3,
      toolCalls: 4,
      toolResults: 5,
      totalMessages: 5,
      tokens: { input: 7, output: 1, cacheRead: 0, cacheWrite: 0, total: 8 },
      contextUsage: { tokens: 100, contextWindow: 1000, percent: 10 },
    });
  });

  it('recordEvent: без usage токены/cost берутся из stats-события', () => {
    const registry = new InMemoryStepSessionRegistry();
    registry.register('base', 'iter-5', spyControl().control, {
      id: 'base',
      role: 'coordinator',
      index: null,
      label: 'Координатор',
    });

    registry.recordEvent('base', {
      type: 'stats',
      stats: {
        userMessages: 0,
        assistantMessages: 1,
        toolCalls: 0,
        toolResults: 0,
        totalMessages: 1,
        tokens: { input: 3, output: 4, cacheRead: 0, cacheWrite: 0, total: 7 },
        cost: 0,
        contextUsage: null,
      },
    });

    expect(registry.listAgents('iter-5')[0].stats).toMatchObject({
      tokens: { input: 3, output: 4, cacheRead: 0, cacheWrite: 0, total: 7 },
      cost: 0,
    });
  });

  it('recordEvent: не-агентская (single) сессия игнорируется', () => {
    const registry = new InMemoryStepSessionRegistry();
    registry.register('run-single', 'iter-6', spyControl().control);

    registry.recordEvent('run-single', {
      type: 'usage',
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2 },
      cost: null,
    });
    registry.recordEvent('unknown', {
      type: 'usage',
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2 },
      cost: null,
    });

    expect(registry.listAgents('iter-6')).toEqual([]);
  });

  it('listAgents: FIFO-эвикция при >64 итерациях с агентами', () => {
    const registry = new InMemoryStepSessionRegistry();
    for (let i = 0; i < 65; i += 1) {
      const iterationId = `iter-${i}`;
      registry.register(`${iterationId}/worker/0`, iterationId, spyControl().control, {
        id: `${iterationId}/worker/0`,
        role: 'worker',
        index: 1,
        label: 'Воркер 1',
      });
    }

    expect(registry.listAgents('iter-0')).toEqual([]);
    expect(registry.listAgents('iter-64')).toHaveLength(1);
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