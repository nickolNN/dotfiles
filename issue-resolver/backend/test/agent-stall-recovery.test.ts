import { describe, expect, it, vi } from 'vitest';

import {
  iterationTarget,
  runTarget,
  type StepSessionRegistry,
} from '../src/pi/session-registry';
import { STALL_NUDGE_TEXT, stallRecoveries } from '../src/pi/stall-recovery';
import { withAgentStallGuard } from '../src/workflow/timeout';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function registryStub(overrides: Partial<StepSessionRegistry> = {}) {
  return {
    prompt: vi.fn().mockResolvedValue({ ok: true }),
    send: vi.fn().mockResolvedValue({ ok: true }),
    ...overrides,
  } as unknown as StepSessionRegistry;
}

describe('withAgentStallGuard — восстановление до провала', () => {
  it('nudge даёт отсрочку: агент очнулся и продолжил работу', async () => {
    let activity = 0;
    let produced: ReturnType<typeof setInterval> | undefined;
    const nudge = vi.fn(() => {
      // The nudged agent starts producing output again, chunk by chunk.
      produced = setInterval(() => {
        activity += 1;
      }, 5);
      return 200;
    });
    const run = (async () => {
      await sleep(80);
      return 'done';
    })();

    const result = await withAgentStallGuard(run, {
      stallMs: 20,
      pollMs: 5,
      label: 'step agent',
      activity: () => activity,
      recover: [{ label: 'nudge', attempt: nudge }],
    });
    clearInterval(produced);

    expect(result).toBe('done');
    expect(nudge).toHaveBeenCalledTimes(1);
    expect(activity).toBeGreaterThan(3);
  });

  it('отсрочка не помогла → следующий шаг лестницы, затем падение с их списком', async () => {
    const nudge = vi.fn(() => 30);
    const compact = vi.fn(() => 30);
    const onStall = vi.fn();

    await expect(
      withAgentStallGuard(new Promise(() => {}), {
        stallMs: 20,
        pollMs: 5,
        label: 'step agent',
        activity: () => 0,
        recover: [
          { label: 'nudge', attempt: nudge },
          { label: 'compact', attempt: compact },
        ],
        onStall,
      }),
    ).rejects.toThrow(/stalled: no output for 20ms \(tried: nudge, compact\)/);

    expect(nudge).toHaveBeenCalledTimes(1);
    expect(compact).toHaveBeenCalledTimes(1);
    expect(onStall).toHaveBeenCalledTimes(1);
  });

  it('нулевая отсрочка (живой сессии нет) не тратит следующую ступень', async () => {
    const nudge = vi.fn(() => 0);
    const compact = vi.fn(() => 0);

    await expect(
      withAgentStallGuard(new Promise(() => {}), {
        stallMs: 20,
        pollMs: 5,
        label: 'step agent',
        activity: () => 0,
        recover: [
          { label: 'nudge', attempt: nudge },
          { label: 'compact', attempt: compact },
        ],
      }),
    ).rejects.toThrow(/tried: nudge, compact/);

    expect(nudge).toHaveBeenCalledTimes(1);
    expect(compact).toHaveBeenCalledTimes(1);
  });

  it('зависшая доставка не держит сторож дольше attemptTimeoutMs', async () => {
    const stuck = vi.fn(() => new Promise<number>(() => {}));
    const onStall = vi.fn();

    await expect(
      withAgentStallGuard(new Promise(() => {}), {
        stallMs: 20,
        pollMs: 5,
        attemptTimeoutMs: 20,
        label: 'step agent',
        activity: () => 0,
        recover: [{ label: 'nudge', attempt: stuck }],
        onStall,
      }),
    ).rejects.toThrow(/tried: nudge/);

    expect(stuck).toHaveBeenCalledTimes(1);
    expect(onStall).toHaveBeenCalledTimes(1);
  });

  it('без лестницы поведение прежнее: сразу падение', async () => {
    await expect(
      withAgentStallGuard(new Promise(() => {}), {
        stallMs: 20,
        pollMs: 5,
        label: 'step agent',
        activity: () => 0,
      }),
    ).rejects.toThrow(/stalled: no output for 20ms$/);
  });
});

describe('stallRecoveries — что именно отправляем', () => {
  it('без живой сессии лестница пуста', () => {
    expect(stallRecoveries({ graceMs: 1_000 })).toEqual([]);
    const control = registryStub();
    expect(stallRecoveries({ control, graceMs: 1_000 })).toEqual([]);
  });

  it('run-адрес: follow_up nudge, затем compact', async () => {
    const control = registryStub();
    const target = iterationTarget('run-1');
    const [nudge, compact] = stallRecoveries({ control, target, graceMs: 5_000 });

    expect(nudge.label).toBe('nudge');
    expect(await nudge.attempt()).toBe(5_000);
    expect(control.prompt).toHaveBeenCalledWith(
      { by: 'iteration', id: 'run-1' },
      STALL_NUDGE_TEXT,
      'followUp',
    );

    expect(compact.label).toBe('compact');
    expect(await compact.attempt()).toBe(5_000);
    expect(control.send).toHaveBeenCalledWith(
      { by: 'iteration', id: 'run-1' },
      { type: 'compact' },
    );
  });

  it('issue-level прогон адресуется точно, по своему адресу', async () => {
    const control = registryStub();
    const target = runTarget('issue.x.report');
    const [nudge, compact] = stallRecoveries({ control, target, graceMs: 0 });

    expect(target).toEqual({ by: 'run', id: 'issue.x.report' });
    expect(await nudge.attempt()).toBe(0);
    expect(control.prompt).toHaveBeenCalledWith(
      { by: 'run', id: 'issue.x.report' },
      STALL_NUDGE_TEXT,
      'followUp',
    );
    expect(await compact.attempt()).toBe(0);
    expect(control.send).toHaveBeenCalledWith(
      { by: 'run', id: 'issue.x.report' },
      { type: 'compact' },
    );
  });

  it('недоставленный нудж окна не даёт: лестница идёт дальше', async () => {
    const control = registryStub({
      prompt: vi.fn().mockResolvedValue({ ok: false, error: 'timeout' }),
    });
    const [nudge] = stallRecoveries({
      control,
      target: iterationTarget('run-1'),
      graceMs: 5_000,
    });

    expect(await nudge.attempt()).toBe(0);
  });
});