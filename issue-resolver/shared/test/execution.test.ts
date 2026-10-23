import { describe, expect, it } from 'vitest';

import {
  clampExecutors,
  DEFAULT_MAX_ROOM_EXECUTORS,
  maxExecutorsFor,
  parseExecutionPlan,
  planExecutionMode,
  planExecutionStages,
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

describe('maxExecutorsFor — worker_count как потолок движка', () => {
  it('0/undefined/null/невалидное («без ограничений») → системный потолок', () => {
    expect(maxExecutorsFor(undefined)).toBe(DEFAULT_MAX_ROOM_EXECUTORS);
    expect(maxExecutorsFor(null)).toBe(DEFAULT_MAX_ROOM_EXECUTORS);
    expect(maxExecutorsFor(0)).toBe(DEFAULT_MAX_ROOM_EXECUTORS);
    expect(maxExecutorsFor(-3)).toBe(DEFAULT_MAX_ROOM_EXECUTORS);
    expect(maxExecutorsFor(2.5)).toBe(DEFAULT_MAX_ROOM_EXECUTORS);
  });

  it('положительное целое → оно же, но не выше системного потолка', () => {
    expect(maxExecutorsFor(1)).toBe(1);
    expect(maxExecutorsFor(3)).toBe(3);
    expect(maxExecutorsFor(10)).toBe(DEFAULT_MAX_ROOM_EXECUTORS);
  });
});

describe('planExecutionMode — потолок из worker_count', () => {
  it('room с потолком < 2 деградирует в single (параллельности нет)', () => {
    const plan: ExecutionPlan = { mode: 'room', executors: 2 };
    expect(planExecutionMode(plan, maxExecutorsFor(1))).toBe('single');
    expect(planExecutionMode(plan, maxExecutorsFor(2))).toBe('room');
  });

  it('stages живёт и с потолком 1, но режет исполнителей этапа', () => {
    const plan: ExecutionPlan = {
      mode: 'stages',
      stages: [
        { index: 1, executors: 4 },
        { index: 2, executors: 4 },
      ],
    };
    expect(planExecutionMode(plan, maxExecutorsFor(1))).toBe('stages');
    expect(
      planExecutionStages(plan, maxExecutorsFor(1)).map((s) => s.executors),
    ).toEqual([1, 1]);
    expect(
      planExecutionStages(plan, maxExecutorsFor(2)).map((s) => s.executors),
    ).toEqual([2, 2]);
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

describe('parseExecutionPlan — stages', () => {
  it('parses a valid staged plan', () => {
    expect(
      parseExecutionPlan({
        mode: 'stages',
        stages: [
          {
            index: 1,
            name: 'Сбор',
            task: 'собрать',
            executors: 2,
            decomposition: ['a', 'b'],
          },
          { index: 2, task: 'починить' },
        ],
        rationale: 'два этапа',
      }),
    ).toEqual({
      mode: 'stages',
      stages: [
        {
          index: 1,
          name: 'Сбор',
          task: 'собрать',
          executors: 2,
          decomposition: ['a', 'b'],
        },
        { index: 2, task: 'починить' },
      ],
      rationale: 'два этапа',
    });
  });

  it('drops invalid stage entries and garbage fields', () => {
    expect(
      parseExecutionPlan({
        mode: 'stages',
        stages: [
          { index: 1, name: '', executors: 2, decomposition: ['ok', '', 7] },
          'nope',
          { task: 'no index' },
          { index: 2.5, task: 'non-int index' },
          { index: 2, executors: 0 },
          { index: 3, task: 'real' },
        ],
      }),
    ).toEqual({
      mode: 'stages',
      stages: [
        { index: 1, executors: 2, decomposition: ['ok'] },
        { index: 3, task: 'real' },
      ],
    });
  });

  it('keeps a single-stage plan (degradation decided by planExecutionMode)', () => {
    expect(
      parseExecutionPlan({ mode: 'stages', stages: [{ index: 1 }] }),
    ).toEqual({ mode: 'stages', stages: [{ index: 1 }] });
  });
});

describe('planExecutionMode — stages', () => {
  it('stages with 2+ valid stages → stages', () => {
    expect(
      planExecutionMode({ mode: 'stages', stages: [{ index: 1 }, { index: 2 }] }),
    ).toBe('stages');
  });

  it('stages with fewer than 2 valid stages → single', () => {
    expect(planExecutionMode({ mode: 'stages', stages: [{ index: 1 }] })).toBe(
      'single',
    );
    expect(planExecutionMode({ mode: 'stages', stages: [] })).toBe('single');
    expect(planExecutionMode({ mode: 'stages' })).toBe('single');
    expect(
      planExecutionMode({
        mode: 'stages',
        stages: [{ index: 1 }, { index: 2.5 }],
      }),
    ).toBe('single');
  });
});

describe('planExecutionStages', () => {
  it('returns [] when not staged or fewer than 2 valid stages', () => {
    expect(planExecutionStages(null)).toEqual([]);
    expect(planExecutionStages(undefined)).toEqual([]);
    expect(planExecutionStages({ mode: 'single' })).toEqual([]);
    expect(planExecutionStages({ mode: 'room' })).toEqual([]);
    expect(
      planExecutionStages({ mode: 'stages', stages: [{ index: 1 }] }),
    ).toEqual([]);
    expect(planExecutionStages({ mode: 'stages' })).toEqual([]);
  });

  it('renumbers 1..N and fills name/task/decomposition fallbacks', () => {
    const stages = planExecutionStages({
      mode: 'stages',
      stages: [
        { index: 5, executors: 2, decomposition: ['a'] },
        { index: 9, name: 'Build', task: 'build it', executors: 1 },
      ],
    });

    expect(stages).toEqual([
      {
        index: 1,
        name: 'Этап 1',
        task: 'Stage 1',
        executors: 2,
        decomposition: ['a', 'Sub-task 2'],
      },
      {
        index: 2,
        name: 'Build',
        task: 'build it',
        executors: 1,
        decomposition: ['Sub-task 1'],
      },
    ]);
  });

  it('clamps executors to [1..max] and backfills decomposition', () => {
    const stages = planExecutionStages(
      {
        mode: 'stages',
        stages: [
          { index: 1, executors: 99, decomposition: [] },
          { index: 2, executors: 0 },
          { index: 3 },
        ],
      },
      3,
    );

    expect(stages).toHaveLength(2);
    expect(stages[0]).toEqual({
      index: 1,
      name: 'Этап 1',
      task: 'Stage 1',
      executors: 3,
      decomposition: ['Sub-task 1', 'Sub-task 2', 'Sub-task 3'],
    });
    expect(stages[1]).toEqual({
      index: 2,
      name: 'Этап 2',
      task: 'Stage 2',
      executors: 1,
      decomposition: ['Sub-task 1'],
    });
  });

  it('drops invalid entries before counting the 2-stage minimum', () => {
    expect(
      planExecutionStages({
        mode: 'stages',
        stages: [{ index: 1 }, 'x', { index: 2.5 }],
      }),
    ).toEqual([]);
  });
});