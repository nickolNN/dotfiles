import { describe, expect, it } from 'vitest';

import {
  DEFAULT_MAX_EXECUTORS,
  executionPlanProblem,
  maxExecutorsFor,
  parseExecutionPlan,
  planExecutionMode,
  planExecutionStages,
  stageLabel,
} from '../src/execution';
import type { ExecutionPlan } from '../src/types';

describe('parseExecutionPlan', () => {
  it('parses a minimal single plan without optional fields', () => {
    expect(parseExecutionPlan({ mode: 'single' })).toEqual({ mode: 'single' });
  });

  it('treats the retired room mode as unreadable, not as a plan', () => {
    expect(parseExecutionPlan({ mode: 'room' })).toBeNull();
    expect(
      parseExecutionPlan({
        mode: 'room',
        executors: 3,
        decomposition: ['a', 'b', 'c'],
      }),
    ).toBeNull();
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

  it('положительное целое → оно же; потолок остаётся только для невалидного', () => {
    expect(maxExecutorsFor(1)).toBe(1);
    expect(maxExecutorsFor(3)).toBe(3);
    expect(maxExecutorsFor(6)).toBe(6);
    expect(maxExecutorsFor(10)).toBe(10);
    expect(maxExecutorsFor(0)).toBe(DEFAULT_MAX_EXECUTORS);
  });
});

describe('executionPlanProblem — worker_count как потолок плана', () => {
  it('этап выше лимита — ошибка, число этапов не ограничено', () => {
    const tooWide: ExecutionPlan = {
      mode: 'stages',
      stages: [{ index: 1, executors: 3 }, { index: 2 }],
    };
    expect(executionPlanProblem(tooWide, 2)).toContain(
      'stage at position 1 of 2 declares 3 parallel executors',
    );

    const manyStages: ExecutionPlan = {
      mode: 'stages',
      stages: Array.from({ length: 8 }, (_, i) => ({ index: i + 1 })),
    };
    expect(executionPlanProblem(manyStages, 1)).toBeNull();
  });

  it('single валиден при любом лимите', () => {
    expect(executionPlanProblem({ mode: 'single' }, 1)).toBeNull();
  });

  it('stages без объявленных этапов — ошибка планировщика, не тихий single', () => {
    expect(executionPlanProblem({ mode: 'stages' }, 2)).toContain(
      'no valid stages',
    );
    expect(executionPlanProblem({ mode: 'stages', stages: [] }, 2)).toContain(
      'no valid stages',
    );
  });

  it('stages с верхнеуровневыми executors или decomposition отклоняется', () => {
    const stages = [{ index: 1, executors: 2 }];
    const executorsOnly =
      'mode stages declares top-level executors — a staged plan declares them per stage';
    const decompositionOnly =
      'mode stages declares top-level decomposition — a staged plan declares them per stage';
    const both =
      'mode stages declares top-level executors and decomposition — a staged plan declares them per stage';

    expect(
      executionPlanProblem(
        parseExecutionPlan({ mode: 'stages', executors: 99, stages }),
        4,
      ),
    ).toBe(executorsOnly);
    expect(
      executionPlanProblem(
        parseExecutionPlan({ mode: 'stages', decomposition: ['a', 'b'], stages }),
        4,
      ),
    ).toBe(decompositionOnly);
    expect(
      executionPlanProblem(
        parseExecutionPlan({ mode: 'stages', decomposition: 'a,b', stages }),
        4,
      ),
    ).toBe(decompositionOnly);
    expect(
      executionPlanProblem(
        parseExecutionPlan({
          mode: 'stages',
          executors: 99,
          decomposition: 'a,b',
          stages,
        }),
        4,
      ),
    ).toBe(both);
  });

  it('не-массивный верхнеуровневый decomposition назван по имени, а не executors', () => {
    const problem = executionPlanProblem(
      parseExecutionPlan({
        mode: 'stages',
        decomposition: 'abc',
        stages: [{ index: 1 }],
      }),
      4,
    );

    expect(problem).toContain('top-level decomposition');
    expect(problem).not.toContain('executors');
  });

  it('single с не-массивным decomposition — отказ, а не тихий single', () => {
    expect(executionPlanProblem(parseExecutionPlan({ mode: 'single' }), 4)).toBeNull();
    expect(
      executionPlanProblem(
        parseExecutionPlan({ mode: 'single', decomposition: 5 }),
        4,
      ),
    ).toBe(
      'mode single declares malformed decomposition — a list of sub-tasks is required',
    );
  });

  it('stages без верхнеуровневых исполнителей валиден (null и absent равны)', () => {
    expect(
      executionPlanProblem(
        parseExecutionPlan({
          mode: 'stages',
          executors: null,
          decomposition: null,
          stages: [{ index: 1, executors: 2 }, { index: 2 }],
        }),
        4,
      ),
    ).toBeNull();
  });

  it('стадия с лишними пунктами decomposition отклоняется, а не обрезается', () => {
    const parsed = parseExecutionPlan({
      mode: 'stages',
      stages: [{ index: 1, executors: 2, decomposition: ['a', 'b', 'c', 'd'] }],
    });

    expect(executionPlanProblem(parsed, 4)).toBe(
      'stage at position 1 of 1 declares 4 decomposition entries for 2 executors — a wave has one sub-task per executor',
    );
  });

  it('стадия с недостающими пунктами decomposition отклоняется, а не добивается выдумкой', () => {
    const parsed = parseExecutionPlan({
      mode: 'stages',
      stages: [{ index: 1, executors: 2, decomposition: ['a'] }],
    });

    expect(executionPlanProblem(parsed, 4)).toBe(
      'stage at position 1 of 1 declares 1 decomposition entry for 2 executors — a wave has one sub-task per executor',
    );
  });

  it('стадия с пунктами decomposition при одном исполнителе отклоняется', () => {
    const parsed = parseExecutionPlan({
      mode: 'stages',
      stages: [{ index: 2, task: 'real', decomposition: ['a', 'b'] }, { index: 3 }],
    });

    expect(executionPlanProblem(parsed, 4)).toBe(
      'stage at position 1 of 2 declares 2 decomposition entries for 1 executor — a wave has one sub-task per executor',
    );
  });

  it('все стадии кривые — сообщение называет первую, а не «no valid stages»', () => {
    expect(
      executionPlanProblem(
        {
          mode: 'stages',
          stages: [{ index: 2.5 } as never, { index: 4.5 } as never],
        },
        2,
      ),
    ).toBe(
      'stage at position 1 of 2 is malformed (index, executors and decomposition must be well-formed)',
    );
  });

  it('один этап с одним исполнителем — это single, план отклоняется', () => {
    expect(
      executionPlanProblem({ mode: 'stages', stages: [{ index: 1 }] }, 2),
    ).toContain('is `single`');
    expect(
      executionPlanProblem(
        { mode: 'stages', stages: [{ index: 1, executors: 1 }] },
        4,
      ),
    ).toContain('is `single`');
  });

  it('один этап с 2+ исполнителями валиден в пределах лимита', () => {
    expect(
      executionPlanProblem(
        { mode: 'stages', stages: [{ index: 1, executors: 2 }] },
        2,
      ),
    ).toBeNull();
    expect(
      executionPlanProblem(
        { mode: 'stages', stages: [{ index: 1, executors: 3 }] },
        2,
      ),
    ).toContain('stage at position 1 of 1 declares 3 parallel executors');
  });

  it('кривая стадия — ошибка с позицией, а не тихое исполнение остальных', () => {
    expect(
      executionPlanProblem(
        {
          mode: 'stages',
          stages: [{ index: 1 }, { index: 1.5 } as never, { index: 3 }],
        },
        4,
      ),
    ).toContain('stage at position 2 of 3 is malformed');
    expect(
      executionPlanProblem(
        { mode: 'stages', stages: [{ index: 1 }, { index: 2, executors: 0 }] },
        4,
      ),
    ).toContain('stage at position 2 of 2 is malformed');
    expect(
      executionPlanProblem(
        { mode: 'stages', stages: [{ index: 1 }, 'nope' as never] },
        4,
      ),
    ).toContain('stage at position 2 of 2 is malformed');
    expect(
      executionPlanProblem(
        {
          mode: 'stages',
          stages: [
            { index: 1, decomposition: 'a,b' as never },
            { index: 2, task: 'real' },
          ],
        },
        4,
      ),
    ).toContain('stage at position 1 of 2 is malformed');
  });

  it('превышение исполнителей называет позицию в объявленном массиве', () => {
    const parsed = parseExecutionPlan({
      mode: 'stages',
      stages: [{ index: 5 }, { index: 1, executors: 9 }],
    });

    expect(executionPlanProblem(parsed, 2)).toBe(
      'stage at position 2 of 2 declares 9 parallel executors, but at most 2 may run at the same time',
    );
  });

  it('malformed называет позицию: собственный index может быть сломанным полем', () => {
    const parsed = parseExecutionPlan({
      mode: 'stages',
      stages: [
        { index: 5, executors: 2 },
        { index: 2.5 },
        { index: 3, executors: 2 },
      ],
    });

    expect(executionPlanProblem(parsed, 4)).toContain(
      'stage at position 2 of 3 is malformed',
    );
  });

  it('разобранный отчёт с кривой стадией тоже отклоняется', () => {
    const parsed = parseExecutionPlan({
      mode: 'stages',
      stages: [
        { index: 1, executors: 2 },
        { index: 2.5, task: 'non-int index' },
        { index: 3, task: 'real' },
      ],
    });

    expect(executionPlanProblem(parsed, 4)).toContain(
      'stage at position 2 of 3 is malformed',
    );
  });

  it('стадия со строковым executors отклоняется, а не исполняется одним агентом', () => {
    const parsed = parseExecutionPlan({
      mode: 'stages',
      stages: [
        { index: 1, executors: '3', decomposition: ['a', 'b', 'c'] },
        { index: 2 },
      ],
    });

    expect(executionPlanProblem(parsed, 4)).toBe(
      'stage at position 1 of 2 is malformed (index, executors and decomposition must be well-formed)',
    );
  });

  it('стадия с дробным executors отклоняется с позицией', () => {
    const parsed = parseExecutionPlan({
      mode: 'stages',
      stages: [{ index: 1, executors: 9.5 }],
    });

    expect(executionPlanProblem(parsed, 4)).toBe(
      'stage at position 1 of 1 is malformed (index, executors and decomposition must be well-formed)',
    );
  });

  it('single с нечисловым или дробным executors — отказ, а не подставленная единица', () => {
    for (const executors of ['9', 9.5]) {
      const parsed = parseExecutionPlan({ mode: 'single', executors });

      expect(executionPlanProblem(parsed, 4)).toBe(
        'mode single declares malformed executors — a whole number of at least 1 is required',
      );
    }
  });

  it('целые исполнители в разобранном плане остаются валидными', () => {
    expect(
      executionPlanProblem(parseExecutionPlan({ mode: 'single' }), 4),
    ).toBeNull();
    expect(
      executionPlanProblem(
        parseExecutionPlan({
          mode: 'stages',
          stages: [{ index: 1, executors: 2 }, { index: 2 }],
        }),
        4,
      ),
    ).toBeNull();
  });

  it('single с исполнителями или декомпозицией — ошибка планировщика', () => {
    expect(executionPlanProblem({ mode: 'single', executors: 9 }, 4)).toBe(
      'mode single declares 9 executors — single means one executor, use mode stages for a wave',
    );
    expect(
      executionPlanProblem({ mode: 'single', decomposition: ['a', 'b'] }, 4),
    ).toBe(
      'mode single declares 2 decomposition entries — single means one executor, use mode stages for a wave',
    );
    expect(
      executionPlanProblem({ mode: 'single', executors: 1 }, 4),
    ).toBeNull();
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

  it('keeps every declared stage so a malformed one is reported, not dropped', () => {
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
          { index: 4, decomposition: 'a,b' },
        ],
      }),
    ).toEqual({
      mode: 'stages',
      stages: [
        { index: 1, executors: 2, decompositionMalformed: true },
        { index: 0 },
        { index: 0, task: 'no index' },
        { index: 2.5, task: 'non-int index' },
        { index: 2, executors: 0 },
        { index: 3, task: 'real' },
        { index: 4, decompositionMalformed: true },
      ],
    });
  });

  it('нестроковый или пустой пункт decomposition делает стадию кривой, а не вычёркивается', () => {
    const single = parseExecutionPlan({
      mode: 'single',
      decomposition: [7, { a: 1 }],
    });
    expect(single).toEqual({ mode: 'single', decompositionMalformed: true });
    expect(executionPlanProblem(single, 4)).toBe(
      'mode single declares malformed decomposition — a list of sub-tasks is required',
    );

    const stages = parseExecutionPlan({
      mode: 'stages',
      stages: [{ index: 1, executors: 2, decomposition: ['ok', 7] }],
    });
    expect(executionPlanProblem(stages, 4)).toBe(
      'stage at position 1 of 1 is malformed (index, executors and decomposition must be well-formed)',
    );
  });

  it('пустой массив decomposition объявляет не больше, чем его отсутствие', () => {
    expect(
      parseExecutionPlan({ mode: 'single', decomposition: [] }),
    ).toEqual({ mode: 'single' });
    expect(
      executionPlanProblem(
        parseExecutionPlan({
          mode: 'stages',
          decomposition: [],
          stages: [{ index: 1, executors: 2, decomposition: ['a', 'b'] }],
        }),
        4,
      ),
    ).toBeNull();
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

  it('stages with one valid stage → stages (one parallel wave)', () => {
    expect(
      planExecutionMode({
        mode: 'stages',
        stages: [{ index: 1, executors: 2 }],
      }),
    ).toBe('stages');
  });

  it('stages with no valid stages → single', () => {
    expect(planExecutionMode({ mode: 'stages', stages: [] })).toBe('single');
    expect(planExecutionMode({ mode: 'stages' })).toBe('single');
    expect(
      planExecutionMode({
        mode: 'stages',
        stages: ['x', { index: 2.5 }],
      }),
    ).toBe('single');
  });
});

describe('planExecutionStages', () => {
  const UNCAPPED = 1000;

  it('returns [] when not staged or when no stage is valid', () => {
    expect(planExecutionStages(null, UNCAPPED)).toEqual([]);
    expect(planExecutionStages(undefined, UNCAPPED)).toEqual([]);
    expect(planExecutionStages({ mode: 'single' }, UNCAPPED)).toEqual([]);
    expect(planExecutionStages({ mode: 'room' }, UNCAPPED)).toEqual([]);
    expect(planExecutionStages({ mode: 'stages' }, UNCAPPED)).toEqual([]);
    expect(
      planExecutionStages(
        { mode: 'stages', stages: [{ index: 1.5 }] },
        UNCAPPED,
      ),
    ).toEqual([]);
  });

  it('keeps a single valid stage without inventing sub-tasks', () => {
    expect(
      planExecutionStages(
        {
          mode: 'stages',
          stages: [{ index: 7, executors: 2 }],
        },
        UNCAPPED,
      ),
    ).toEqual([
      {
        index: 1,
        name: 'Этап 1',
        task: 'Stage 1',
        executors: 2,
        decomposition: [],
      },
    ]);
  });

  it('renumbers 1..N and fills name/task fallbacks, keeping declared entries', () => {
    const stages = planExecutionStages(
      {
        mode: 'stages',
        stages: [
          { index: 5, executors: 2, decomposition: ['a', 'b'] },
          { index: 9, name: 'Build', task: 'build it', executors: 1 },
        ],
      },
      UNCAPPED,
    );

    expect(stages).toEqual([
      {
        index: 1,
        name: 'Этап 1',
        task: 'Stage 1',
        executors: 2,
        decomposition: ['a', 'b'],
      },
      {
        index: 2,
        name: 'Build',
        task: 'build it',
        executors: 1,
        decomposition: [],
      },
    ]);
  });

  it('clamps executors to [1..max] without filling decomposition', () => {
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
      decomposition: [],
    });
    expect(stages[1]).toEqual({
      index: 2,
      name: 'Этап 2',
      task: 'Stage 2',
      executors: 1,
      decomposition: [],
    });
  });

  it('leaves executors untouched when the cap is above the declared count', () => {
    const stages = planExecutionStages(
      {
        mode: 'stages',
        stages: [{ index: 1, executors: 3, decomposition: ['a', 'b', 'c'] }],
      },
      8,
    );

    expect(stages).toEqual([
      {
        index: 1,
        name: 'Этап 1',
        task: 'Stage 1',
        executors: 3,
        decomposition: ['a', 'b', 'c'],
      },
    ]);
  });

  it('drops invalid entries, keeping the valid ones', () => {
    expect(
      planExecutionStages(
        {
          mode: 'stages',
          stages: [{ index: 1, executors: 2 }, 'x', { index: 2.5 }],
        },
        UNCAPPED,
      ),
    ).toHaveLength(1);
    expect(
      planExecutionStages(
        {
          mode: 'stages',
          stages: ['x', { index: 2.5 }],
        },
        UNCAPPED,
      ),
    ).toEqual([]);
  });
});

describe('stageLabel', () => {
  it('returns a declared name without surrounding whitespace', () => {
    expect(stageLabel('  Сбор  ', 3)).toBe('Сбор');
  });

  it('numbers the fallback label for absent, empty and blank names', () => {
    expect(stageLabel(undefined, 1)).toBe('Этап 1');
    expect(stageLabel(null, 2)).toBe('Этап 2');
    expect(stageLabel('   ', 3)).toBe('Этап 3');
  });

  it('covers a non-string name through the plan parser', () => {
    const stages = planExecutionStages(
      {
        mode: 'stages',
        stages: [{ index: 1, name: 42 as never, executors: 2 }],
      },
      1000,
    );

    expect(stages[0]?.name).toBe('Этап 1');
  });

  it('is the label normalization uses, numbered by position', () => {
    const stages = planExecutionStages(
      {
        mode: 'stages',
        stages: [{ index: 9, name: '  ', executors: 2 }],
      },
      1000,
    );

    expect(stages[0]?.name).toBe('Этап 1');
  });
});