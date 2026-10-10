import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  PipelineStep,
  SessionEvent,
  SessionStats,
} from '@issue-resolver/shared';
import Database from 'better-sqlite3';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { createDb } from '../src/db/client';
import type { Db } from '../src/db/client';
import { issues, iterations, stepOutputs, stepRuns } from '../src/db/schema';
import {
  createStepOutput,
  createStepRun,
  getStepRun,
  listStepRunsByIteration,
  listStepRunsWithLog,
  updateStepRun,
} from '../src/db/step-runs.repo';

function makeDb(): Db {
  return createDb(':memory:');
}

/** Прямой insert issue + iteration #1 (без HTTP-слоя). */
function seedIteration(db: Db, steps: PipelineStep[] = ['resolve', 'review', 'test']): string {
  const now = new Date().toISOString();
  const issueId = randomUUID();
  const iterationId = randomUUID();

  db.insert(issues)
    .values({
      id: issueId,
      title: 'Тестовая задача',
      jira_issue_url: null,
      pipeline_steps: steps,
      container_name: null,
      status: 'pending',
      created_at: now,
      updated_at: now,
    })
    .run();

  db.insert(iterations)
    .values({
      id: iterationId,
      issue_id: issueId,
      number: 1,
      context: 'seed',
      steps,
      status: 'pending',
      created_at: now,
      updated_at: now,
    })
    .run();

  return iterationId;
}

describe('createStepRun', () => {
  it('создаёт run со status pending, feedback null, и он реально лежит в БД', async () => {
    const db = makeDb();
    const iterationId = seedIteration(db);

    const run = await createStepRun(db, {
      iterationId,
      step: 'resolve',
      attempt: 1,
      context: 'исправить баг',
    });

    expect(run.id).toBeTruthy();
    expect(run.iteration_id).toBe(iterationId);
    expect(run.step).toBe('resolve');
    expect(run.attempt).toBe(1);
    expect(run.status).toBe('pending');
    expect(run.feedback).toBeNull();
    expect(run.context).toBe('исправить баг');
    expect(run.created_at).toBe(run.updated_at);

    const stored = db.select().from(stepRuns).where(eq(stepRuns.id, run.id)).get();
    expect(stored).toBeDefined();
    expect(stored?.status).toBe('pending');
    expect(stored?.feedback).toBeNull();
    expect(stored?.context).toBe('исправить баг');
  });
});

describe('listStepRunsByIteration', () => {
  it('шаги в порядке конвейера, внутри шага attempt ASC', async () => {
    const db = makeDb();
    const iterationId = seedIteration(db);

    await createStepRun(db, { iterationId, step: 'resolve', attempt: 1, context: 'r1' });
    await createStepRun(db, { iterationId, step: 'review', attempt: 1, context: 'v1' });
    await createStepRun(db, { iterationId, step: 'resolve', attempt: 2, context: 'r2' });
    await createStepRun(db, { iterationId, step: 'test', attempt: 1, context: 't1' });

    const list = await listStepRunsByIteration(db, iterationId);

    expect(list.map((run) => `${run.step}#${run.attempt}`)).toEqual([
      'resolve#1',
      'resolve#2',
      'review#1',
      'test#1',
    ]);
  });

  it('пустая итерация → пустой массив', async () => {
    const db = makeDb();
    const iterationId = seedIteration(db);

    expect(await listStepRunsByIteration(db, iterationId)).toEqual([]);
  });
});

describe('updateStepRun', () => {
  it('обновляет status и feedback, затем status без затирания feedback', async () => {
    const db = makeDb();
    const iterationId = seedIteration(db);
    const run = await createStepRun(db, {
      iterationId,
      step: 'review',
      attempt: 1,
      context: 'ctx',
    });

    const updated = await updateStepRun(db, run.id, {
      status: 'success',
      feedback: 'выглядит хорошо',
    });

    expect(updated.status).toBe('success');
    expect(updated.feedback).toBe('выглядит хорошо');

    const again = await updateStepRun(db, run.id, { status: 'running' });

    expect(again.status).toBe('running');
    expect(again.feedback).toBe('выглядит хорошо');

    const stored = db.select().from(stepRuns).where(eq(stepRuns.id, run.id)).get();
    expect(stored?.status).toBe('running');
    expect(stored?.feedback).toBe('выглядит хорошо');
  });
});

describe('getStepRun', () => {
  it('несуществующий id → null', async () => {
    const db = makeDb();

    expect(await getStepRun(db, randomUUID())).toBeNull();
  });

  it('существующий id → строка', async () => {
    const db = makeDb();
    const iterationId = seedIteration(db);
    const run = await createStepRun(db, {
      iterationId,
      step: 'resolve',
      attempt: 1,
      context: 'ctx',
    });

    const found = await getStepRun(db, run.id);
    expect(found?.id).toBe(run.id);
  });
});

describe('createStepOutput', () => {
  it('пишет step_run_id, отдаёт StepOutput и запрещает дубль по stepRunId', async () => {
    const db = makeDb();
    const iterationId = seedIteration(db);
    const run = await createStepRun(db, {
      iterationId,
      step: 'test',
      attempt: 1,
      context: 'ctx',
    });

    const report = JSON.stringify({ status: 'pass', summary: 'всё зелёное' });
    const output = await createStepOutput(db, { stepRunId: run.id, report });

    expect(output.id).toBeTruthy();
    expect(output.step_run_id).toBe(run.id);
    expect(output.report).toBe(report);
    expect(output.screenshots_dir).toBeNull();
    expect(output.stdout).toBe('');
    expect(output.stderr).toBe('');

    const stored = db.select().from(stepOutputs).where(eq(stepOutputs.id, output.id)).get();
    expect(stored?.step_run_id).toBe(run.id);
    expect(stored?.report).toBe(report);

    await expect(
      createStepOutput(db, { stepRunId: run.id, report: '{}' }),
    ).rejects.toThrow();
  });

  it('screenshotsDir сохраняется, когда передан', async () => {
    const db = makeDb();
    const iterationId = seedIteration(db);
    const run = await createStepRun(db, {
      iterationId,
      step: 'test',
      attempt: 1,
      context: 'ctx',
    });

    const output = await createStepOutput(db, {
      stepRunId: run.id,
      report: '{}',
      screenshotsDir: '/tmp/shots',
    });

    expect(output.screenshots_dir).toBe('/tmp/shots');
  });

  it('сохраняет stdout/stderr (по умолчанию пустые строки)', async () => {
    const db = makeDb();
    const iterationId = seedIteration(db);
    const run = await createStepRun(db, {
      iterationId,
      step: 'resolve',
      attempt: 1,
      context: 'ctx',
    });

    const output = await createStepOutput(db, {
      stepRunId: run.id,
      report: '{}',
      stdout: 'сырой stdout',
      stderr: 'сырой stderr',
    });

    expect(output.stdout).toBe('сырой stdout');
    expect(output.stderr).toBe('сырой stderr');

    const stored = db
      .select()
      .from(stepOutputs)
      .where(eq(stepOutputs.id, output.id))
      .get();
    expect(stored?.stdout).toBe('сырой stdout');
    expect(stored?.stderr).toBe('сырой stderr');
  });

  it('сохраняет events (JSON-массив), а битый JSON деградирует до []', async () => {
    const db = makeDb();
    const iterationId = seedIteration(db);
    const run = await createStepRun(db, {
      iterationId,
      step: 'resolve',
      attempt: 1,
      context: 'ctx',
    });

    const events: SessionEvent[] = [
      { type: 'text', text: 'hello' },
      {
        type: 'tool_use',
        toolCallId: 'c1',
        toolName: 'bash',
        args: { command: 'pwd' },
      },
      {
        type: 'tool_result',
        toolCallId: 'c1',
        toolName: 'bash',
        isError: false,
        durationMs: 1,
        resultText: '/workspace',
      },
    ];
    const output = await createStepOutput(db, {
      stepRunId: run.id,
      report: '{}',
      events,
    });

    expect(output.events).toEqual(events);
    const stored = db
      .select()
      .from(stepOutputs)
      .where(eq(stepOutputs.id, output.id))
      .get();
    expect(JSON.parse(stored?.events ?? '[]')).toEqual(events);

    // Битый JSON в колонке не роняет список — отдаётся []
    db.update(stepOutputs)
      .set({ events: '{not-json' })
      .where(eq(stepOutputs.id, output.id))
      .run();
    const rows = await listStepRunsWithLog(db, iterationId);
    expect(rows[0].events).toEqual([]);
  });

  it('сохраняет stats (JSON) и отдаёт их обратно в StepRunWithLog', async () => {
    const db = makeDb();
    const iterationId = seedIteration(db);
    const run = await createStepRun(db, {
      iterationId,
      step: 'resolve',
      attempt: 1,
      context: 'ctx',
    });

    const stats: SessionStats = {
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
    const output = await createStepOutput(db, {
      stepRunId: run.id,
      report: '{}',
      stats,
    });

    expect(output.stats).toEqual(stats);
    const stored = db
      .select()
      .from(stepOutputs)
      .where(eq(stepOutputs.id, output.id))
      .get();
    expect(stored?.stats).toBe(JSON.stringify(stats));

    const rows = await listStepRunsWithLog(db, iterationId);
    expect(rows[0].stats).toEqual(stats);
  });

  it('stats по умолчанию NULL → null в StepRunWithLog', async () => {
    const db = makeDb();
    const iterationId = seedIteration(db);
    const run = await createStepRun(db, {
      iterationId,
      step: 'resolve',
      attempt: 1,
      context: 'ctx',
    });

    await createStepOutput(db, { stepRunId: run.id, report: '{}' });

    const rows = await listStepRunsWithLog(db, iterationId);
    expect(rows[0].stats).toBeNull();
  });

  it('битый JSON stats не роняет список — отдаётся null', async () => {
    const db = makeDb();
    const iterationId = seedIteration(db);
    const run = await createStepRun(db, {
      iterationId,
      step: 'resolve',
      attempt: 1,
      context: 'ctx',
    });
    const output = await createStepOutput(db, { stepRunId: run.id, report: '{}' });

    db.update(stepOutputs)
      .set({ stats: '{not-json' })
      .where(eq(stepOutputs.id, output.id))
      .run();

    const rows = await listStepRunsWithLog(db, iterationId);
    expect(rows[0].stats).toBeNull();
  });
});

describe('listStepRunsWithLog', () => {
  it('join: шаг с output → stdout/stderr/report заполнены, порядок step-first', async () => {
    const db = makeDb();
    const iterationId = seedIteration(db);

    const review = await createStepRun(db, {
      iterationId,
      step: 'review',
      attempt: 1,
      context: 'v',
    });
    const resolve1 = await createStepRun(db, {
      iterationId,
      step: 'resolve',
      attempt: 1,
      context: 'r1',
    });
    const resolve2 = await createStepRun(db, {
      iterationId,
      step: 'resolve',
      attempt: 2,
      context: 'r2',
    });

    await createStepOutput(db, {
      stepRunId: resolve1.id,
      report: '{"status":"pass"}',
      stdout: 'resolve out',
      stderr: '',
    });
    await createStepOutput(db, {
      stepRunId: review.id,
      report: '{"status":"fail"}',
      stdout: 'review out',
      stderr: 'review err',
      screenshotsDir: '/tmp/shots',
    });

    const rows = await listStepRunsWithLog(db, iterationId);

    expect(rows.map((row) => `${row.step}#${row.attempt}`)).toEqual([
      'resolve#1',
      'resolve#2',
      'review#1',
    ]);
    expect(rows[0]).toMatchObject({
      stdout: 'resolve out',
      stderr: '',
      report: '{"status":"pass"}',
      screenshots_dir: null,
    });
    expect(rows[1]).toMatchObject({
      stdout: '',
      stderr: '',
      report: null,
      screenshots_dir: null,
    });
    expect(rows[2]).toMatchObject({
      stdout: 'review out',
      stderr: 'review err',
      report: '{"status":"fail"}',
      screenshots_dir: '/tmp/shots',
    });
    expect(resolve2.id).toBe(rows[1].id);
  });

  it('пустая итерация → пустой массив', async () => {
    const db = makeDb();
    const iterationId = seedIteration(db);

    expect(await listStepRunsWithLog(db, iterationId)).toEqual([]);
  });
});

describe('ensureStepOutputColumns (миграция)', () => {
  it('добавляет stdout/stderr в legacy step_outputs и идемпотентна', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ir-step-output-'));
    const file = join(dir, 'legacy.db');
    try {
      const raw = new Database(file);
      raw.exec(`
        CREATE TABLE step_outputs (
          id TEXT PRIMARY KEY,
          step_run_id TEXT NOT NULL UNIQUE,
          report TEXT NOT NULL,
          screenshots_dir TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
      `);
      raw.close();

      createDb(file);
      createDb(file); // повторный запуск не должен падать

      const check = new Database(file);
      const columns = (
        check.pragma('table_info(step_outputs)') as { name: string }[]
      ).map((column) => column.name);
      check.close();

      expect(columns).toContain('stdout');
      expect(columns).toContain('stderr');
      expect(columns).toContain('events');
      expect(columns).toContain('stats');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});