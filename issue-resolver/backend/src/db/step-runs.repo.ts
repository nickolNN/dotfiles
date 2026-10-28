import { randomUUID } from 'node:crypto';
import {
  parseSessionStats,
  type PipelineStep,
  type SessionEvent,
  type SessionStats,
  type StepOutput,
  type StepRun,
  type StepRunStatus,
  type StepRunWithLog,
} from '@issue-resolver/shared';
import { and, asc, desc, eq, getTableColumns } from 'drizzle-orm';
import { capSessionEvents } from '../pi/session-events-cap';
import type { Db } from './client';
import { iterations, stepOutputs, stepRuns } from './schema';

function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Owner issue of the iteration, so in-iteration runs do not make every caller
 * duplicate `issue_id`.
 */
function issueIdOfIteration(db: Db, iterationId: string): string | null {
  const row = db
    .select({ issue_id: iterations.issue_id })
    .from(iterations)
    .where(eq(iterations.id, iterationId))
    .get();
  return row?.issue_id ?? null;
}

export interface CreateStepRunInput {
  /**
   * Owner issue: derived from the iteration when one is given, required for
   * runs outside an iteration.
   */
  issueId?: string;
  /** null for runs outside an iteration (report, manually started step). */
  iterationId: string | null;
  step: PipelineStep;
  attempt: number;
  context: string;
}

export interface UpdateStepRunPatch {
  status?: StepRunStatus;
  feedback?: string | null;
}

export interface CreateStepOutputInput {
  stepRunId: string;
  report: string;
  screenshotsDir?: string | null;
  stdout?: string;
  stderr?: string;
  events?: SessionEvent[];
  stats?: SessionStats | null;
}

/** Corrupt or empty event JSON degrades to [] instead of failing the run. */
function parseEvents(raw: string | null): SessionEvent[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as SessionEvent[]) : [];
  } catch {
    return [];
  }
}

/**
 * Run events: until the output row exists the incrementally appended
 * `step_runs.events` is the source (questions first); once it does, the full
 * set in `step_outputs` wins.
 */
function pickStepRunEvents(
  outputEvents: string | null,
  runEvents: SessionEvent[] | null | undefined,
): SessionEvent[] {
  if (outputEvents !== null) {
    return parseEvents(outputEvents);
  }
  return Array.isArray(runEvents) ? runEvents : [];
}

/** Corrupt or empty stats JSON degrades to null. */
function parseStats(raw: string | null): SessionStats | null {
  if (!raw) return null;
  try {
    return parseSessionStats(JSON.parse(raw));
  } catch {
    return null;
  }
}

/** New run row: status 'pending', no feedback, ISO timestamps. */
export async function createStepRun(
  db: Db,
  input: CreateStepRunInput,
): Promise<StepRun> {
  const now = nowIso();
  const issueId =
    input.issueId ??
    (input.iterationId ? issueIdOfIteration(db, input.iterationId) : null);
  if (!issueId) {
    throw new Error(
      'createStepRun: issueId обязателен для прогона вне итерации',
    );
  }
  const row: StepRun = {
    id: randomUUID(),
    issue_id: issueId,
    iteration_id: input.iterationId,
    step: input.step,
    attempt: input.attempt,
    status: 'pending',
    context: input.context,
    feedback: null,
    created_at: now,
    updated_at: now,
  };

  db.insert(stepRuns).values(row).run();
  return row;
}

/** Partial update of a run; always moves `updated_at`. */
export async function updateStepRun(
  db: Db,
  id: string,
  patch: UpdateStepRunPatch,
): Promise<StepRun> {
  const updates: Partial<StepRun> = { updated_at: nowIso() };
  if (patch.status !== undefined) updates.status = patch.status;
  if ('feedback' in patch) updates.feedback = patch.feedback ?? null;

  db.update(stepRuns).set(updates).where(eq(stepRuns.id, id)).run();

  const updated = db.select().from(stepRuns).where(eq(stepRuns.id, id)).get();
  if (!updated) {
    throw new Error(`Шаг не найден: ${id}`);
  }
  return updated;
}

/**
 * Appends one session event to a run. Used while the step is still working and
 * no `step_outputs` row exists: an agent question has to survive a page reload
 * even though the full event set is written only when the step finishes.
 * Read-modify-write is synchronous (better-sqlite3).
 */
export async function appendStepRunEvent(
  db: Db,
  stepRunId: string,
  event: SessionEvent,
): Promise<void> {
  const existing = db
    .select({ events: stepRuns.events })
    .from(stepRuns)
    .where(eq(stepRuns.id, stepRunId))
    .get();

  const currentEvents: SessionEvent[] = existing?.events ?? [];
  currentEvents.push(event);

  // The budget is a property of the stored log, not of any one caller: the
  // 175 MB log was written by a path that appended without a limit.
  db.update(stepRuns)
    .set({ events: capSessionEvents(currentEvents), updated_at: nowIso() })
    .where(eq(stepRuns.id, stepRunId))
    .run();
}

/**
 * Runs of one iteration: pipeline order (refine→resolve→review→test→pr), then
 * attempt ASC within a step.
 */
export async function listStepRunsByIteration(
  db: Db,
  iterationId: string,
): Promise<StepRun[]> {
  return db
    .select()
    .from(stepRuns)
    .where(eq(stepRuns.iteration_id, iterationId))
    .orderBy(asc(stepRuns.created_at), asc(stepRuns.id))
    .all();
}

export async function getStepRun(db: Db, id: string): Promise<StepRun | null> {
  return db.select().from(stepRuns).where(eq(stepRuns.id, id)).get() ?? null;
}

/**
 * Runs of one issue across iterations, including runs outside an iteration
 * (`iteration_id = NULL`, e.g. report), ordered by creation time.
 */
export async function listStepRunsByIssue(
  db: Db,
  issueId: string,
): Promise<StepRun[]> {
  return db
    .select()
    .from(stepRuns)
    .where(eq(stepRuns.issue_id, issueId))
    .orderBy(asc(stepRuns.created_at), asc(stepRuns.id))
    .all();
}

/** Latest run of a step in an issue (including outside an iteration). */
export async function getLatestStepRunForIssue(
  db: Db,
  issueId: string,
  step: PipelineStep,
): Promise<StepRun | null> {
  return (
    db
      .select()
      .from(stepRuns)
      .where(and(eq(stepRuns.issue_id, issueId), eq(stepRuns.step, step)))
      .orderBy(desc(stepRuns.created_at), desc(stepRuns.id))
      .get() ?? null
  );
}

/** Step report; UNIQUE(step_run_id) forbids a second report per run. */
export async function createStepOutput(
  db: Db,
  input: CreateStepOutputInput,
): Promise<StepOutput> {
  const now = nowIso();
  const events = input.events ?? [];
  const stats = input.stats ?? null;
  const row: Omit<StepOutput, 'events' | 'stats'> & {
    events: string;
    stats: string | null;
  } = {
    id: randomUUID(),
    step_run_id: input.stepRunId,
    report: input.report,
    screenshots_dir: input.screenshotsDir ?? null,
    stdout: input.stdout ?? '',
    stderr: input.stderr ?? '',
    events: JSON.stringify(events),
    stats: stats ? JSON.stringify(stats) : null,
    created_at: now,
    updated_at: now,
  };

  db.insert(stepOutputs).values(row).run();
  return { ...row, events, stats };
}

/**
 * Iteration runs joined with their output row: a run without one reports ''
 * stdout/stderr and null report/screenshots_dir. Same order as
 * listStepRunsByIteration.
 */
export async function listStepRunsWithLog(
  db: Db,
  iterationId: string,
): Promise<StepRunWithLog[]> {
  const rows = db
    .select({
      ...getTableColumns(stepRuns),
      stdout: stepOutputs.stdout,
      stderr: stepOutputs.stderr,
      // Output events use a distinct alias: `step_runs` also has an `events`
      // column now (incremental appends before the run finishes).
      outputEvents: stepOutputs.events,
      stats: stepOutputs.stats,
      report: stepOutputs.report,
      screenshots_dir: stepOutputs.screenshots_dir,
    })
    .from(stepRuns)
    .leftJoin(stepOutputs, eq(stepRuns.id, stepOutputs.step_run_id))
    .where(eq(stepRuns.iteration_id, iterationId))
    .orderBy(asc(stepRuns.created_at), asc(stepRuns.id))
    .all();

  return rows.map(({ outputEvents, ...row }) => ({
    ...row,
    stdout: row.stdout ?? '',
    stderr: row.stderr ?? '',
    events: pickStepRunEvents(outputEvents, row.events),
    stats: parseStats(row.stats ?? null),
    report: row.report ?? null,
    screenshots_dir: row.screenshots_dir ?? null,
  }));
}

/**
 * One run with its log, for runs outside an iteration (report): they have no
 * `iteration_id`, so the iteration-scoped list route cannot reach them.
 */
export async function getStepRunWithLog(
  db: Db,
  stepRunId: string,
): Promise<StepRunWithLog | null> {
  const row = db
    .select({
      ...getTableColumns(stepRuns),
      stdout: stepOutputs.stdout,
      stderr: stepOutputs.stderr,
      outputEvents: stepOutputs.events,
      stats: stepOutputs.stats,
      report: stepOutputs.report,
      screenshots_dir: stepOutputs.screenshots_dir,
    })
    .from(stepRuns)
    .leftJoin(stepOutputs, eq(stepRuns.id, stepOutputs.step_run_id))
    .where(eq(stepRuns.id, stepRunId))
    .get();

  if (!row) return null;
  const { outputEvents, ...rest } = row;
  return {
    ...rest,
    stdout: rest.stdout ?? '',
    stderr: rest.stderr ?? '',
    // The cap is mandatory on read as well: the DB still holds rows written
    // before the limit existed (one of them is 175 MB of events), and shipping
    // one to the browser freezes the tab on the first output view.
    events: capSessionEvents(pickStepRunEvents(outputEvents, rest.events)),
    stats: parseStats(rest.stats ?? null),
    report: rest.report ?? null,
    screenshots_dir: rest.screenshots_dir ?? null,
  };
}