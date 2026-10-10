import type { StepRunStatus } from '@issue-resolver/shared';
import { and, eq, inArray } from 'drizzle-orm';
import type { Db } from './client';
import { issues, iterations, stepRuns } from './schema';

/** Шаги, которые после рестарта процесса превращаются в «призраков». */
const INTERRUPTED_STEP_STATUSES: StepRunStatus[] = [
  'pending',
  'running',
  'needs_input',
];

/**
 * Реестр живых pi-сессий (StepSessionRegistry) и сами pi-процессы живут в
 * памяти процесса backend и теряются при его рестарте. Шаг/итерация, оставшиеся
 * в нефинальном статусе в БД, после рестарта становятся «призраком»: БД говорит
 * `running`, а агентов комнаты уже нет (listAgents отдаёт `[]`). Здесь на старте
 * доводим их до терминального состояния, чтобы UI не показывал вечное `running`
 * и разрешал повторный запуск.
 */
export function reconcileInterruptedRuns(db: Db): void {
  const now = new Date().toISOString();

  const interrupted = db
    .select({ id: stepRuns.id })
    .from(stepRuns)
    .where(inArray(stepRuns.status, INTERRUPTED_STEP_STATUSES))
    .all();

  if (interrupted.length > 0) {
    db.update(stepRuns)
      .set({
        status: 'failed',
        feedback: 'interrupted by server restart',
        updated_at: now,
      })
      .where(inArray(stepRuns.status, INTERRUPTED_STEP_STATUSES))
      .run();
  }

  const runningIterations = db
    .select({ id: iterations.id, issueId: iterations.issue_id })
    .from(iterations)
    .where(eq(iterations.status, 'running'))
    .all();

  if (runningIterations.length > 0) {
    db.update(iterations)
      .set({ status: 'failed', updated_at: now })
      .where(eq(iterations.status, 'running'))
      .run();

    const issueIds = [...new Set(runningIterations.map((row) => row.issueId))];
    if (issueIds.length > 0) {
      db.update(issues)
        .set({ status: 'failed', updated_at: now })
        .where(and(inArray(issues.id, issueIds), eq(issues.status, 'running')))
        .run();
    }
  }

  if (interrupted.length > 0 || runningIterations.length > 0) {
    console.error(
      `[reconcile] interrupted by restart: ${interrupted.length} step_run(s) → failed, ${runningIterations.length} iteration(s) → failed`,
    );
  }
}