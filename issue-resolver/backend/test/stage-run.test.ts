import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NormalizedStage } from '@issue-resolver/shared';
import { afterEach, describe, expect, it } from 'vitest';
import {
  claimStageRun,
  clearStageFiles,
  readStageRun,
  stagePlanSignature,
} from '../src/workflow/stage-run';

const MANIFEST = '.issue-stage-manifest.json';
const dirs: string[] = [];

function makeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'stage-run-'));
  dirs.push(dir);
  return dir;
}

function stageFile(dir: string, index: number): string {
  const name = `.issue-stage-${index}.json`;
  writeFileSync(join(dir, name), JSON.stringify({ stage: index, ok: true }));
  return name;
}

function stageFiles(dir: string): string[] {
  return readdirSync(dir)
    .filter((name) => name.startsWith('.issue-stage-') && name !== MANIFEST)
    .sort();
}

function stages(over: Partial<NormalizedStage> = {}): NormalizedStage[] {
  return [
    {
      index: 1,
      name: 'Разведка',
      task: 'собрать контекст',
      executors: 1,
      decomposition: [],
      ...over,
    },
  ];
}

afterEach(() => {
  while (dirs.length > 0) {
    rmSync(dirs.pop() as string, { recursive: true, force: true });
  }
});

describe('claimStageRun — чьи исходы этапов можно резюмить', () => {
  it('пустая папка: резюм разрешён, манифест создан', () => {
    const dir = makeDir();
    const plan = stagePlanSignature(stages());

    expect(claimStageRun(dir, 'iteration-1', plan, 1)).toBe(true);
    expect(readStageRun(dir)).toEqual({
      iterationId: 'iteration-1',
      plan,
      stages: 1,
    });
    expect(stageFiles(dir)).toEqual([]);
  });

  it('та же итерация и тот же план: резюм разрешён, файлы целы', () => {
    const dir = makeDir();
    const plan = stagePlanSignature(stages());
    claimStageRun(dir, 'iteration-1', plan, 1);
    stageFile(dir, 1);
    writeFileSync(join(dir, 'MEMORY.md'), 'stage notes');

    expect(claimStageRun(dir, 'iteration-1', plan, 1)).toBe(true);
    expect(stageFiles(dir)).toEqual(['.issue-stage-1.json']);
    expect(existsSync(join(dir, 'MEMORY.md'))).toBe(true);
  });

  it('другая итерация: резюм запрещён, старые исходы удалены, манифест переписан', () => {
    const dir = makeDir();
    const plan = stagePlanSignature(stages());
    claimStageRun(dir, 'iteration-1', plan, 1);
    stageFile(dir, 1);
    stageFile(dir, 2);
    writeFileSync(join(dir, 'report.md'), 'artifact');
    const nextPlan = stagePlanSignature(stages({ name: 'Реализация' }));

    expect(claimStageRun(dir, 'iteration-2', nextPlan, 1)).toBe(false);
    expect(stageFiles(dir)).toEqual([]);
    expect(existsSync(join(dir, 'report.md'))).toBe(true);
    expect(readStageRun(dir)).toEqual({
      iterationId: 'iteration-2',
      plan: nextPlan,
      stages: 1,
    });
  });

  it('та же итерация, но план пересобран: резюм запрещён, исходы удалены', () => {
    const dir = makeDir();
    const plan = stagePlanSignature(stages());
    claimStageRun(dir, 'iteration-1', plan, 1);
    stageFile(dir, 1);

    const replanned = stagePlanSignature(
      stages({ executors: 3, decomposition: ['module-a', 'module-b'] }),
    );
    expect(claimStageRun(dir, 'iteration-1', replanned, 1)).toBe(false);
    expect(stageFiles(dir)).toEqual([]);
    expect(readStageRun(dir)?.plan).toBe(replanned);
  });

  it('легаси-папка без манифеста: файлы доверяются один раз, манифест создан', () => {
    const dir = makeDir();
    stageFile(dir, 1);
    const plan = stagePlanSignature(stages());

    expect(claimStageRun(dir, 'iteration-1', plan, 1)).toBe(true);
    expect(stageFiles(dir)).toEqual(['.issue-stage-1.json']);
    expect(readStageRun(dir)?.iterationId).toBe('iteration-1');
  });

  it('битый манифест читается как отсутствующий', () => {
    const broken = makeDir();
    writeFileSync(join(broken, MANIFEST), '{ not json');
    const empty = makeDir();
    writeFileSync(join(empty, MANIFEST), JSON.stringify({ foo: 1 }));
    const plan = stagePlanSignature(stages());

    expect(readStageRun(broken)).toBeNull();
    expect(readStageRun(empty)).toBeNull();
    stageFile(broken, 1);
    expect(claimStageRun(broken, 'iteration-1', plan, 1)).toBe(true);
    expect(stageFiles(broken)).toEqual(['.issue-stage-1.json']);
  });
});

describe('clearStageFiles', () => {
  it('удаляет только файлы этапов и не трогает манифест', () => {
    const dir = makeDir();
    stageFile(dir, 1);
    stageFile(dir, 2);
    writeFileSync(join(dir, MANIFEST), '{}');
    writeFileSync(join(dir, '.issue-step-result.json'), '{}');
    writeFileSync(join(dir, 'plan.md'), '# plan');

    clearStageFiles(dir);

    expect(stageFiles(dir)).toEqual([]);
    expect(readdirSync(dir).sort()).toEqual([
      '.issue-stage-manifest.json',
      '.issue-step-result.json',
      'plan.md',
    ]);
  });

  it('несуществующая папка не бросает', () => {
    expect(() => clearStageFiles(join(makeDir(), 'missing'))).not.toThrow();
  });
});

describe('stagePlanSignature — подпись формы плана', () => {
  it('одинаковые этапы дают одинаковую подпись', () => {
    expect(stagePlanSignature(stages())).toBe(stagePlanSignature(stages()));
  });

  it('меняет подпись при смене name, executors и decomposition', () => {
    const base = stagePlanSignature(stages());
    expect(stagePlanSignature(stages({ name: 'Реализация' }))).not.toBe(base);
    expect(stagePlanSignature(stages({ executors: 2 }))).not.toBe(base);
    expect(
      stagePlanSignature(stages({ decomposition: ['module-a'] })),
    ).not.toBe(base);
  });

  it('меняет подпись при смене порядка или количества этапов', () => {
    const one = stages();
    const two = [...stages(), { ...stages()[0], index: 2, name: 'Тесты' }];
    expect(stagePlanSignature(two)).not.toBe(stagePlanSignature(one));
    expect(stagePlanSignature([...two].reverse())).not.toBe(
      stagePlanSignature(two),
    );
  });

  it('учитывает текст задачи целиком, включая хвостовой пробел', () => {
    expect(stagePlanSignature(stages({ task: 'собрать контекст ' }))).not.toBe(
      stagePlanSignature(stages()),
    );
  });
});