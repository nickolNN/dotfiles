import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readExpandedPlan } from '../src/workflow/engine';

describe('readExpandedPlan', () => {
  let dir = '';

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'plan-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('отдаёт plan.md целиком — исполнитель получает развёрнутый бриф', async () => {
    writeFileSync(join(dir, 'plan.md'), '# Plan\n\nРешение D1: ...\n');
    await expect(readExpandedPlan(dir)).resolves.toEqual({
      text: '# Plan\n\nРешение D1: ...',
      truncated: false,
    });
  });

  it('нет plan.md → null, шаг не падает и остаётся summary', async () => {
    await expect(readExpandedPlan(dir)).resolves.toBeNull();
  });

  it('пустой plan.md → null, а не пустая строка в промпте', async () => {
    writeFileSync(join(dir, 'plan.md'), '   \n\n\t');
    await expect(readExpandedPlan(dir)).resolves.toBeNull();
  });

  it('длинный plan.md обрезается и помечается как обрезанный', async () => {
    writeFileSync(join(dir, 'plan.md'), 'x'.repeat(20_000));
    const plan = await readExpandedPlan(dir);

    expect(plan?.truncated).toBe(true);
    expect(plan?.text.length).toBe(12_000);
  });

  it('ровно на границе — ещё не обрезан', async () => {
    writeFileSync(join(dir, 'plan.md'), 'x'.repeat(12_000));
    const plan = await readExpandedPlan(dir);

    expect(plan?.truncated).toBe(false);
    expect(plan?.text.length).toBe(12_000);
  });

  it('plan.md — каталог → null, чужой файл мимо', async () => {
    mkdirSync(join(dir, 'plan.md'), { recursive: true });
    await expect(readExpandedPlan(dir)).resolves.toBeNull();
  });
});