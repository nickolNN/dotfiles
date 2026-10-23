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