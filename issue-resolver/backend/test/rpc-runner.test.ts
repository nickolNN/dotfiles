import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import type { SessionEvent } from '@issue-resolver/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RpcPiRunner } from '../src/pi/rpc-runner';
import { InMemoryStepSessionRegistry } from '../src/pi/session-registry';

vi.mock('node:child_process', () => ({ spawn: vi.fn() }));

import { spawn } from 'node:child_process';

const spawnMock = vi.mocked(spawn);

interface FakeChild extends EventEmitter {
  stdin: { writable: boolean; write: (chunk: string) => boolean };
  stdout: EventEmitter;
  stderr: EventEmitter;
  killed: boolean;
  kills: string[];
  writes: string[];
  kill: (signal?: string) => boolean;
}

/** Фейковый child process: EventEmitter + ручные stdout/stderr и запись stdin. */
function makeFakeChild(): FakeChild {
  const writes: string[] = [];
  const child = new EventEmitter() as FakeChild;
  child.writes = writes;
  child.kills = [];
  child.stdin = {
    writable: true,
    write: (chunk: string) => {
      writes.push(chunk);
      return true;
    },
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.killed = false;
  child.kill = (signal?: string) => {
    child.killed = true;
    child.kills.push(signal ?? '');
    return true;
  };
  return child;
}

const commands = (child: FakeChild): Array<Record<string, unknown>> =>
  child.writes.map((line) => JSON.parse(line) as Record<string, unknown>);

const emit = (child: FakeChild, event: Record<string, unknown>): void => {
  child.stdout.emit('data', Buffer.from(`${JSON.stringify(event)}\n`));
};

const STATS = {
  sessionId: 's1',
  userMessages: 2,
  assistantMessages: 2,
  toolCalls: 3,
  toolResults: 3,
  totalMessages: 7,
  tokens: { input: 10, output: 5, cacheRead: 1, cacheWrite: 2, total: 18 },
  cost: 0.5,
  contextUsage: { tokens: 100, contextWindow: 1000, percent: 10 },
};

afterEach(() => {
  vi.useRealTimers();
  spawnMock.mockReset();
});

describe('RpcPiRunner — статистика сессии', () => {
  it('на agent_settled шлёт get_session_stats и кладёт stats в результат', async () => {
    const child = makeFakeChild();
    spawnMock.mockReturnValue(child as unknown as ChildProcess);

    const runner = new RpcPiRunner('resolve', 'local');
    const promise = runner.run('container-1', 'prompt');

    // Промпт ушёл сразу и статистика ещё не запрошена.
    expect(commands(child)[0]).toMatchObject({ type: 'prompt', message: 'prompt' });
    expect(commands(child).some((c) => c.type === 'get_session_stats')).toBe(false);

    emit(child, { type: 'agent_settled', aborted: false });
    expect(commands(child).some((c) => c.type === 'get_session_stats')).toBe(true);

    emit(child, {
      type: 'response',
      command: 'get_session_stats',
      success: true,
      data: STATS,
    });

    const result = await promise;
    expect(result.stats).toEqual(STATS);
    expect(result.exitCode).toBe(0);
    // Финальный ответ также попадает в collected как stats-событие.
    expect(result.events?.at(-1)).toEqual({ type: 'stats', stats: STATS });
    // После финализации сессию мягко гасим.
    expect(commands(child).at(-1)).toEqual({ type: 'exit' });
    expect(child.kills).toContain('SIGTERM');
  });

  it('get_state приносит модель в финальные stats', async () => {
    const child = makeFakeChild();
    spawnMock.mockReturnValue(child as unknown as ChildProcess);

    const runner = new RpcPiRunner('resolve', 'local');
    const promise = runner.run('container-1', 'prompt');

    // get_state запрошен сразу после промпта.
    expect(commands(child)).toContainEqual({ type: 'get_state' });
    emit(child, {
      type: 'response',
      command: 'get_state',
      success: true,
      data: {
        model: {
          id: 'claude-sonnet-4',
          name: 'Claude Sonnet 4',
          provider: 'anthropic',
        },
      },
    });

    emit(child, { type: 'agent_settled', aborted: false });
    emit(child, {
      type: 'response',
      command: 'get_session_stats',
      success: true,
      data: STATS,
    });

    const result = await promise;
    expect(result.stats?.model).toBe('Claude Sonnet 4');
  });

  it('нет ответа get_session_stats → stats null по таймауту', async () => {
    vi.useFakeTimers();
    const child = makeFakeChild();
    spawnMock.mockReturnValue(child as unknown as ChildProcess);

    const runner = new RpcPiRunner('resolve', 'local');
    const promise = runner.run('container-1', 'prompt');

    emit(child, { type: 'agent_settled', aborted: false });
    await vi.advanceTimersByTimeAsync(2000);

    const result = await promise;
    expect(result.stats).toBeNull();
  });

  it('во время сессии периодически шлёт get_session_stats', async () => {
    vi.useFakeTimers();
    const child = makeFakeChild();
    spawnMock.mockReturnValue(child as unknown as ChildProcess);

    const runner = new RpcPiRunner('resolve', 'local');
    const promise = runner.run('container-1', 'prompt');

    const statsCount = (): number =>
      commands(child).filter((c) => c.type === 'get_session_stats').length;
    expect(statsCount()).toBe(0);

    await vi.advanceTimersByTimeAsync(3000);
    expect(statsCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(3000);
    expect(statsCount()).toBe(2);

    // Финализируем, иначе промис останется висеть.
    emit(child, { type: 'agent_settled', aborted: false });
    emit(child, {
      type: 'response',
      command: 'get_session_stats',
      success: true,
      data: STATS,
    });
    const result = await promise;
    expect(result.stats).toEqual(STATS);
  });

  it('stats-событие уходит в onEvent во время сессии', async () => {
    const child = makeFakeChild();
    spawnMock.mockReturnValue(child as unknown as ChildProcess);
    const events: SessionEvent[] = [];

    const runner = new RpcPiRunner('resolve', 'local');
    const promise = runner.run('container-1', 'prompt', {
      onEvent: (event) => events.push(event),
    });

    emit(child, {
      type: 'response',
      command: 'get_session_stats',
      success: true,
      data: STATS,
    });

    expect(events).toEqual([{ type: 'stats', stats: expect.objectContaining({ totalMessages: 7 }) }]);

    emit(child, { type: 'agent_settled', aborted: false });
    emit(child, {
      type: 'response',
      command: 'get_session_stats',
      success: true,
      data: STATS,
    });
    await promise;
  });

  it('thinking идёт событием, а не в stdout-прозу', async () => {
    const child = makeFakeChild();
    spawnMock.mockReturnValue(child as unknown as ChildProcess);
    const events: string[] = [];
    const chunks: string[] = [];

    const runner = new RpcPiRunner('resolve', 'local');
    const promise = runner.run('container-1', 'prompt', {
      onEvent: (event) => events.push(event.type),
      onStdout: (chunk) => chunks.push(chunk),
    });

    emit(child, {
      type: 'message_update',
      assistantMessageEvent: { type: 'thinking_delta', contentIndex: 0, delta: 'hm' },
    });
    emit(child, {
      type: 'message_update',
      assistantMessageEvent: {
        type: 'thinking_end',
        contentIndex: 0,
        content: { type: 'thinking', thinking: 'hm' },
      },
    });
    emit(child, { type: 'agent_settled', aborted: false });
    emit(child, { type: 'response', command: 'get_session_stats', success: true, data: {} });

    const result = await promise;
    // 'stats' — финальный get_session_stats в конце сессии.
    expect(events).toEqual(['thinking', 'stats']);
    expect(chunks).toEqual([]);
    expect(result.stdout).toBe('');
    expect(result.stats?.userMessages).toBe(0);
  });

  it('close без agent_settled тоже запрашивает stats', async () => {
    const child = makeFakeChild();
    spawnMock.mockReturnValue(child as unknown as ChildProcess);

    const runner = new RpcPiRunner('resolve', 'local');
    const promise = runner.run('container-1', 'prompt');

    child.emit('close', 7);
    expect(commands(child).some((c) => c.type === 'get_session_stats')).toBe(true);

    emit(child, {
      type: 'response',
      command: 'get_session_stats',
      success: true,
      data: STATS,
    });

    const result = await promise;
    expect(result.exitCode).toBe(7);
    expect(result.stats).toEqual(STATS);
  });

  it('registry.respond → extension_ui_response с id в stdin', async () => {
    const child = makeFakeChild();
    spawnMock.mockReturnValue(child as unknown as ChildProcess);
    const registry = new InMemoryStepSessionRegistry();

    const runner = new RpcPiRunner('resolve', 'local');
    const promise = runner.run('container-1', 'prompt', {
      registry,
      stepRunId: 'run-1',
      iterationId: 'iter-1',
    });

    expect(registry.respond('run-1', { id: 'ui-1', value: 'да' })).toBe(true);
    expect(commands(child)).toContainEqual({
      type: 'extension_ui_response',
      id: 'ui-1',
      value: 'да',
    });

    emit(child, { type: 'agent_settled', aborted: false });
    emit(child, {
      type: 'response',
      command: 'get_session_stats',
      success: true,
      data: STATS,
    });
    const result = await promise;
    expect(result.stats).toEqual(STATS);
  });

  it('abort зависшей сессии → SIGKILL, раннер резолвит aborted', async () => {
    const child = makeFakeChild();
    spawnMock.mockReturnValue(child as unknown as ChildProcess);
    const registry = new InMemoryStepSessionRegistry();

    const runner = new RpcPiRunner('resolve', 'local');
    const promise = runner.run('container-1', 'prompt', {
      registry,
      stepRunId: 'run-1',
      iterationId: 'iter-1',
    });

    // Сессия не отвечает на abort-команду (заблокирована на dialog) —
    // раннер обязан жёстко погасить процесс.
    expect(registry.abort('run-1')).toBe(true);
    expect(commands(child)).toContainEqual({ type: 'abort' });
    expect(child.kills).toContain('SIGKILL');

    // Процесс убит сигналом: close переводит раннер в aborted-результат.
    child.emit('close', null);
    emit(child, {
      type: 'response',
      command: 'get_session_stats',
      success: true,
      data: STATS,
    });

    const result = await promise;
    expect(result.report).toEqual({ status: 'fail', summary: 'aborted' });
    expect(result.aborted).toBe(true);
    expect(result.exitCode).toBe(1);
  });
});

/** Завершает живую сессию: agent_settled + финальный get_session_stats. */
const settle = (child: FakeChild): void => {
  emit(child, { type: 'agent_settled', aborted: false });
  emit(child, {
    type: 'response',
    command: 'get_session_stats',
    success: true,
    data: STATS,
  });
};

describe('RpcPiRunner — command bridge', () => {
  it('registry.prompt → id-коррелированный prompt со streamingBehavior', async () => {
    const child = makeFakeChild();
    spawnMock.mockReturnValue(child as unknown as ChildProcess);
    const registry = new InMemoryStepSessionRegistry();

    const runner = new RpcPiRunner('resolve', 'local');
    const promise = runner.run('container-1', 'initial', {
      registry,
      stepRunId: 'run-1',
      iterationId: 'iter-1',
    });

    const promptPromise = registry.promptByIteration('iter-1', 'ещё', 'steer');
    expect(promptPromise).not.toBeNull();
    const sent = commands(child).find(
      (command) => command.type === 'prompt' && command.message === 'ещё',
    );
    expect(sent).toMatchObject({
      type: 'prompt',
      message: 'ещё',
      streamingBehavior: 'steer',
    });
    expect(typeof sent?.id).toBe('string');

    emit(child, {
      type: 'response',
      id: sent?.id,
      command: 'prompt',
      success: true,
      data: { disposition: 'queued' },
    });
    expect(await promptPromise).toEqual({ ok: true, disposition: 'queued' });

    settle(child);
    await promise;
  });

  it('registry.send → id-команда и ControlResult из ответа (в т.ч. success:false)', async () => {
    const child = makeFakeChild();
    spawnMock.mockReturnValue(child as unknown as ChildProcess);
    const registry = new InMemoryStepSessionRegistry();

    const runner = new RpcPiRunner('resolve', 'local');
    const promise = runner.run('container-1', 'initial', {
      registry,
      stepRunId: 'run-1',
      iterationId: 'iter-1',
    });

    const okPromise = registry.sendByIteration('iter-1', {
      type: 'set_model',
      provider: 'p',
      modelId: 'm',
    });
    const okSent = commands(child).find((command) => command.type === 'set_model');
    expect(okSent).toMatchObject({ type: 'set_model', provider: 'p', modelId: 'm' });
    emit(child, {
      type: 'response',
      id: okSent?.id,
      command: 'set_model',
      success: true,
      data: { changed: true },
    });
    expect(await okPromise).toEqual({ ok: true, data: { changed: true } });

    const failPromise = registry.sendByIteration('iter-1', { type: 'cycle_model' });
    const failSent = commands(child).find((command) => command.type === 'cycle_model');
    emit(child, {
      type: 'response',
      id: failSent?.id,
      command: 'cycle_model',
      success: false,
      error: 'nope',
    });
    expect(await failPromise).toEqual({ ok: false, error: 'nope' });

    settle(child);
    await promise;
  });

  it('sendCommand без ответа → ok:false error:timeout', async () => {
    vi.useFakeTimers();
    const child = makeFakeChild();
    spawnMock.mockReturnValue(child as unknown as ChildProcess);
    const registry = new InMemoryStepSessionRegistry();

    const runner = new RpcPiRunner('resolve', 'local');
    const promise = runner.run('container-1', 'initial', {
      registry,
      stepRunId: 'run-1',
      iterationId: 'iter-1',
    });

    const sendPromise = registry.sendByIteration('iter-1', { type: 'get_commands' });
    await vi.advanceTimersByTimeAsync(10000);
    expect(await sendPromise).toEqual({ ok: false, error: 'timeout' });

    settle(child);
    await promise;
  });

  it('закрытие сессии резолвит подвисшие команды как session closed', async () => {
    const child = makeFakeChild();
    spawnMock.mockReturnValue(child as unknown as ChildProcess);
    const registry = new InMemoryStepSessionRegistry();

    const runner = new RpcPiRunner('resolve', 'local');
    const promise = runner.run('container-1', 'initial', {
      registry,
      stepRunId: 'run-1',
      iterationId: 'iter-1',
    });

    const pendingSend = registry.sendByIteration('iter-1', { type: 'get_commands' });
    child.emit('close', 0);
    expect(await pendingSend).toEqual({ ok: false, error: 'session closed' });

    emit(child, {
      type: 'response',
      command: 'get_session_stats',
      success: true,
      data: STATS,
    });
    await promise;
  });
});