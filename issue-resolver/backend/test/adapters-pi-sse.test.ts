import { describe, expect, it, vi } from 'vitest';
import type { SessionEvent, SSEEvent, StepExecutionResult } from '@issue-resolver/shared';
import { FakePiRunner, type PiRunner } from '../src/pi/runner';
import { RpcPiRunner } from '../src/pi/rpc-runner';
import { InMemoryStepSessionRegistry } from '../src/pi/session-registry';
import { InMemorySseHub } from '../src/sse/hub';

const sseEvent = (iterationId: string, data = 'chunk'): SSEEvent => ({
  type: 'log',
  issueId: 'issue-1',
  iterationId,
  data,
  ts: '2026-01-01T00:00:00.000Z',
});

describe('FakePiRunner', () => {
  it('без очереди возвращает успех по умолчанию', async () => {
    const runner = new FakePiRunner();

    const result = await runner.run('container-1', 'do the thing');

    expect(result.exitCode).toBe(0);
    expect(result.step).toBe('resolve');
    expect(result.report).toEqual({ status: 'pass', summary: 'ok' });
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('');
  });

  it('enqueue двух результатов → run() дважды возвращает их по порядку', async () => {
    const runner = new FakePiRunner();
    const first: StepExecutionResult = {
      step: 'resolve',
      exitCode: 0,
      report: { status: 'pass', summary: 'first' },
      stdout: 'one',
      stderr: '',
    };
    const second: StepExecutionResult = {
      step: 'test',
      exitCode: 0,
      report: { status: 'pass', summary: 'second' },
      stdout: 'two',
      stderr: '',
    };
    runner.enqueue(first);
    runner.enqueue(second);

    await expect(runner.run('c', 'p')).resolves.toBe(first);
    await expect(runner.run('c', 'p')).resolves.toBe(second);
  });

  it('calls фиксирует containerName/prompt/options каждого вызова', async () => {
    const runner = new FakePiRunner();
    const options = { model: 'haiku', cwd: '/workspace/repo', timeoutMs: 1000 };

    await runner.run('container-1', 'prompt-1', options);
    await runner.run('container-2', 'prompt-2');

    expect(runner.calls).toHaveLength(2);
    expect(runner.calls[0]).toEqual({
      containerName: 'container-1',
      prompt: 'prompt-1',
      options,
    });
    expect(runner.calls[1]).toEqual({
      containerName: 'container-2',
      prompt: 'prompt-2',
      options: undefined,
    });
  });

  it('enqueue провального результата → возвращает именно его', async () => {
    const runner = new FakePiRunner();
    const failure: StepExecutionResult = {
      step: 'resolve',
      exitCode: 1,
      report: { status: 'fail', summary: 'nope' },
      stdout: '',
      stderr: 'boom',
    };
    runner.enqueue(failure);

    await expect(runner.run('c', 'p')).resolves.toBe(failure);
  });

  it('onStdout/onStderr получают непустые stdout/stderr результата', async () => {
    const runner = new FakePiRunner();
    const out: string[] = [];
    const err: string[] = [];
    runner.enqueue({
      step: 'resolve',
      exitCode: 0,
      report: { status: 'pass', summary: 'ok' },
      stdout: 'live-out',
      stderr: 'live-err',
    });

    await runner.run('c', 'p', {
      onStdout: (chunk) => out.push(chunk),
      onStderr: (chunk) => err.push(chunk),
    });

    expect(out).toEqual(['live-out']);
    expect(err).toEqual(['live-err']);
  });

  it('пустые stdout/stderr не эмитятся в колбэки', async () => {
    const runner = new FakePiRunner();
    const out: string[] = [];
    const err: string[] = [];

    await runner.run('c', 'p', {
      onStdout: (chunk) => out.push(chunk),
      onStderr: (chunk) => err.push(chunk),
    });

    expect(out).toEqual([]);
    expect(err).toEqual([]);
  });

  it('демо-события сессии: result.events непустой и эмитится в onEvent', async () => {
    const runner = new FakePiRunner();
    const events: SessionEvent[] = [];

    const result = await runner.run('c', 'p', {
      onEvent: (event) => events.push(event),
    });

    expect(result.events).toHaveLength(3);
    expect(result.events?.map((event) => event.type)).toEqual([
      'text',
      'tool_use',
      'tool_result',
    ]);
    expect(events).toEqual(result.events);
    expect(events[1]).toMatchObject({
      type: 'tool_use',
      toolName: 'bash',
      args: { command: 'pwd' },
    });
    expect(events[2]).toMatchObject({
      type: 'tool_result',
      toolName: 'bash',
      isError: false,
      resultText: '/workspace',
    });
  });

  it('registry+stepRunId+iterationId → steer/abort фиксируются в controlCalls', async () => {
    const runner = new FakePiRunner();
    const registry = new InMemoryStepSessionRegistry();

    await runner.run('c', 'p', {
      registry,
      stepRunId: 'run-1',
      iterationId: 'iter-1',
    });

    expect(registry.steerByIteration('iter-1', 'уточни')).toBe(true);
    expect(registry.abort('run-1')).toBe(true);
    expect(runner.controlCalls).toEqual([
      { kind: 'steer', stepRunId: 'run-1', text: 'уточни' },
      { kind: 'abort', stepRunId: 'run-1' },
    ]);
  });
});

describe('RpcPiRunner', () => {
  it('совместим с интерфейсом PiRunner (сигнатура компилируется)', () => {
    const runner: PiRunner = new RpcPiRunner();
    expect(typeof runner.run).toBe('function');
  });
});

describe('InMemorySseHub', () => {
  it('publish доставляет событие подписчикам совпадающего iterationId', () => {
    const hub = new InMemorySseHub();
    const listener = vi.fn();

    hub.subscribe('iter-1', listener);
    const event = sseEvent('iter-1', 'hello');
    hub.publish(event);

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(event);
  });

  it('подписчик другого iterationId не получает событие', () => {
    const hub = new InMemorySseHub();
    const matching = vi.fn();
    const other = vi.fn();

    hub.subscribe('iter-1', matching);
    hub.subscribe('iter-2', other);
    hub.publish(sseEvent('iter-1'));

    expect(matching).toHaveBeenCalledTimes(1);
    expect(other).not.toHaveBeenCalled();
  });

  it('unsubscribe() останавливает доставку', () => {
    const hub = new InMemorySseHub();
    const listener = vi.fn();

    const unsubscribe = hub.subscribe('iter-1', listener);
    hub.publish(sseEvent('iter-1'));
    unsubscribe();
    hub.publish(sseEvent('iter-1'));

    expect(listener).toHaveBeenCalledTimes(1);
  });
});