import type { StepRunStatus } from '@issue-resolver/shared';
import { and, eq, inArray, or } from 'drizzle-orm';
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

  // Итерации, пережившие рестарт в нефинальном статусе: `running`/`preparing`
  // (процесс мог умереть посреди конвейера) плюс `pending` у задачи в
  // `preparing` — подготовка началась, но процесс умер до `runIssueIteration`.
  // Без второго случая пара «задача preparing / итерация pending» висит вечно.
  const interruptedIterations = db
    .select({ id: iterations.id, issueId: iterations.issue_id })
    .from(iterations)
    .innerJoin(issues, eq(issues.id, iterations.issue_id))
    .where(
      or(
        inArray(iterations.status, ['running', 'preparing']),
        and(eq(iterations.status, 'pending'), eq(issues.status, 'preparing')),
      ),
    )
    .all();

  if (interruptedIterations.length > 0) {
    db.update(iterations)
      .set({ status: 'failed', updated_at: now })
      .where(
        inArray(
          iterations.id,
          interruptedIterations.map((row) => row.id),
        ),
      )
      .run();

    const issueIds = [
      ...new Set(interruptedIterations.map((row) => row.issueId)),
    ];
    if (issueIds.length > 0) {
      db.update(issues)
        .set({ status: 'failed', updated_at: now })
        .where(
          and(
            inArray(issues.id, issueIds),
            // Задача могла застрять и в `running`, и в `preparing`, и в
            // `question` (агент ждал ответа): после рестарта все доводим до failed.
            inArray(issues.status, ['running', 'preparing', 'question']),
          ),
        )
        .run();
    }
  }

  if (interrupted.length > 0 || interruptedIterations.length > 0) {
    console.error(
      `[reconcile] interrupted by restart: ${interrupted.length} step_run(s) → failed, ${interruptedIterations.length} iteration(s) → failed`,
    );
  }

  // Задача завершилась (completed/failed), но в очереди есть pending-итерация:
  // итерации создавались, пока другая задача занимала бэкенд, статус задачи
  // не учитывает очередь. Возвращаем задачу в pending.
  const stalePending = db
    .select({ issueId: iterations.issue_id })
    .from(iterations)
    .innerJoin(issues, eq(issues.id, iterations.issue_id))
    .where(
      and(
        eq(iterations.status, 'pending'),
        inArray(issues.status, ['completed', 'failed']),
      ),
    )
    .all();

  if (stalePending.length > 0) {
    const ids = [...new Set(stalePending.map((row) => row.issueId))];
    db.update(issues)
      .set({ status: 'pending', updated_at: now })
      .where(inArray(issues.id, ids))
      .run();
    console.error(
      `[reconcile] stale pending iteration(s) in completed/failed issue(s): ${ids.length} issue(s) → pending`,
    );
  }
}