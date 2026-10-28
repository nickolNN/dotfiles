/**
 * Общий таймаут запуска pi-агента шага.
 *
 * Resolve-шаг может запускать нескольких агентов (комната/этапы) и обязан
 * завершаться терминально: зависший или упавший pi-агент не должен оставлять
 * `step_run`/итерацию в `running` навсегда.
 *
 * Таймаут прокидывается в `PiRunner` (`options.timeoutMs`; `RpcPiRunner`
 * делает reject + SIGKILL), а `withAgentTimeout` даёт жёсткий внешний потолок
 * на случай, если раннер не поддерживает/игнорирует эту опцию.
 */

/** Минимально допустимый таймаут pi-агента из env — 60 секунд. */
export const MIN_RESOLVE_AGENT_TIMEOUT_MS = 60_000;

/** Дефолтный таймаут одного resolve-агента — 180 минут (3 часа). */
export const DEFAULT_RESOLVE_AGENT_TIMEOUT_MS = 180 * 60_000;

/** Env-переменная таймаута pi-агента (мс). */
export const RESOLVE_AGENT_TIMEOUT_ENV =
  'ISSUE_RESOLVER_RESOLVE_AGENT_TIMEOUT_MS';

/**
 * Таймаут запуска pi-агента (мс): env `ISSUE_RESOLVER_RESOLVE_AGENT_TIMEOUT_MS`,
 * но не меньше 60с. Невалидное/отсутствующее значение → дефолт 90 минут.
 *
 * Явный per-run override (например, короткий таймаут в тестах) задаётся
 * вызывающим кодом напрямую и не проходит через clamp этой функции.
 */
export function resolveAgentTimeoutMs(
  raw: string | undefined = process.env[RESOLVE_AGENT_TIMEOUT_ENV],
): number {
  const parsed = Number(raw);
  if (!raw || !Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_RESOLVE_AGENT_TIMEOUT_MS;
  }
  return Math.max(parsed, MIN_RESOLVE_AGENT_TIMEOUT_MS);
}

/** Env-переменная таймаута DevOps-агента рабочей папки (мс). */
export const DEVOPS_TIMEOUT_ENV =
  'ISSUE_RESOLVER_DEVOPS_TIMEOUT_MS';

/**
 * Устаревшее (legacy) имя env-переменной — фолбэк для окружений, настроенных
 * до переименования. Читается только если новая `DEVOPS_TIMEOUT_ENV` не задана.
 */
export const LEGACY_DEVOPS_TIMEOUT_ENV =
  'ISSUE_RESOLVER_BOOTSTRAPPER_TIMEOUT_MS';

/** Дефолтный таймаут DevOps-агента — те же 180 минут, что и у resolve-агента. */
export const DEFAULT_DEVOPS_TIMEOUT_MS = DEFAULT_RESOLVE_AGENT_TIMEOUT_MS;

/**
 * Таймаут DevOps-агента `run_instructions` (мс): env
 * `ISSUE_RESOLVER_DEVOPS_TIMEOUT_MS`, при отсутствии — устаревшее имя
 * `LEGACY_DEVOPS_TIMEOUT_ENV`; но не меньше 60с.
 * Пустое/невалидное значение → дефолт 90 минут.
 *
 * Без него разовая подготовка — единственный этап без потолка: зависший `pi`
 * блокирует `prepareIssueWorkspace` навсегда, итерация остаётся `pending`, а
 * задача — `preparing` (`runIssueIteration` так и не вызывается).
 */
export function resolveDevOpsTimeoutMs(
  raw: string | undefined = process.env[DEVOPS_TIMEOUT_ENV] ??
    process.env[LEGACY_DEVOPS_TIMEOUT_ENV],
): number {
  const parsed = Number(raw);
  if (!raw || !Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_DEVOPS_TIMEOUT_MS;
  }
  return Math.max(parsed, MIN_RESOLVE_AGENT_TIMEOUT_MS);
}

/**
 * Жёсткий внешний потолок на promise pi-агента. Страховка на случай, если
 * раннер не поддерживает `timeoutMs`: по истечении срока reject'ит с меткой
 * `label`, не дожидаясь promise.
 *
 * Поздний settle исходного promise гасится уже навешанным обработчиком, поэтому
 * unhandled rejection не возникает.
 */
export function withAgentTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/** Env var for the agent silence window (ms). */
import type { StallRecovery } from '../pi/stall-recovery';

export type { StallRecovery };

export const AGENT_STALL_TIMEOUT_ENV =
  'ISSUE_RESOLVER_AGENT_STALL_TIMEOUT_MS';

/**
 * 15 min without a single chunk or session event. The hard ceiling (3 h) fires
 * too late: real runs sat 2h21m after the agent went quiet.
 */
export const DEFAULT_AGENT_STALL_TIMEOUT_MS = 15 * 60_000;

/** Floor for the env value; a per-run override bypasses this clamp. */
export const MIN_AGENT_STALL_TIMEOUT_MS = 30_000;

/** Silence window in ms from env, clamped to the floor; invalid → default. */
export function resolveAgentStallTimeoutMs(
  raw: string | undefined = process.env[AGENT_STALL_TIMEOUT_ENV],
): number {
  const parsed = Number(raw);
  if (!raw || !Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_AGENT_STALL_TIMEOUT_MS;
  }
  return Math.max(parsed, MIN_AGENT_STALL_TIMEOUT_MS);
}
/**
 * Rejects once `activity()` has not changed for `stallMs`. Every chunk of step
 * output must bump the counter, otherwise a live but silent run gets killed.
 *
 * A silent agent is not a dead one, so `recover` gets a chance to wake it (a
 * `follow_up` nudge, then a context compaction) before the run is failed.
 */
export function withAgentStallGuard<T>(
  promise: Promise<T>,
  options: {
    stallMs: number;
    label: string;
    activity: () => number;
    /** Counter poll interval (default 1 s). */
    pollMs?: number;
    /** Attempted in order, each with its own grace window. */
    recover?: StallRecovery[];
    /**
     * Ceiling for one recovery attempt (default 30 s). A delivery that hangs
     * must not hold the run: the guard moves down the ladder instead.
     */
    attemptTimeoutMs?: number;
    /**
     * Called once when every recovery failed. The caller cancels the live
     * session, so a rejected promise does not leave the process behind.
     */
    onStall?: () => void;
  },
): Promise<T> {
  const { stallMs, label, activity } = options;
  const pollMs = Math.max(1, Math.min(options.pollMs ?? 1_000, stallMs));
  const pending = [...(options.recover ?? [])];
  const tried: string[] = [];
  const attemptTimeoutMs = Math.max(1, options.attemptTimeoutMs ?? 30_000);

  /** Recovery is best effort: a hang or a throw counts as "no window". */
  const attemptWithCeiling = (
    attempt: StallRecovery['attempt'],
  ): Promise<number> =>
    new Promise<number>((resolveAttempt) => {
      let settled = false;
      const timer = setTimeout(() => {
        settled = true;
        resolveAttempt(0);
      }, attemptTimeoutMs);
      const finish = (grace: number) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolveAttempt(grace);
      };
      Promise.resolve()
        .then(attempt)
        .then((grace) => finish(grace ?? 0))
        .catch(() => finish(0));
    });

  return new Promise<T>((resolve, reject) => {
    let seen = activity();
    let seenAt = Date.now();
    let graceMs = 0;
    let recovering = false;
    let finished = false;

    const stop = () => {
      finished = true;
      clearInterval(timer);
    };

    const giveUp = () => {
      stop();
      try {
        options.onStall?.();
      } catch {
        // Cancelling is best effort; the stall error is what the caller needs.
      }
      const suffix = tried.length > 0 ? ` (tried: ${tried.join(', ')})` : '';
      reject(new Error(`${label} stalled: no output for ${stallMs}ms${suffix}`));
    };

    /** Runs the next recovery attempt, or gives up when the list is empty. */
    const attemptNext = () => {
      const next = pending.shift();
      if (!next) {
        giveUp();
        return;
      }
      tried.push(next.label);
      // While an attempt is in flight the window must not fire again, or an
      // empty ladder would give up before the nudge even reached the agent.
      recovering = true;
      void attemptWithCeiling(next.attempt).then((grace) => {
        recovering = false;
        if (finished) return;
        if (grace > 0) {
          // The agent gets a full window to show any sign of life.
          seen = activity();
          seenAt = Date.now();
          graceMs = grace;
          return;
        }
        if (pending.length > 0) attemptNext();
        else giveUp();
      });
    };

    const timer = setInterval(() => {
      const current = activity();
      if (current !== seen) {
        seen = current;
        seenAt = Date.now();
        graceMs = 0;
        return;
      }
      if (recovering) return;
      if (Date.now() - seenAt < (graceMs > 0 ? graceMs : stallMs)) return;
      graceMs = 0;
      attemptNext();
    }, pollMs);

    promise.then(
      (value) => {
        stop();
        resolve(value);
      },
      (error) => {
        stop();
        reject(error);
      },
    );
  });
}
