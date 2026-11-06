import { randomUUID } from 'node:crypto';
import {
  PipelineStep,
  StepRunStatus,
  TaskStatus,
  type StepRun,
} from '@issue-resolver/shared';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { createDb, type Db } from '../src/db/client';
import { issues, stepRuns } from '../src/db/schema';
import { SESSION_STALE_MS } from '../src/pi/session-liveness';
import { abortStaleRun, statusFromRun } from '../src/routes/issues/latest-run';

const NOW = Date.parse('2026-06-01T12:00:00.000Z');
const STALE_NOW = NOW + SESSION_STALE_MS + 5 * 60_000;
const FEEDBACK = /^(report|devops) failed: нет активности \d+ мин — прогон прерван$/;

function run(over: Partial<StepRun> = {}): StepRun {
  const at = new Date(NOW).toISOString();
  return {
    id: 'run-1',
    issue_id: 'issue-1',
    iteration_id: null,
    step: PipelineStep.report,
    attempt: 1,
    status: StepRunStatus.running,
    context: '',
    feedback: null,
    created_at: at,
    updated_at: at,
    ...over,
  };
}

describe('statusFromRun', () => {
  it('активный прогон всегда running, даже если строка успела стать failed', () => {
    expect(statusFromRun(run({ status: StepRunStatus.failed }), true)).toBe(
      StepRunStatus.running,
    );
  });

  it('без прогона и без активности отдаёт null — решает вызывающий', () => {
    expect(statusFromRun(null, false)).toBeNull();
    expect(statusFromRun(undefined, false)).toBeNull();
  });

  it('пробрасывает известные исходы и считает незавершённый прогон running', () => {
    expect(statusFromRun(run({ status: StepRunStatus.success }), false)).toBe(
      StepRunStatus.success,
    );
    expect(statusFromRun(run({ status: StepRunStatus.failed }), false)).toBe(
      StepRunStatus.failed,
    );
    expect(statusFromRun(run(), false)).toBe(StepRunStatus.running);
  });
});

function seedIssueRow(db: Db): string {
  const id = randomUUID();
  const now = new Date().toISOString();
  db.insert(issues)
    .values({
      id,
      title: 'Параметры',
      jira_issue_url: null,
      pipeline_steps: ['resolve'],
      container_name: null,
      status: TaskStatus.draft,
      created_at: now,
      updated_at: now,
    })
    .run();
  return id;
}

describe('abortStaleRun', () => {
  let db: Db;

  beforeEach(() => {
    db = createDb(':memory:');
  });


  function seed(updatedAt: string, status: StepRunStatus = StepRunStatus.running) {
    const id = randomUUID();
    db.insert(stepRuns)
      .values({
        id,
        issue_id: seedIssueRow(db),
        iteration_id: null,
        step: 'report',
        attempt: 1,
        status,
        context: '',
        feedback: null,
        created_at: updatedAt,
        updated_at: updatedAt,
      })
      .run();
    return id;
  }

  function storedStatus(id: string): StepRunStatus | undefined {
    return db.select().from(stepRuns).where(eq(stepRuns.id, id)).get()?.status;
  }

  function storedFeedback(id: string): string | null | undefined {
    return db.select().from(stepRuns).where(eq(stepRuns.id, id)).get()?.feedback;
  }

  it('тихий прогон вне окна staleness переводится в failed с причиной', async () => {
    const id = seed(new Date(NOW).toISOString());
    const latest = run({ id });

    await abortStaleRun(db, latest, { label: 'report', active: false, now: STALE_NOW });

    expect(storedStatus(id)).toBe(StepRunStatus.failed);
    expect(storedFeedback(id)).toMatch(FEEDBACK);
    expect(storedFeedback(id)).toContain('report failed');
    expect(latest?.status).toBe(StepRunStatus.failed);
    expect(latest?.feedback).toBe(storedFeedback(id));
  });

  it('метка devops попадает в текст причины', async () => {
    const id = seed(new Date(NOW).toISOString());

    await abortStaleRun(db, run({ id }), { label: 'devops', active: false, now: STALE_NOW });

    expect(storedFeedback(id)).toContain('devops failed');
  });

  it('свежий прогон внутри окна не трогается', async () => {
    const id = seed(new Date(NOW).toISOString());

    await abortStaleRun(db, run({ id }), {
      label: 'report',
      active: false,
      now: NOW + 1_000,
    });

    expect(storedStatus(id)).toBe(StepRunStatus.running);
    expect(storedFeedback(id)).toBeNull();
  });

  it('активный прогон не прерывается даже при тишине', async () => {
    const id = seed(new Date(NOW).toISOString());

    await abortStaleRun(db, run({ id }), { label: 'report', active: true, now: STALE_NOW });

    expect(storedStatus(id)).toBe(StepRunStatus.running);
  });

  it('завершённый прогон не переписывается', async () => {
    const id = seed(new Date(NOW).toISOString(), StepRunStatus.success);

    await abortStaleRun(
      db,
      run({ id, status: StepRunStatus.success }),
      { label: 'report', active: false, now: STALE_NOW },
    );

    expect(storedStatus(id)).toBe(StepRunStatus.success);
  });

  it('без строки ничего не делает и не бросает', async () => {
    await expect(
      abortStaleRun(db, null, { label: 'report', active: false, now: STALE_NOW }),
    ).resolves.toBeUndefined();
    await expect(
      abortStaleRun(db, undefined, { label: 'report', active: false, now: STALE_NOW }),
    ).resolves.toBeUndefined();
  });
});