import { useCallback, useEffect, useRef, useState } from 'react';
import {
  extractIssueKeyFromUrl,
  extractRepoNameFromUrl,
  formatRelativeTime,
  type Issue,
  type Iteration,
  type SavedRepo,
  type TaskStatus,
} from '@issue-resolver/shared';
import {
  deleteIssue,
  devServerPortOf,
  getIterations,
  getIssues,
  getRepositories,
  getStepRuns,
  stopDevServers,
} from '../api/client';
import type { StepRunWithEvents } from '../api/session-events';
import {
  DELETE_TIMEOUT_MS,
  subscribeToGlobalStream,
  subscribeToIssueEvents,
} from '../api/sse';
import { formatAvgSpeed, formatTokens } from '../components/SessionStatsBar';
import { formatDuration, sumStepRunWorkMs, useNow } from '../lib/time';
import { statusColor } from '../theme';

interface TasksListProps {
  onOpenTask?: (issueId: string) => void;
  onOpenResult?: (issueId: string) => void;
}

/**
 * Issue + живое состояние активного шага из SSE `step_status` (в БД не
 * персистится): показывается на карточке, пока шаг выполняется.
 */
type IssueWithActiveStep = Issue & {
  activeStep?: string;
  activeModel?: string | null;
};

type LoadState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; issues: IssueWithActiveStep[] };

const STATUS_LABELS: Record<TaskStatus, string> = {
  pending: 'В очереди',
  running: 'В работе',
  preparing: 'Подготовка',
  completed: 'Завершено',
  failed: 'Ошибка',
  cancelled: 'Отменено',
  question: 'Вопрос',
};

/** Runtime-проверка статуса: SSE-данные приходят строками. */
const TASK_STATUSES: ReadonlySet<string> = new Set([
  'pending',
  'running',
  'preparing',
  'completed',
  'failed',
  'cancelled',
  'question',
]);

function isTaskStatus(value: unknown): value is TaskStatus {
  return typeof value === 'string' && TASK_STATUSES.has(value);
}

/** Баннер, если финал удаления не пришёл за `DELETE_TIMEOUT_MS`. */
const DELETE_TIMEOUT_MESSAGE =
  'Таймаут удаления. Задача может быть удалена частично. Обновите страницу.';

/** Человекочитаемые фазы фонового удаления задачи (SSE `issue_deleting`). */
const DELETE_PHASE_LABELS: Record<string, string> = {
  stopping_processes: 'останавливаем процессы',
  removing_db_record: 'Удаление записи...',
  removing_container: 'удаляем контейнер',
  removing_workspace: 'удаляем рабочую папку',
};

/** Статусы, карточка которых пульсирует. */
const PULSE_STATUSES: ReadonlySet<TaskStatus> = new Set([
  'running',
  'preparing',
  'question',
]);

/** Карточный класс для завершённых/отменённых — приглушённый. */
const TERMINAL_STATUSES: ReadonlySet<TaskStatus> = new Set([
  'completed',
  'cancelled',
]);

/** Статусы без точки-индикатора слева от заголовка. */
const NO_DOT_STATUSES: ReadonlySet<TaskStatus> = new Set([
  'completed',
  'cancelled',
  'failed',
]);

function issueKey(issue: Issue): string {
  return (
    extractIssueKeyFromUrl(issue.jira_issue_url ?? '') ||
    issue.title.trim() ||
    issue.id
  );
}

/** Пары «repo:branch», соединённые middle dot. Без ветки — только имя репо. */
function repositoryNames(issue: Issue): string {
  return issue.repositories
    .map((repository) => {
      const name = extractRepoNameFromUrl(repository.repository_url);
      const branch = repository.branch_name?.trim();
      if (!name) return branch ?? '';
      return branch ? `${name}:${branch}` : name;
    })
    .filter((label) => label.length > 0)
    .join(' · ');
}

/** Готовность репозитория задачи к показу сводки на карточке. */
type RepoReadiness = 'ready' | 'connected' | 'waiting' | 'error';

/** Порядок вывода категорий готовности; `error` показывается только при ≥1. */
const REPO_READINESS_ORDER: readonly RepoReadiness[] = [
  'ready',
  'connected',
  'waiting',
  'error',
];

const REPO_READINESS_ICONS: Record<RepoReadiness, string> = {
  ready: '✅',
  connected: '🔵',
  waiting: '🟡',
  error: '❌',
};

const REPO_READINESS_COLORS: Record<RepoReadiness, string> = {
  ready: '#00FF41',
  connected: '#00B4FF',
  waiting: '#FFB000',
  error: '#FF0033',
};

const REPO_READINESS_LABELS: Record<RepoReadiness, string> = {
  ready: 'готов',
  connected: 'подключён',
  waiting: 'ожидание',
  error: 'ошибка',
};

/**
 * Готовность репозитория задачи по его сохранённой записи:
 * - `ok` + инструкция сгенерирована → готов (клон и анализ есть);
 * - `ok` без инструкции → подключён (клон есть, анализ не готов);
 * - `error` → ошибка соединения;
 * - записи нет / `unknown` → ещё ждёт (в т.ч. репозиторий не сохранён).
 */
function repoReadiness(repo: SavedRepo | undefined): RepoReadiness {
  if (repo === undefined) return 'waiting';
  if (repo.connectionStatus === 'error') return 'error';
  if (repo.connectionStatus === 'ok') {
    return repo.runInstructionsStatus === 'generated' ? 'ready' : 'connected';
  }
  return 'waiting';
}

/**
 * Сводка по репозиториям pending/preparing-задачи: сколько готово/подключено/
 * ждёт/с ошибкой. Молчит, пока `savedRepos` не загружены или у задачи нет repo.
 *
 * Формат: `📦 репо: ✅2 🔵1 🟡0`; `❌` добавляется в конец только при ошибках.
 */
function RepoReadinessLine({
  issue,
  savedRepos,
}: {
  issue: Issue;
  savedRepos: SavedRepo[] | null;
}) {
  if (savedRepos === null || issue.repositories.length === 0) return null;

  const counts: Record<RepoReadiness, number> = {
    ready: 0,
    connected: 0,
    waiting: 0,
    error: 0,
  };
  for (const repository of issue.repositories) {
    const url = repository.repository_url.trim();
    const saved = savedRepos.find(
      (repo) => typeof repo.url === 'string' && repo.url.trim() === url,
    );
    counts[repoReadiness(saved)] += 1;
  }

  return (
    <div
      data-testid="repo-readiness"
      className="mb-1.5 flex flex-wrap items-center gap-x-2 text-xs text-[#00FF41]/80"
    >
      <span className="text-[#00FF41]/60">📦 репо:</span>{' '}
      {REPO_READINESS_ORDER.filter(
        (status) => status !== 'error' || counts.error > 0,
      ).map((status, index) => (
        <span
          key={status}
          data-testid={`repo-readiness-${status}`}
          data-count={counts[status]}
          title={`${REPO_READINESS_LABELS[status]}: ${counts[status]}`}
          className="whitespace-nowrap"
        >
          {index > 0 && ' '}
          <span style={{ color: REPO_READINESS_COLORS[status] }}>
            {REPO_READINESS_ICONS[status]}
          </span>
          {counts[status]}
        </span>
      ))}
    </div>
  );
}

/** Просматриваемый результат есть у завершённой задачи с md/html-артефактом. */
function hasViewableResult(issue: Issue): boolean {
  return (
    issue.status === 'completed' &&
    (issue.desired_result === 'md' || issue.desired_result === 'html')
  );
}

/** Staggered-классы появления карточек (d1…d8, дальше — без задержки). */
const CARD_ANIMATIONS = [
  'animate-fade-in-up-d1',
  'animate-fade-in-up-d2',
  'animate-fade-in-up-d3',
  'animate-fade-in-up-d4',
  'animate-fade-in-up-d5',
  'animate-fade-in-up-d6',
  'animate-fade-in-up-d7',
  'animate-fade-in-up-d8',
] as const;

function cardAnimation(index: number): string {
  return CARD_ANIMATIONS[index] ?? 'animate-fade-in-up';
}

/**
 * Длительность задачи в текущем UI — чистое время работы агентов, поэтому
 * wall-clock `created_at → updated_at` здесь больше не считается: между
 * итерациями задача простаивает. Время берётся из step-runs (см. `IssueStats`).
 */

interface IssueStatsData {
  iterations: number;
  /** Все step-runs задачи; null — ещё не загружены (таймер в fallback). */
  runs: StepRunWithEvents[] | null;
  tokensInput: number;
  tokensOutput: number;
  tokensCache: number;
  hasTokenStats: boolean;
  /** Средняя скорость последней итерации (токенов/сек) или null. */
  avgSpeed: number | null;
}

type IssueStatsState =
  | { status: 'loading' }
  | { status: 'ready'; data: IssueStatsData }
  | { status: 'error' };

/** Компактные иконки-роли для токенов (↓ входящие, ↑ исходящие, ⤓ кеш). */
function TokensInline(data: IssueStatsData) {
  if (!data.hasTokenStats) return null;
  return (
    <>
      <span
        aria-label={`${formatTokens(data.tokensInput)} входящих токенов`}
        title={`${formatTokens(data.tokensInput)} входящих`}
      >
        ↓{formatTokens(data.tokensInput)}
      </span>{' '}
      <span
        aria-label={`${formatTokens(data.tokensOutput)} исходящих токенов`}
        title={`${formatTokens(data.tokensOutput)} исходящих`}
      >
        ↑{formatTokens(data.tokensOutput)}
      </span>{' '}
      <span
        aria-label={`${formatTokens(data.tokensCache)} кеш-токенов`}
        title={`${formatTokens(data.tokensCache)} кеш`}
      >
        ⤓{formatTokens(data.tokensCache)}
      </span>
    </>
  );
}

/**
 * Ленивая статистика карточки: число итераций есть у всех начатых задач,
 * время работы и токены — только у running/completed (для остальных step-runs
 * не финальны или не начаты). Ответы кешируются в состоянии компонента,
 * поэтому ререндеры (живой таймер) не перезапрашивают сеть.
 *
 * Таймер показывает чистое время работы step-runs, а не wall-clock. Пока
 * step-runs не загружены, `issue-timer` не рендерится — относительное время
 * `formatRelativeTime(created_at)` рядом служит fallback'ом.
 */
function IssueStats({
  issue,
  now,
  activeStep,
  activeModel,
}: {
  issue: Issue;
  now: number;
  activeStep?: string;
  activeModel?: string | null;
}) {
  const [state, setState] = useState<IssueStatsState>({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;
    setState({ status: 'loading' });

    void (async () => {
      try {
        const response = await getIterations(issue.id);
        const iterations = Array.isArray(response) ? response : [];
        const lastIteration = iterations.reduce<Iteration | null>(
          (latest, iteration) =>
            latest === null || iteration.number > latest.number
              ? iteration
              : latest,
          null,
        );

        let runs: StepRunWithEvents[] | null = null;
        let tokensInput = 0;
        let tokensOutput = 0;
        let tokensCache = 0;
        let hasTokenStats = false;
        let avgSpeed: number | null = null;
        const speeds: number[] = [];

        if (
          issue.status === 'running' ||
          issue.status === 'completed'
        ) {
          const batches = await Promise.all(
            iterations.map((iteration) => getStepRuns(iteration.id)),
          );
          runs = batches.flat();

          // Токены — только у завершённой задачи с завершённой последней
          // итерацией; step-runs во время работы ещё не финальны.
          if (
            issue.status === 'completed' &&
            lastIteration?.status === 'completed'
          ) {
            for (const run of runs) {
              if (run.iteration_id !== lastIteration.id) continue;
              const stats = run.stats;
              if (!stats) continue;
              hasTokenStats = true;
              tokensInput += stats.tokens?.input ?? 0;
              tokensOutput += stats.tokens?.output ?? 0;
              tokensCache +=
                (stats.tokens?.cacheRead ?? 0) +
                (stats.tokens?.cacheWrite ?? 0);
              if (typeof stats.avgTokensPerSecond === 'number') {
                speeds.push(stats.avgTokensPerSecond);
              }
            }
            avgSpeed =
              speeds.length > 0
                ? speeds.reduce((sum, speed) => sum + speed, 0) / speeds.length
                : null;
          }
        }

        if (!cancelled) {
          setState({
            status: 'ready',
            data: {
              iterations: iterations.length,
              runs,
              tokensInput,
              tokensOutput,
              tokensCache,
              hasTokenStats,
              avgSpeed,
            },
          });
        }
      } catch {
        if (!cancelled) setState({ status: 'error' });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [issue.id, issue.status]);

  if (state.status === 'loading') {
    return (
      <span
        data-testid="issue-stats"
        className="whitespace-nowrap text-[#00FF41]/40"
      >
        Загрузка статистики…
      </span>
    );
  }

  if (state.status === 'error') return null;

  const workMs = sumStepRunWorkMs(state.data.runs, now);
  const workTime = workMs === null ? '' : formatDuration(workMs);

  return (
    <>
      {workTime && (
        <span data-testid="issue-timer" className="whitespace-nowrap">
          ⏱ {workTime}
        </span>
      )}
      {activeStep && (
        <span
          data-testid="active-step"
          className="whitespace-nowrap font-mono text-xs text-[#00FF41]/70"
        >
          {activeStep}
          {activeModel ? ` · ${activeModel}` : ''}
        </span>
      )}
      <span data-testid="issue-stats" className="whitespace-nowrap">
        {workTime ? '· ' : ''}↻ {state.data.iterations}{' '}
        <TokensInline {...state.data} />
        {state.data.avgSpeed != null && (
          <>{' '}· ⚡{formatAvgSpeed(state.data.avgSpeed)} t/s</>
        )}
      </span>
    </>
  );
}

/** Inline-иконка «стоп» (квадрат) для гашения dev-серверов. */
function StopIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="6" y="6" width="12" height="12" rx="1" />
    </svg>
  );
}

/** Inline-иконка мусорного ведра, без внешних зависимостей. */
function TrashIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M4 7h16" />
      <path d="M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
      <path d="M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12" />
      <path d="M10 11v6M14 11v6" />
    </svg>
  );
}

export default function TasksList({ onOpenTask, onOpenResult }: TasksListProps) {
  const [state, setState] = useState<LoadState>({ status: 'loading' });
  const [actionError, setActionError] = useState<string | null>(null);
  const [stopError, setStopError] = useState<string | null>(null);
  // id задач, которые прямо сейчас удаляются: карточка показывает
  // «Удаление...», пока не придёт SSE `issue_deleted`.
  const [deletingIds, setDeletingIds] = useState<Set<string>>(() => new Set());
  // Текущая фаза удаления (SSE `issue_deleting`) по id задачи.
  const [deletingPhases, setDeletingPhases] = useState<Record<string, string>>(
    {},
  );
  // Сохранённые репозитории для сводки готовности; грузятся один раз на весь
  // список (кеш в состоянии), а не по разу на карточку.
  const [savedRepos, setSavedRepos] = useState<SavedRepo[] | null>(null);
  const savedReposRequestedRef = useRef(false);
  const mountedRef = useRef(true);
  // Живые SSE-подписки на потоки удаляемых задач (id → функция отписки).
  const deleteStreamsRef = useRef<Map<string, () => void>>(new Map());
  // Таймауты ожидания финала удаления (id → handle), чтобы не оставлять
  // карточку в «Удаление...» навсегда, если поток замолчал.
  const deleteTimeoutsRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(
    new Map(),
  );
  // Предупреждение о зависшем удалении (отдельно от actionError, у которого
  // свой префикс «Не удалось удалить задачу:»).
  const [deleteTimeoutNotice, setDeleteTimeoutNotice] = useState<string | null>(
    null,
  );

  // Живой тик, пока в списке есть хотя бы одна running-задача.
  const now = useNow(
    state.status === 'ready' &&
      state.issues.some((issue) => issue.status === 'running'),
  );

  const load = useCallback(async () => {
    setState({ status: 'loading' });
    try {
      const issues = await getIssues();
      if (mountedRef.current) setState({ status: 'ready', issues });
    } catch (error: unknown) {
      if (mountedRef.current) {
        setState({
          status: 'error',
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    void load();

    return () => {
      mountedRef.current = false;
    };
  }, [load]);

  // Живой статус задач: глобальный SSE-поток шлёт `iteration_status` по всем
  // задачам — обновляем карточки в списке без перезагрузки страницы.
  useEffect(() => {
    return subscribeToGlobalStream({
      // `step_status` обновляется на КАЖДЫЙ шаг (refine→resolve→…). При
      // status='running' бэкенд кладёт в `data` JSON `{status, step, model}`,
      // при остальных статусах — плоскую строку. Показываем активный шаг с
      // моделью, пока задача `running`, и сбрасываем при завершении шага.
      onStepStatus: (event) => {
        let payload: {
          status?: unknown;
          step?: unknown;
          model?: unknown;
        } = {};
        try {
          payload = JSON.parse(event.data) as typeof payload;
        } catch {
          // Старый формат — `data` это плоская строка статуса.
          return;
        }
        const issueId = event.issueId;
        if (!issueId) return;

        if (payload.status === 'running' && typeof payload.step === 'string') {
          const step = payload.step;
          const model = typeof payload.model === 'string' ? payload.model : null;
          setState((current) =>
            current.status === 'ready'
              ? {
                  ...current,
                  issues: current.issues.map((issue) =>
                    issue.id === issueId
                      ? { ...issue, activeStep: step, activeModel: model }
                      : issue,
                  ),
                }
              : current,
          );
          return;
        }
        if (payload.status && payload.status !== 'running') {
          setState((current) =>
            current.status === 'ready'
              ? {
                  ...current,
                  issues: current.issues.map((issue) =>
                    issue.id === issueId
                      ? {
                          ...issue,
                          activeStep: undefined,
                          activeModel: undefined,
                        }
                      : issue,
                  ),
                }
              : current,
          );
        }
      },
      onIterationStatus: (event) => {
        // `data` — JSON-строка; статус лежит внутри, а не в поле события.
        let parsed: { status?: unknown; iterationId?: unknown; needsInput?: unknown };
        try {
          parsed = JSON.parse(event.data) as typeof parsed;
        } catch {
          return;
        }
        if (!isTaskStatus(parsed.status)) return;
        const issueId = event.issueId;
        if (!issueId) return;
        const status = parsed.status;
        setState((current) =>
          current.status === 'ready'
            ? {
                ...current,
                issues: current.issues.map((issue) =>
                  issue.id === issueId ? { ...issue, status } : issue,
                ),
              }
            : current,
        );
      },
    });
  }, []);

  // Закрываем все живые потоки удаления при размонтировании списка.
  useEffect(() => {
    const streams = deleteStreamsRef.current;
    const timeouts = deleteTimeoutsRef.current;
    return () => {
      for (const unsubscribe of streams.values()) unsubscribe();
      streams.clear();
      for (const timer of timeouts.values()) clearTimeout(timer);
      timeouts.clear();
    };
  }, []);

  // Есть ли pending/preparing-задача с репозиториями — только тогда нужна
  // сводка готовности (и запрос сохранённых репозиториев).
  const needsRepoReadiness =
    state.status === 'ready' &&
    state.issues.some(
      (issue) =>
        (issue.status === 'pending' || issue.status === 'preparing') &&
        issue.repositories.length > 0,
    );

  useEffect(() => {
    if (!needsRepoReadiness || savedReposRequestedRef.current) return;
    savedReposRequestedRef.current = true;

    void (async () => {
      try {
        const repositories = await getRepositories();
        if (mountedRef.current && Array.isArray(repositories)) {
          setSavedRepos(repositories);
        }
      } catch {
        // Молча: без сохранённых репозиториев сводка просто не рендерится.
      }
    })();
  }, [needsRepoReadiness]);

  /** Закрывает SSE-поток удаления задачи (если он открыт). */
  const stopDeleteStream = useCallback((id: string) => {
    const unsubscribe = deleteStreamsRef.current.get(id);
    if (!unsubscribe) return;
    unsubscribe();
    deleteStreamsRef.current.delete(id);
  }, []);

  /** Снимает таймаут ожидания финала удаления (если он запущен). */
  const clearDeleteTimeout = useCallback((id: string) => {
    const timer = deleteTimeoutsRef.current.get(id);
    if (timer === undefined) return;
    clearTimeout(timer);
    deleteTimeoutsRef.current.delete(id);
  }, []);

  /** Снимает id со статуса «удаляется» (финал SSE или ошибка вызова). */
  const clearDeleting = useCallback(
    (id: string) => {
      clearDeleteTimeout(id);
      setDeletingIds((current) => {
        if (!current.has(id)) return current;
        const next = new Set(current);
        next.delete(id);
        return next;
      });
      setDeletingPhases((current) => {
        if (!(id in current)) return current;
        const next = { ...current };
        delete next[id];
        return next;
      });
    },
    [clearDeleteTimeout],
  );

  const handleDelete = useCallback(
    async (id: string) => {
      if (!window.confirm('Удалить задачу и всю её рабочую папку?')) return;

      setActionError(null);
      setDeleteTimeoutNotice(null);
      // Локально сразу помечаем карточку удаляемой; SSE подтвердит прогресс
      // (`issue_deleting`) и финал (`issue_deleted`).
      setDeletingIds((current) => new Set(current).add(id));

      // Страховка от «зависшего» удаления: если за `DELETE_TIMEOUT_MS` не
      // пришёл ни финал, ни ошибка — возвращаем карточку и предупреждаем.
      clearDeleteTimeout(id);
      deleteTimeoutsRef.current.set(
        id,
        setTimeout(() => {
          deleteTimeoutsRef.current.delete(id);
          clearDeleting(id);
          setDeleteTimeoutNotice(DELETE_TIMEOUT_MESSAGE);
        }, DELETE_TIMEOUT_MS),
      );

      // Подписку открываем ДО DELETE: иначе быстрые фазы и `issue_deleted`
      // можно пропустить (поток уже удалённой задачи повторно не открыть).
      if (!deleteStreamsRef.current.has(id)) {
        const unsubscribe = subscribeToIssueEvents(id, {
          onIssueDeleting: (payload) => {
            if (payload.phase === 'error') {
              stopDeleteStream(payload.issueId);
              clearDeleting(payload.issueId);
              setActionError(payload.message ?? 'Не удалось удалить задачу');
              return;
            }
            setDeletingPhases((current) => ({
              ...current,
              [payload.issueId]: payload.phase,
            }));
          },
          onIssueDeleted: (payload) => {
            stopDeleteStream(payload.issueId);
            clearDeleting(payload.issueId);
            setState((current) =>
              current.status === 'ready'
                ? {
                    ...current,
                    issues: current.issues.filter(
                      (issue) => issue.id !== payload.issueId,
                    ),
                  }
                : current,
            );
          },
        });
        deleteStreamsRef.current.set(id, unsubscribe);
      }

      try {
        await deleteIssue(id);
      } catch (error: unknown) {
        stopDeleteStream(id);
        clearDeleting(id);
        setActionError(error instanceof Error ? error.message : String(error));
      }
    },
    [clearDeleting, clearDeleteTimeout, stopDeleteStream],
  );

  const handleStopDevServers = useCallback(async (id: string) => {
    setStopError(null);
    try {
      await stopDevServers(id);
      // Backend обнуляет порт — не перезапрашиваем весь список ради одной
      // карточки, гасим индикатор/кнопку локально.
      setState((current) =>
        current.status === 'ready'
          ? {
              ...current,
              issues: current.issues.map((issue) =>
                issue.id === id
                  ? { ...issue, dev_server_port: null }
                  : issue,
              ),
            }
          : current,
      );
    } catch (error: unknown) {
      setStopError(error instanceof Error ? error.message : String(error));
    }
  }, []);

  return (
    <div className="mx-auto max-w-4xl">
      <div className="py-4">
        {actionError && (
          <p role="alert" className="mb-4 text-sm font-medium text-[#FF0033]">
            Не удалось удалить задачу: {actionError}
          </p>
        )}

        {deleteTimeoutNotice && (
          <p
            role="alert"
            data-testid="delete-timeout"
            className="mb-4 text-sm font-medium text-[#FFB000]"
          >
            {deleteTimeoutNotice}
          </p>
        )}

        {stopError && (
          <p role="alert" className="mb-4 text-sm font-medium text-[#FF0033]">
            Не удалось остановить dev-серверы: {stopError}
          </p>
        )}

        {state.status === 'loading' && (
          <p className="text-sm text-[#00FF41]/60">Загрузка…</p>
        )}

        {state.status === 'error' && (
          <p role="alert" className="text-sm font-medium text-[#FF0033]">
            Не удалось загрузить задачи: {state.message}
          </p>
        )}

        {state.status === 'ready' && state.issues.length === 0 && (
          <div className="rounded-none border border-dashed border-[#008F11] p-8 text-center text-sm text-[#00FF41]/60">
            Пока нет ни одной задачи.
          </div>
        )}

        {state.status === 'ready' && state.issues.length > 0 && (
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            {state.issues.map((issue, index) => {
              const isPulsing = PULSE_STATUSES.has(issue.status);
              const isTerminal = TERMINAL_STATUSES.has(issue.status);
              const isFailed = issue.status === 'failed';
              const isDeleting = deletingIds.has(issue.id);
              const devPort = devServerPortOf(issue);
              const accent = isTerminal
                ? 'opacity-70'
                : isFailed
                  ? 'border-l-2 border-l-[#FF0033]'
                  : isPulsing
                    ? 'border-l-2 animate-pulse-subtle'
                    : '';
              const cardClass = isDeleting
                ? 'border border-[#008F11]/20 p-3 transition-base pointer-events-none opacity-80'
                : `cursor-pointer border border-[#008F11]/20 p-3 transition-base hover:bg-[#00FF41]/5 ${accent}`;

              return (
                <div key={issue.id} className={cardAnimation(index)}>
                  <article
                    className={cardClass}
                    style={
                      isPulsing && !isDeleting
                        ? { borderLeftColor: statusColor[issue.status] }
                        : undefined
                    }
                    aria-busy={isDeleting}
                    onClick={
                      isDeleting ? undefined : () => onOpenTask?.(issue.id)
                    }
                  >
                    {isDeleting ? (
                      <div
                        data-testid="issue-deleting"
                        className="flex items-center gap-2 p-4 text-sm italic text-gray-400"
                      >
                        <span
                          aria-hidden="true"
                          className="inline-block h-3 w-3 shrink-0 animate-spin rounded-full border-2 border-[#00FF41]/30 border-t-[#00FF41]"
                        />
                        <span>Удаление...</span>
                        {deletingPhases[issue.id] && (
                          <span className="text-xs not-italic text-[#00FF41]/50">
                            {DELETE_PHASE_LABELS[deletingPhases[issue.id]] ??
                              deletingPhases[issue.id]}
                          </span>
                        )}
                      </div>
                    ) : (
                      <>
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex min-w-0 items-center gap-1.5">
                        {!NO_DOT_STATUSES.has(issue.status) && (
                          <span
                            aria-hidden="true"
                            className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full ${
                              isPulsing ? 'animate-pulse-subtle' : ''
                            }`}
                            style={{ backgroundColor: statusColor[issue.status] }}
                          />
                        )}
                        <span className="truncate font-medium text-[#00FF41]">
                          {issueKey(issue)}
                        </span>
                      </div>
                      <div className="flex shrink-0 flex-col items-end gap-0.5">
                        <span
                          data-testid="issue-status"
                          data-status={issue.status}
                          className="text-xs transition-base"
                          style={{ color: statusColor[issue.status] }}
                        >
                          {STATUS_LABELS[issue.status]}
                        </span>
                      </div>
                    </div>

                    <div className="mt-2 border-t border-[#008F11]/20 pt-2 text-xs text-[#00FF41]/80">
                      <span className="block truncate">
                        {repositoryNames(issue) || '—'}
                      </span>
                    </div>

                    <div className="mt-2 border-t border-[#008F11]/20 pt-2">
                      {(issue.status === 'pending' ||
                        issue.status === 'preparing') &&
                        issue.repositories.length > 0 && (
                          <RepoReadinessLine
                            issue={issue}
                            savedRepos={savedRepos}
                          />
                        )}
                      {issue.status !== 'pending' && (
                        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-[#00FF41]/60">
                          <IssueStats
                            issue={issue}
                            now={now}
                            activeStep={issue.activeStep}
                            activeModel={issue.activeModel}
                          />
                        </div>
                      )}
                      <div className="mt-1.5 flex items-center justify-between gap-2">
                        <span className="whitespace-nowrap text-xs text-[#00FF41]/60">
                          {formatRelativeTime(issue.created_at)}
                        </span>
                        <div className="flex min-w-0 items-center gap-2">
                          {devPort !== null && (
                            <span
                              data-testid="dev-server-port"
                              title="Порт dev-сервера"
                              className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap font-mono text-xs text-[#00FF41]"
                            >
                              <span
                                aria-hidden="true"
                                className="inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-[#00FF41] animate-pulse-subtle"
                              />
                              :{devPort}
                            </span>
                          )}
                          {devPort !== null && (
                            <button
                              type="button"
                              data-testid="stop-dev-servers"
                              aria-label={`Остановить dev-серверы ${issueKey(issue)}`}
                              title="Остановить dev-серверы"
                              className="inline-flex min-h-6 items-center justify-center rounded-none p-1 text-[#FF0033]/60 hover:text-[#FF0033] hover:bg-transparent focus-visible:text-[#FF0033] transition-base"
                              onClick={(event) => {
                                event.stopPropagation();
                                void handleStopDevServers(issue.id);
                              }}
                            >
                              <StopIcon className="h-4 w-4" />
                            </button>
                          )}
                          <span
                            data-testid="result-cell"
                            className="whitespace-nowrap"
                          >
                            {hasViewableResult(issue) ? (
                              <button
                                type="button"
                                aria-label={`Просмотреть результат ${issueKey(issue)}`}
                                title="Просмотреть результат"
                                className="rounded-none border border-[#008F11] px-2 py-1 text-xs text-[#00FF41] hover:bg-[#008F11]/20 transition-base"
                                onClick={(event) => {
                                  event.stopPropagation();
                                  onOpenResult?.(issue.id);
                                }}
                              >
                                Просмотр
                              </button>
                            ) : (
                              <span className="text-[#00FF41]/40">—</span>
                            )}
                          </span>
                          <button
                            type="button"
                            data-testid="delete-issue"
                            aria-label={`Удалить задачу ${issueKey(issue)}`}
                            title="Удалить задачу"
                            className="inline-flex min-h-6 items-center justify-center rounded-none p-1 text-[#FF0033]/50 hover:text-[#FF0033] hover:bg-transparent focus-visible:text-[#FF0033] transition-base"
                            onClick={(event) => {
                              event.stopPropagation();
                              void handleDelete(issue.id);
                            }}
                          >
                            <TrashIcon className="h-4 w-4" />
                          </button>
                        </div>
                      </div>
                    </div>
                      </>
                    )}
                  </article>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
