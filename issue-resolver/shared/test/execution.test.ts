import { describe, expect, it } from 'vitest';

import {
  clampExecutors,
  DEFAULT_MAX_ROOM_EXECUTORS,
  parseExecutionPlan,
  planExecutionMode,
  planRoomWorkItems,
} from '../src/execution';
import type { ExecutionPlan } from '../src/types';

describe('parseExecutionPlan', () => {
  it('parses a full valid room plan', () => {
    expect(
      parseExecutionPlan({
        mode: 'room',
        executors: 3,
        decomposition: ['a', 'b', 'c'],
        rationale: 'three independent parts',
      }),
    ).toEqual({
      mode: 'room',
      executors: 3,
      decomposition: ['a', 'b', 'c'],
      rationale: 'three independent parts',
    });
  });

  it('parses a minimal single plan without optional fields', () => {
    expect(parseExecutionPlan({ mode: 'single' })).toEqual({ mode: 'single' });
  });

  it('drops a non-integer executors and empty/garbage decomposition', () => {
    expect(
      parseExecutionPlan({
        mode: 'room',
        executors: 2.5,
        decomposition: ['ok', '', '  ', 7, null],
      }),
    ).toEqual({ mode: 'room', decomposition: ['ok'] });
  });

  it('returns null for broken shapes', () => {
    expect(parseExecutionPlan(null)).toBeNull();
    expect(parseExecutionPlan(undefined)).toBeNull();
    expect(parseExecutionPlan([1, 2])).toBeNull();
    expect(parseExecutionPlan('room')).toBeNull();
    expect(parseExecutionPlan(42)).toBeNull();
    expect(parseExecutionPlan({})).toBeNull();
    expect(parseExecutionPlan({ mode: 'nope' })).toBeNull();
  });
});

describe('planExecutionMode', () => {
  it('null/undefined → single', () => {
    expect(planExecutionMode(null)).toBe('single');
    expect(planExecutionMode(undefined)).toBe('single');
  });

  it('explicit single → single', () => {
    expect(planExecutionMode({ mode: 'single', executors: 4 })).toBe('single');
  });

  it('room with executors >= 2 → room', () => {
    expect(planExecutionMode({ mode: 'room', executors: 2 })).toBe('room');
    expect(planExecutionMode({ mode: 'room', executors: 4 })).toBe('room');
  });

  it('room without a valid executors count → single', () => {
    expect(planExecutionMode({ mode: 'room' })).toBe('single');
    expect(planExecutionMode({ mode: 'room', executors: 1 })).toBe('single');
    expect(planExecutionMode({ mode: 'room', executors: 0 })).toBe('single');
  });
});

describe('clampExecutors', () => {
  it('keeps a valid count within range', () => {
    expect(clampExecutors({ mode: 'room', executors: 3 })).toBe(3);
  });

  it('caps at DEFAULT_MAX_ROOM_EXECUTORS (4)', () => {
    expect(DEFAULT_MAX_ROOM_EXECUTORS).toBe(4);
    expect(clampExecutors({ mode: 'room', executors: 10 })).toBe(4);
  });

  it('has a floor of 2', () => {
    expect(clampExecutors({ mode: 'room', executors: 1 })).toBe(2);
    expect(clampExecutors({ mode: 'room' })).toBe(2);
  });

  it('respects an explicit max', () => {
    expect(clampExecutors({ mode: 'room', executors: 5 }, 6)).toBe(5);
    expect(clampExecutors({ mode: 'room', executors: 5 }, 3)).toBe(3);
  });
});

describe('planRoomWorkItems', () => {
  it('produces exactly `count` items using the decomposition', () => {
    const plan: ExecutionPlan = {
      mode: 'room',
      executors: 3,
      decomposition: ['frontend', 'backend', 'tests'],
    };
    expect(planRoomWorkItems(plan, 3)).toEqual([
      { index: 0, task: 'frontend' },
      { index: 1, task: 'backend' },
      { index: 2, task: 'tests' },
    ]);
  });

  it('falls back to numbered sub-tasks for missing/short decomposition', () => {
    const plan: ExecutionPlan = { mode: 'room', executors: 2 };
    expect(planRoomWorkItems(plan, 3)).toEqual([
      { index: 0, task: 'Sub-task 1' },
      { index: 1, task: 'Sub-task 2' },
      { index: 2, task: 'Sub-task 3' },
    ]);
  });

  it('fills the gap after a short decomposition', () => {
    const plan: ExecutionPlan = {
      mode: 'room',
      executors: 3,
      decomposition: ['only'],
    };
    expect(planRoomWorkItems(plan, 3)).toEqual([
      { index: 0, task: 'only' },
      { index: 1, task: 'Sub-task 2' },
      { index: 2, task: 'Sub-task 3' },
    ]);
  });
});