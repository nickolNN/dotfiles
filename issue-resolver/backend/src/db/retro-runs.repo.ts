import { randomUUID } from 'node:crypto';
import {
  parseSessionStats,
  type RetroRun,
  type RetroRunStatus,
  type RetroRunWithLog,
  type SessionEvent,
  type SessionStats,
  type ThinkingLevel,
} from '@issue-resolver/shared';
import { desc, eq } from 'drizzle-orm';
import type { Db } from './client';
import { retroRuns } from './schema';

function nowIso(): string {
  return new Date().toISOString();
}

function toRun(row: typeof retroRuns.$inferSelect): RetroRun {
  return {
    id: row.id,
    status: row.status,
    model: row.model,
    instructions: row.instructions,
    session_limit: row.session_limit,
    thinking_level: row.thinking_level,
    report: row.report,
    error: row.error,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export interface UpdateRetroRunPatch {
  status?: RetroRunStatus;
  report?: string | null;
  error?: string | null;
  stdout?: string;
  stderr?: string;
  events?: SessionEvent[];
  stats?: SessionStats | null;
}

export interface CreateRetroRunInput {
  model?: string | null;
  instructions?: string | null;
  sessionLimit?: number | null;
  thinkingLevel?: ThinkingLevel | null;
}

/**
 * A run marked `running` in the database can only be stale here: the caller
 * guards against a live run before inserting a new one.
 */
export function failStaleRetroRuns(db: Db): void {
  db.update(retroRuns)
    .set({
      status: 'failed',
      error: 'прогон прерван перезапуском бэкенда',
      updated_at: nowIso(),
    })
    .where(eq(retroRuns.status, 'running'))
    .run();
}

export function createRetroRun(
  db: Db,
  input: CreateRetroRunInput = {},
): RetroRun {
  failStaleRetroRuns(db);
  const now = nowIso();
  const row = {
    id: randomUUID(),
    status: 'running' as const,
    model: input.model ?? null,
    instructions: input.instructions ?? null,
    session_limit: input.sessionLimit ?? null,
    thinking_level: input.thinkingLevel ?? null,
    report: null,
    error: null,
    created_at: now,
    updated_at: now,
  };
  db.insert(retroRuns).values(row).run();
  return row;
}

export function updateRetroRun(
  db: Db,
  id: string,
  patch: UpdateRetroRunPatch,
): void {
  const values: Partial<typeof retroRuns.$inferInsert> = { updated_at: nowIso() };
  if (patch.status !== undefined) values.status = patch.status;
  if (patch.report !== undefined) values.report = patch.report;
  if (patch.error !== undefined) values.error = patch.error;
  if (patch.stdout !== undefined) values.stdout = patch.stdout;
  if (patch.stderr !== undefined) values.stderr = patch.stderr;
  if (patch.events !== undefined) values.events = patch.events;
  if (patch.stats !== undefined) {
    values.stats = patch.stats ? JSON.stringify(patch.stats) : null;
  }
  db.update(retroRuns).set(values).where(eq(retroRuns.id, id)).run();
}

export function getRetroRun(db: Db, id: string): RetroRun | null {
  const row = db.select().from(retroRuns).where(eq(retroRuns.id, id)).get();
  return row ? toRun(row) : null;
}

export function getRetroRunWithLog(
  db: Db,
  id: string,
): RetroRunWithLog | null {
  const row = db.select().from(retroRuns).where(eq(retroRuns.id, id)).get();
  if (!row) return null;
  return {
    ...toRun(row),
    stdout: row.stdout,
    stderr: row.stderr,
    events: row.events ?? [],
    stats: parseSessionStats(row.stats),
  };
}

export function listRetroRuns(db: Db, limit = 20): RetroRun[] {
  return db
    .select()
    .from(retroRuns)
    .orderBy(desc(retroRuns.created_at))
    .limit(limit)
    .all()
    .map(toRun);
}