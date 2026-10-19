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
import { asc, eq, getTableColumns } from 'drizzle-orm';
import type { Db } from './client';
import { stepOutputs, stepRuns } from './schema';

function nowIso(): string {
  return new Date().toISOString();
}

export interface CreateStepRunInput {
  iterationId: string;
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

/** Битый/пустой JSON событий деградирует до [] — лог шага не должен падать. */
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
 * События прогона: пока output-строки нет, берём дозалитые `step_runs.events`
 * (в первую очередь вопросы); с её появлением полный набор из `step_outputs`
 * становится источником истины.
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

/** Битый/пустой JSON статистики деградирует до null. */
function parseStats(raw: string | null): SessionStats | null {
  if (!raw) return null;
  try {
    return parseSessionStats(JSON.parse(raw));
  } catch {
    return null;
  }
}

/** Новый прогон шага: status 'pending', feedback null, даты — now ISO. */
export async function createStepRun(
  db: Db,
  input: CreateStepRunInput,
): Promise<StepRun> {
  const now = nowIso();
  const row: StepRun = {
    id: randomUUID(),
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

/** Частичное обновление прогона; всегда двигает updated_at. */
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
 * Дозапись одного события сессии в прогон шага. Нужна, пока шаг в работе и
 * строки `step_outputs` ещё нет: например, вопрос агента должен пережить
 * перезагрузку страницы, хотя полный набор событий уходит в `step_outputs`
 * только на финише шага. Чтение-изменение-запись синхронна (better-sqlite3).
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

  db.update(stepRuns)
    .set({ events: currentEvents, updated_at: nowIso() })
    .where(eq(stepRuns.id, stepRunId))
    .run();
}

/**
 * Прогоны итерации: сначала по шагам в порядке конвейера
 * (refine→resolve→review→test→pr), внутри шага — attempt ASC.
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

/** Отчёт шага; UNIQUE(step_run_id) не даёт записать второй отчёт на тот же прогон. */
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
 * Прогоны итерации вместе с логом их output-строки: JOIN step_outputs, у шага
 * без output-строки stdout/stderr — '', report/screenshots_dir — null. Порядок
 * тот же, что у listStepRunsByIteration (step-first, attempt ASC).
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
      // События output-строки вынесены под отдельный псевдоним: у `step_runs`
      // теперь тоже есть колонка `events` (инкрементальная дозапись до финиша).
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