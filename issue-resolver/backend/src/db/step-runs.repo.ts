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

function issueIdOfIteration(db: Db, iterationId: string): string | null {
  const row = db
    .select({ issue_id: iterations.issue_id })
    .from(iterations)
    .where(eq(iterations.id, iterationId))
    .get();
  return row?.issue_id ?? null;
}

export interface CreateStepRunInput {
  issueId?: string;
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

function parseEvents(raw: string | null): SessionEvent[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as SessionEvent[]) : [];
  } catch {
    return [];
  }
}

function pickStepRunEvents(
  outputEvents: string | null,
  runEvents: SessionEvent[] | null | undefined,
): SessionEvent[] {
  if (outputEvents !== null) {
    return parseEvents(outputEvents);
  }
  return Array.isArray(runEvents) ? runEvents : [];
}

function parseStats(raw: string | null): SessionStats | null {
  if (!raw) return null;
  try {
    return parseSessionStats(JSON.parse(raw));
  } catch {
    return null;
  }
}

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

  db.update(stepRuns)
    .set({ events: capSessionEvents(currentEvents), updated_at: nowIso() })
    .where(eq(stepRuns.id, stepRunId))
    .run();
}

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

export async function listStepRunsWithLog(
  db: Db,
  iterationId: string,
): Promise<StepRunWithLog[]> {
  const rows = db
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
    events: capSessionEvents(pickStepRunEvents(outputEvents, rest.events)),
    stats: parseStats(rest.stats ?? null),
    report: rest.report ?? null,
    screenshots_dir: rest.screenshots_dir ?? null,
  };
}