import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import type {
  CreateIterationRequest,
  Issue,
  IssueFile,
  Iteration,
  ModelDescriptor,
  PipelineStep,
  PromptMode,
  SessionCommand,
  SessionControlSnapshot,
  StepModels,
  StepRunStatus,
} from '@issue-resolver/shared';
import { formatDateTime, formatRelativeTime } from '@issue-resolver/shared';
import { canStartIteration, parseStepReport } from '@issue-resolver/shared';
import {
  abortIteration,
  createIteration,
  createIterationWithFiles,
  deleteIssueFile,
  getIssue,
  getIssueFiles,
  getIterations,
  getIterationControl,
  getModels,
  getQuestionAnswers,
  getStepRuns,
  promptIteration,
  sendIterationCommand,
  sendIterationMessage,
  sendUiResponse,
} from '../api/client';
import { subscribeToIssueEvents } from '../api/sse';
import {
  sessionEventsOf,
  type SessionEvent,
  type StepRunWithEvents,
} from '../api/session-events';
import AgentMarkdown from '../components/AgentMarkdown';
import AutoScrollBox from '../components/AutoScrollBox';
import FilePicker from '../components/FilePicker';
import IssueFilesList from '../components/IssueFilesList';
import MarkdownEditor from '../components/MarkdownEditor';
import SessionView from '../components/SessionView';
import SessionStatsBar, {
  formatTokens,
  resolveFooter,
  TokenDownIcon,
  TokenUpIcon,
} from '../components/SessionStatsBar';
import { statusColor, stepStatusColor } from '../theme';

const STEP_OPTIONS: ReadonlyArray<{ value: PipelineStep; label: string }> = [
  { value: 'refine', label: 'Refine' },
  { value: 'resolve', label: 'Resolve' },
  { value: 'review', label: 'Review' },
  { value: 'test', label: 'Test' },
  { value: 'pr', label: 'PR' },
];

const STEP_LABELS: Record<PipelineStep, string> = {
  refine: 'Refine',
  resolve: 'Resolve',
  review: 'Review',
  test: 'Test',
  pr: 'PR',
};

/** Канонический порядок шагов пайплайна: `resolve` не должен идти раньше
 * `refine` (порядок в форме не влияет на порядок запуска). */
const PIPELINE_ORDER: readonly PipelineStep[] = [
  'refine',
  'resolve',
  'review',
  'test',
  'pr',
];

/** Интерактивный вопрос живой pi-сессии (`extension_ui_request`). */
type QuestionEvent = Extract<SessionEvent, { type: 'question' }>;

/** Режим отправки сообщения в живую сессию: `prompt` — новая инструкция,
 * `steer` — прервать текущий ход, `followUp` — встать в очередь. */
type SendMode = 'prompt' | 'steer' | 'followUp';

/**
 * Статусы, после которых последующие шаги итерации уже не выполнятся:
 * `failed`, `aborted` (появится в StepRunStatus после синка shared, -820),
 * `needs_input` (ждёт ответа). Набор — Set<string>, чтобы не зависеть от
 * момента синка типов.
 */
const TERMINATED_STATUSES = new Set<string>([
  'failed',
  'aborted',
  'needs_input',
]);

/** Короткая пометка статуса шага для чипа итерации. */
function stepRunMark(status: StepRunStatus | 'aborted'): string {
  switch (status) {
    case 'running':
      return 'active';
    case 'success':
      return '✓';
    case 'failed':
      return '✕';
    case 'aborted':
      return 'aborted';
    case 'needs_input':
      return '!';
    case 'skipped':
      return '—';
    default:
      return 'pending';
  }
}

const STEP_RUN_STATUSES = new Set<string>([
  'pending',
  'running',
  'success',
  'failed',
  'aborted',
  'needs_input',
  'skipped',
]);

/** Проверяет, что строка из `step_status` — валидный `StepRunStatus`. */
function isStepRunStatus(value: string | undefined): value is StepRunStatus {
  return value !== undefined && STEP_RUN_STATUSES.has(value);
}

/** Harness-файл отчёта шага — не считаем его артефактом изменений агента. */
const HARNESS_RESULT_FILE = '.issue-step-result.json';

/** Человекочитаемая длительность шага: `45с` / `3м 12с` / `1ч 4м`. */
export function formatStepDuration(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms) || ms < 0) return '';
  const totalSec = Math.floor(ms / 1000);
  if (totalSec < 60) return `${totalSec}с`;
  const minutes = Math.floor(totalSec / 60);
  const seconds = totalSec % 60;
  if (minutes < 60) return `${minutes}м ${seconds}с`;
  const hours = Math.floor(minutes / 60);
  return `${hours}ч ${minutes % 60}м`;
}

/**
 * Длительность шага: для активного — `now - created_at` (живой тик), для
 * терминального — `updated_at - created_at`.
 */
function stepDurationMs(
  run: Pick<StepRunWithEvents, 'created_at' | 'updated_at'>,
  live: boolean,
  now: number,
): number | null {
  const created = Date.parse(run.created_at);
  if (!Number.isFinite(created)) return null;
  const end = live ? now : Date.parse(run.updated_at);
  if (!Number.isFinite(end)) return null;
  return Math.max(0, end - created);
}

/** Инструменты, которыми агент изменяет файлы (не `read`). */
const FILE_CHANGING_TOOLS: ReadonlySet<string> = new Set(['write', 'edit']);

/** Безопасно достаёт `args.path` из tool_use (unknown → только строка). */
function toolPathOf(args: unknown): string | null {
  if (!args || typeof args !== 'object') return null;
  const path = (args as Record<string, unknown>).path;
  return typeof path === 'string' && path.length > 0 ? path : null;
}

/**
 * Уникальные файлы, изменённые write/edit (в порядке появления, `read` и
 * harness-маркер исключены). Экспортируется для точечных тестов.
 */
export function stepChangedFiles(events: SessionEvent[]): string[] {
  const seen = new Set<string>();
  const files: string[] = [];
  for (const event of events) {
    if (event.type !== 'tool_use') continue;
    if (!FILE_CHANGING_TOOLS.has(event.toolName)) continue;
    const path = toolPathOf(event.args);
    if (path === null || path.endsWith(HARNESS_RESULT_FILE)) continue;
    if (seen.has(path)) continue;
    seen.add(path);
    files.push(path);
  }
  return files;
}

/** Сегмент workspace-id нужен, чтобы отбросить служебный префикс пути. */
const UUID_SEGMENT_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Компактный путь для карточки шага. Отбрасывает сегмент workspace-uuid
 * вместе с абсолютным префиксом (`…/workspaces/<uuid>/report.html` →
 * `report.html`, `<uuid>/src/app.ts` → `src/app.ts`); после uuid остаётся до
 * двух сегментов, глубже — только basename. Без uuid абсолютный путь
 * сжимается до последних двух сегментов, относительный — как есть.
 * Экспортируется для точечных тестов.
 */
export function shortPath(path: string): string {
  const segments = path.split('/').filter(Boolean);
  const uuidIndex = segments.findIndex((segment) => UUID_SEGMENT_RE.test(segment));
  if (uuidIndex === -1) {
    if (!path.startsWith('/')) return path;
    return segments.slice(-2).join('/');
  }
  const remainder = segments.slice(uuidIndex + 1);
  if (remainder.length === 0) return segments[uuidIndex];
  if (remainder.length <= 2) return remainder.join('/');
  return remainder[remainder.length - 1];
}

/** Живой тик раз в секунду, пока `active`; останавливается на false/unmount. */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [active]);
  return now;
}

/** Inline-иконка календаря (дата создания), без внешних зависимостей. */
function CalendarIcon({ className }: { className?: string }) {
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
      <rect x="3" y="4.5" width="18" height="16" rx="2" />
      <path d="M3 9.5h18" />
      <path d="M8 3v3M16 3v3" />
    </svg>
  );
}

/** Inline-иконка обновления (дата последнего изменения). */
function RefreshIcon({ className }: { className?: string }) {
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
      <path d="M20.5 11.5a8.5 8.5 0 1 1-2.5-6" />
      <path d="M21 4v5h-5" />
    </svg>
  );
}

const inputClass =
  'w-full rounded-none border border-[#008F11] bg-[#0D0208] px-3 py-2 text-sm text-[#00FF41] outline-none placeholder:text-[#008F11] focus:border-[#00FF41] focus:shadow-[0_0_8px_rgba(0,255,65,0.35)]';
const labelClass = 'mb-1 block text-sm font-medium text-[#00FF41]/80';

interface TaskDetailProps {
  issueId?: string | null;
  onBack?: () => void;
  /** Открыть модалку результата сразу после загрузки (deep-link `…/result`). */
  autoOpenResult?: boolean;
}

type LoadState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; issue: Issue; iterations: Iteration[] };

type StepRunsState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; stepRuns: StepRunWithEvents[] };

export default function TaskDetail({
  issueId,
  onBack,
  autoOpenResult,
}: TaskDetailProps) {
  const [state, setState] = useState<LoadState>({ status: 'loading' });
  const [context, setContext] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [issueFiles, setIssueFiles] = useState<IssueFile[]>([]);
  const [deletingFileId, setDeletingFileId] = useState<string | null>(null);
  const [selectedSteps, setSelectedSteps] = useState<PipelineStep[]>([]);
  const [stepModels, setStepModels] = useState<StepModels>({});
  const [models, setModels] = useState<ModelDescriptor[]>([]);
  const [modelsLoading, setModelsLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [stepRuns, setStepRuns] = useState<StepRunsState>({ status: 'idle' });
  // Live-события сессии, разложенные по stepRunId: кладём их в SessionView
  // соответствующего шага, не дожидаясь следующего GET /step-runs.
  const [liveEventsByRun, setLiveEventsByRun] = useState<
    Record<string, SessionEvent[]>
  >({});
  const [refreshTick, setRefreshTick] = useState(0);
  const [message, setMessage] = useState('');
  const [messageSending, setMessageSending] = useState(false);
  const [messageError, setMessageError] = useState<string | null>(null);
  const [aborting, setAborting] = useState(false);
  const [abortError, setAbortError] = useState<string | null>(null);
  const [expandedStepRunId, setExpandedStepRunId] = useState<string | null>(
    null,
  );
  const modalScrollRef = useRef<HTMLDivElement | null>(null);
  const [resultOpen, setResultOpen] = useState(false);
  const [resultText, setResultText] = useState<string | null>(null);
  const [resultError, setResultError] = useState<'missing' | 'error' | null>(
    null,
  );
  const [resultLoading, setResultLoading] = useState(false);
  const [selectedIterationId, setSelectedIterationId] = useState<string | null>(
    null,
  );
  // id уже отвеченных/отменённых вопросов: гасит повторную модалку.
  const [answeredQuestionIds, setAnsweredQuestionIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [questionSubmitting, setQuestionSubmitting] = useState(false);
  const [questionError, setQuestionError] = useState<string | null>(null);
  // Живой статус шага из `step_status`: снапшот `stepRuns` не обновляется во
  // время работы, поэтому running-статус берём из SSE (ключ — stepRunId).
  const [liveStatusByRun, setLiveStatusByRun] = useState<
    Record<string, StepRunStatus>
  >({});

  // Управление живой pi-сессией (модель/thinking/очередь/компакция). `null`,
  // пока активного шаг-сеанса нет (409) или роут ещё не ответил — тогда
  // панель управления просто не рендерится.
  const [controlSnapshot, setControlSnapshot] =
    useState<SessionControlSnapshot | null>(null);
  const [controlTick, setControlTick] = useState(0);
  const [controlBusy, setControlBusy] = useState(false);
  const [controlError, setControlError] = useState<string | null>(null);
  const [sendMode, setSendMode] = useState<SendMode>('steer');
  const [compactOpen, setCompactOpen] = useState(false);
  const [compactInstructions, setCompactInstructions] = useState('');
  const [paletteIndex, setPaletteIndex] = useState(0);
  // Мягко подвести список к началу после создания новой итерации.
  const [scrollToIterations, setScrollToIterations] = useState(false);
  const panelRef = useRef<HTMLElement | null>(null);
  const iterationsRef = useRef<HTMLElement | null>(null);

  // На входе показываем верх страницы: там же — свежайшая итерация.
  useEffect(() => {
    const panel = panelRef.current;
    if (panel && typeof panel.scrollIntoView === 'function') {
      panel.scrollIntoView({ block: 'start' });
    }
  }, [issueId]);

  // После успешного создания новой итерации она становится первой в списке;
  // подводим к нему, не трогая AutoScrollBox живого шага.
  useEffect(() => {
    if (!scrollToIterations) return;
    const section = iterationsRef.current;
    if (section && typeof section.scrollIntoView === 'function') {
      section.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
    setScrollToIterations(false);
  }, [scrollToIterations]);

  /** Статус шага: живой из SSE важнее снапшота `stepRuns`. */
  const statusOf = (
    run: Pick<StepRunWithEvents, 'id' | 'status'>,
  ): StepRunStatus => liveStatusByRun[run.id] ?? run.status;

  /** Шаг активен: ещё не завершён (pending — до старта/в коротком окне). */
  const isActiveStatus = (status: StepRunStatus) =>
    status === 'running' || status === 'pending';

  useEffect(() => {
    if (!issueId) return;

    let cancelled = false;
    setState({ status: 'loading' });
    setAnsweredQuestionIds(new Set());
    setQuestionError(null);

    Promise.all([getIssue(issueId), getIterations(issueId)])
      .then(([issue, iterations]) => {
        if (cancelled) return;
        setState({
          status: 'ready',
          issue,
          iterations: [...iterations].sort((a, b) => a.number - b.number),
        });
        setSelectedSteps(issue.pipeline_steps);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setState({
          status: 'error',
          message: error instanceof Error ? error.message : String(error),
        });
      });

    return () => {
      cancelled = true;
    };
  }, [issueId]);

  useEffect(() => {
    let cancelled = false;
    setModelsLoading(true);

    getModels()
      .then((list) => {
        if (cancelled) return;
        setModels(Array.isArray(list) ? list : []);
      })
      .catch(() => {
        // Ошибка загрузки моделей не должна ронять форму — просто пустой список.
        if (cancelled) return;
        setModels([]);
      })
      .finally(() => {
        if (cancelled) return;
        setModelsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const activeIterationId =
    selectedIterationId ??
    (state.status === 'ready' && state.iterations.length > 0
      ? state.iterations[state.iterations.length - 1].id
      : null);

  useEffect(() => {
    if (!activeIterationId) {
      setStepRuns({ status: 'idle' });
      setLiveStatusByRun({});
      return;
    }

    let cancelled = false;
    setStepRuns({ status: 'loading' });
    // Смена итерации: живой статус предыдущей больше не актуален.
    setLiveStatusByRun({});

    getStepRuns(activeIterationId)
      .then((runs) => {
        if (cancelled) return;
        const loadedRuns = Array.isArray(runs) ? runs : [];
        setStepRuns({ status: 'ready', stepRuns: loadedRuns });
        // Персистентные events авторитетны: сбрасываем live-буферы для уже
        // загруженных шагов, чтобы после reload не было дублей. Буферы шагов,
        // которых пока нет в ответе, сохраняем (гонка на старте).
        setLiveEventsByRun((current) => {
          const loadedIds = new Set(loadedRuns.map((run) => run.id));
          const next: Record<string, SessionEvent[]> = {};
          let changed = false;
          for (const [runId, events] of Object.entries(current)) {
            if (loadedIds.has(runId)) {
              changed = true;
            } else {
              next[runId] = events;
            }
          }
          return changed ? next : current;
        });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setStepRuns({
          status: 'error',
          message: error instanceof Error ? error.message : String(error),
        });
      });

    // Серверные ответы авторитетны: после reload/на другом устройстве уже
    // отвеченные вопросы не должны всплывать повторно. Union с локальными
    // оптимистичными id — сбой запроса деградирует в прежнее поведение.
    getQuestionAnswers(activeIterationId)
      .then((ids) => {
        if (cancelled || !Array.isArray(ids) || ids.length === 0) return;
        setAnsweredQuestionIds((current) => {
          const next = new Set(current);
          for (const id of ids) next.add(id);
          return next;
        });
      })
      .catch(() => {
        // best-effort: без серверных ответов модалка переспросит.
      });

    return () => {
      cancelled = true;
    };
  }, [activeIterationId, refreshTick]);

  // Вложения задачи. Перезагружаются вместе с refreshTick: терминальный
  // статус итерации и создание новой итерации (см. handleSubmit).
  useEffect(() => {
    if (!issueId) return;
    let cancelled = false;
    getIssueFiles(issueId)
      .then((list) => {
        if (!cancelled) setIssueFiles(list);
      })
      .catch(() => {
        if (!cancelled) setIssueFiles([]);
      });
    return () => {
      cancelled = true;
    };
  }, [issueId, refreshTick]);

  useEffect(() => {
    if (!issueId) return;

    setLiveEventsByRun({});
    setLiveStatusByRun({});

    const unsubscribe = subscribeToIssueEvents(issueId, {
      onStepEvent: (payload, raw) => {
        const stepRunId = payload.stepRunId ?? raw.stepRunId;
        if (!stepRunId) return;
        setLiveEventsByRun((current) => ({
          ...current,
          [stepRunId]: [...(current[stepRunId] ?? []), payload.event].slice(
            -500,
          ),
        }));
      },
      onStepStatus: (event) => {
        const stepRunId = event.stepRunId;
        const status = event.data;
        if (stepRunId && isStepRunStatus(status)) {
          setLiveStatusByRun((current) => ({
            ...current,
            [stepRunId]: status,
          }));
        }
      },
      onIterationStatus: (event) => {
        // data — JSON-строка iteration_status; статус лежит внутри, а не в
        // поле самого SSEEvent. Без разбора карточка не замечает completed/failed.
        let status: string | undefined;
        try {
          status = (JSON.parse(event.data) as { status?: string }).status;
        } catch {
          status = undefined;
        }
        if (
          status === 'completed' ||
          status === 'failed' ||
          status === 'cancelled'
        ) {
          Promise.all([getIssue(issueId), getIterations(issueId)])
            .then(([issue, iterations]) => {
              setState((current) =>
                current.status === 'ready'
                  ? {
                      ...current,
                      issue,
                      iterations: [...iterations].sort(
                        (a, b) => a.number - b.number,
                      ),
                    }
                  : current,
              );
              setRefreshTick((tick) => tick + 1);
            })
            .catch(() => {
              // live-обновление не должно ронять карточку
            });
        }
      },
    });

    return unsubscribe;
  }, [issueId]);

  // Пока открыта модалка вопроса, Escape обрабатывается ею: фоновую
  // карточку шага не закрываем. Значение синхронизируем через ref ниже
  // (объявление pendingQuestion идёт после эффектов).
  const pendingQuestionRef = useRef<QuestionEvent | null>(null);

  useEffect(() => {
    if (expandedStepRunId === null) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !pendingQuestionRef.current) {
        setExpandedStepRunId(null);
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [expandedStepRunId]);

  useEffect(() => {
    if (!resultOpen) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setResultOpen(false);
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [resultOpen]);

  // Deep-link из списка задач: `#/tasks/<id>/result` сразу открывает
  // модалку результата после готовности задачи. `openResult` — function
  // declaration (hoisted), поэтому доступен здесь. Одноразово: ref гасит
  // повторные срабатывания на ре-рендерах.
  const autoOpenedResultRef = useRef(false);
  useEffect(() => {
    if (
      autoOpenResult &&
      state.status === 'ready' &&
      !autoOpenedResultRef.current
    ) {
      autoOpenedResultRef.current = true;
      void openResult();
    }
  }, [autoOpenResult, state.status, openResult]);

  const expandedStepRun =
    expandedStepRunId !== null && stepRuns.status === 'ready'
      ? (stepRuns.stepRuns.find((run) => run.id === expandedStepRunId) ?? null)
      : null;
  const expandedEvents = expandedStepRun
    ? [
        ...sessionEventsOf(expandedStepRun),
        ...(liveEventsByRun[expandedStepRun.id] ?? []),
      ]
    : [];

  // Модалка вывода: как у pi — новые события прокручивают лог вниз.
  useEffect(() => {
    const el = modalScrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [expandedEvents]);

  // Question-события активной итерации (персист + live) в порядке появления,
  // без дублей по id. Учитываем только ещё выполняющиеся шаги: вопрос
  // завершённого прогона не должен открывать модалку даже без ответа (иначе
  // персистентные вопросы Refine всплывают при работающем Resolve).
  const questionEvents = useMemo<QuestionEvent[]>(() => {
    if (stepRuns.status !== 'ready') return [];
    const seen = new Set<string>();
    const questions: QuestionEvent[] = [];
    for (const run of stepRuns.stepRuns) {
      if (!isActiveStatus(statusOf(run))) continue;
      for (const event of [
        ...sessionEventsOf(run),
        ...(liveEventsByRun[run.id] ?? []),
      ]) {
        if (event.type === 'question' && !seen.has(event.id)) {
          seen.add(event.id);
          questions.push(event);
        }
      }
    }
    return questions;
  }, [stepRuns, liveEventsByRun, liveStatusByRun]);

  // Вопрос уместен, только пока активная итерация ещё выполняется, шаг
  // активен (running/pending — см. фильтр `questionEvents`) и ответ не пришёл
  // ни от сервера, ни локально. Персистентные вопросы завершённых прогонов и
  // уже отвеченные (`question-answers`) не всплывают после перезагрузки.
  const activeIteration =
    state.status === 'ready'
      ? state.iterations.find((iteration) => iteration.id === activeIterationId)
      : undefined;

  const pendingQuestion =
    activeIteration?.status === 'running' && activeIterationId
      ? (questionEvents.find(
          (question) => !answeredQuestionIds.has(question.id),
        ) ?? null)
      : null;

  // window-хендлер Escape не видит pendingQuestion напрямую — держим ref в
  // актуальном состоянии, чтобы фоновая карточка не закрывалась под модалкой.
  useEffect(() => {
    pendingQuestionRef.current = pendingQuestion;
  }, [pendingQuestion]);

  const iterationRunning = activeIteration?.status === 'running';

  // Опрос снимка управления, пока итерация выполняется. При 409/отсутствии
  // живого шаг-сеанса `getIterationControl` возвращает null → панель скрыта.
  useEffect(() => {
    if (!activeIterationId || !iterationRunning) {
      setControlSnapshot(null);
      return;
    }

    let cancelled = false;
    const load = () => {
      void getIterationControl(activeIterationId).then((snapshot) => {
        if (!cancelled) setControlSnapshot(snapshot);
      });
    };
    load();
    const timer = window.setInterval(load, 4000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [activeIterationId, iterationRunning, controlTick]);

  // `editor_text` из живой сессии префилит поле ввода (последнее событие).
  const lastEditorText = useMemo(() => {
    let text: string | null = null;
    for (const event of expandedEvents) {
      if (event.type === 'editor_text') text = event.text;
    }
    return text;
  }, [expandedEvents]);

  useEffect(() => {
    if (lastEditorText !== null) setMessage(lastEditorText);
  }, [lastEditorText]);

  const canStart =
    state.status === 'ready' ? canStartIteration(state.iterations) : false;
  // Новые итерации показываем первыми; сам state не мутируем —
  // activeIterationId по умолчанию берёт последний (свежайший) элемент.
  const orderedIterations =
    state.status === 'ready'
      ? [...state.iterations].sort((a, b) => b.number - a.number)
      : [];
  const prAvailable =
    state.status === 'ready' && state.issue.repositories.length > 0;
  const resultAvailable =
    state.status === 'ready' &&
    (state.issue.desired_result === 'md' ||
      state.issue.desired_result === 'html');
  const hint = !context.trim()
    ? 'Укажи контекст для новой итерации.'
    : selectedSteps.includes('review')
      ? 'После Resolver автоматически запустится Reviewer.'
      : 'Итерация завершится сразу после работы Resolver.';

  // Один живой тик на все карточки шагов: активные показывают elapsed.
  const anyActiveStep =
    stepRuns.status === 'ready' &&
    stepRuns.stepRuns.some((run) => isActiveStatus(statusOf(run)));
  const now = useNow(anyActiveStep);

  function toggleStep(step: PipelineStep) {
    if (step === 'pr' && !prAvailable) return;
    setSelectedSteps((current) =>
      current.includes(step)
        ? current.filter((value) => value !== step)
        : [...current, step],
    );
  }

  function updateStepModel(step: PipelineStep, value: string) {
    setStepModels((current) => {
      const next: StepModels = { ...current };
      if (value) {
        next[step] = value;
      } else {
        delete next[step];
      }
      return next;
    });
  }

  // Модель шага доступна только когда шаг отмечен (resolve отмечен всегда).
  const chosenSteps = new Set<PipelineStep>(['resolve', ...selectedSteps]);

  // Палитра слэш-команд: при вводе `/…` фильтруем команды живой сессии.
  const slashQuery = message.startsWith('/') ? message.slice(1) : null;
  const commandMatches =
    slashQuery !== null && controlSnapshot
      ? controlSnapshot.commands
          .filter((command) =>
            command.name.toLowerCase().includes(slashQuery.toLowerCase()),
          )
          .slice(0, 12)
      : [];
  const controlState = controlSnapshot?.state ?? null;
  const currentModelValue =
    controlState?.provider && controlState.modelId
      ? modelOptionValue(controlState.provider, controlState.modelId)
      : '';
  const activePaletteIndex =
    commandMatches.length > 0
      ? Math.min(paletteIndex, commandMatches.length - 1)
      : 0;
  // Заполненная builtin-команда: показываем подсказку аргументов под полем.
  const filledCommand = controlSnapshot?.commands.find(
    (command) =>
      message === `/${command.name} ` ||
      message.startsWith(`/${command.name} `),
  );
  const commandHint = filledCommand?.argumentHint ?? null;

  // Новый ввод сбрасывает выбор в палитре слэш-команд.
  useEffect(() => {
    setPaletteIndex(0);
  }, [message]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!issueId) return;
    if (!canStart) return;

    const issue = state.status === 'ready' ? state.issue : null;

    // Шаг PR допустим только при наличии хотя бы одного репозитория.
    const orderedSteps = PIPELINE_ORDER.filter((step) => chosenSteps.has(step));
    const effectiveSteps = prAvailable
      ? orderedSteps
      : orderedSteps.filter((step) => step !== 'pr');

    // В тело идут только модели выбранных шагов.
    const activeStepModels = Object.fromEntries(
      Object.entries(stepModels).filter(
        ([step]) =>
          chosenSteps.has(step as PipelineStep) &&
          (step !== 'pr' || prAvailable),
      ),
    ) as StepModels;

    const request: CreateIterationRequest = {
      context,
      is_review_need: selectedSteps.includes('review'),
      review_context: '',
      steps: effectiveSteps.length > 0 ? effectiveSteps : undefined,
      step_models:
        Object.keys(activeStepModels).length > 0 ? activeStepModels : undefined,
    };

    setFormError(null);
    setSubmitting(true);

    try {
      if (files.length > 0) {
        await createIterationWithFiles(issueId, request, files);
      } else {
        await createIteration(issueId, request);
      }
      const iterations = await getIterations(issueId);
      setState((current) =>
        current.status === 'ready'
          ? {
              ...current,
              iterations: [...iterations].sort((a, b) => a.number - b.number),
            }
          : current,
      );
      setContext('');
      setFiles([]);
      setSelectedSteps(issue?.pipeline_steps ?? []);
      setScrollToIterations(true);
      setRefreshTick((tick) => tick + 1);
    } catch (error) {
      setFormError(error instanceof Error ? error.message : String(error));
    } finally {
      setSubmitting(false);
    }
  }

  async function handleDeleteFile(fileId: string) {
    setDeletingFileId(fileId);
    try {
      await deleteIssueFile(fileId);
      setIssueFiles((current) => current.filter((file) => file.id !== fileId));
    } catch {
      // best-effort: ошибка удаления не должна ронять карточку
    } finally {
      setDeletingFileId(null);
    }
  }

  async function handleMessageSubmit(iterationId: string, text: string) {
    const trimmed = text.trim();
    if (!trimmed) return;

    setMessageError(null);
    setMessageSending(true);

    try {
      if (controlSnapshot) {
        // Слэш-команды и режим prompt — новая инструкция (без mode);
        // steer/followUp адресно уходят в живую сессию.
        const mode: PromptMode | undefined =
          trimmed.startsWith('/') || sendMode === 'prompt'
            ? undefined
            : sendMode;
        const result = await promptIteration(iterationId, trimmed, mode);
        if (!result.ok) {
          // Обработанный, но отвергнутый builtin (напр. `/thinking bogus`):
          // показываем серверную причину, черновик НЕ чистим.
          setMessageError(
            result.error ?? 'Не удалось отправить сообщение',
          );
        } else {
          setMessage('');
        }
        setControlTick((tick) => tick + 1);
      } else {
        await sendIterationMessage(iterationId, trimmed);
        setMessage('');
      }
    } catch (error) {
      setMessageError(error instanceof Error ? error.message : String(error));
    } finally {
      setMessageSending(false);
    }
  }

  async function handleAbort(iterationId: string) {
    setAbortError(null);
    setAborting(true);

    try {
      await abortIteration(iterationId);
    } catch (error) {
      setAbortError(error instanceof Error ? error.message : String(error));
    } finally {
      setAborting(false);
    }
  }

  async function handleQuestionResponse(
    question: QuestionEvent,
    payload: { value?: string; confirmed?: boolean; cancelled?: boolean },
  ) {
    if (!activeIterationId) return;
    setQuestionError(null);
    setQuestionSubmitting(true);

    try {
      await sendUiResponse(activeIterationId, {
        id: question.id,
        ...payload,
      });
    } catch (error) {
      setQuestionError(error instanceof Error ? error.message : String(error));
    } finally {
      setQuestionSubmitting(false);
      // id гасится и при ошибке, чтобы модалка не зацикливалась; текст ошибки
      // остаётся в баннере задачи.
      setAnsweredQuestionIds((current) => {
        const next = new Set(current);
        next.add(question.id);
        return next;
      });
    }
  }

  /** Отправляет управляющую команду живой сессии и обновляет снимок. */
  async function runControlCommand(command: SessionCommand) {
    if (!activeIterationId) return;
    setControlError(null);
    setControlBusy(true);

    try {
      const result = await sendIterationCommand(activeIterationId, command);
      if (!result.ok) {
        setControlError(result.error ?? 'Команда не выполнена');
      }
    } catch (error) {
      setControlError(error instanceof Error ? error.message : String(error));
    } finally {
      setControlBusy(false);
      setControlTick((tick) => tick + 1);
    }
  }

  /** Кодирует пару (provider, modelId) в значение `<option>`. */
  function modelOptionValue(provider: string, id: string): string {
    return `${provider}/${id}`;
  }

  function handleModelChange(value: string) {
    if (value === '__cycle__') {
      void runControlCommand({ type: 'cycle_model' });
      return;
    }
    const slash = value.indexOf('/');
    if (slash <= 0) return;
    void runControlCommand({
      type: 'set_model',
      provider: value.slice(0, slash),
      modelId: value.slice(slash + 1),
    });
  }

  function handleThinkingChange(level: string) {
    if (!level) return;
    void runControlCommand({ type: 'set_thinking_level', level });
  }

  function submitCompact() {
    const instructions = compactInstructions.trim();
    void runControlCommand({
      type: 'compact',
      ...(instructions ? { instructions } : {}),
    });
    setCompactOpen(false);
    setCompactInstructions('');
  }

  /** Возврат текста из очереди в композер: append, не перезапись черновика. */
  function recallQueued(text: string) {
    setMessage((current) =>
      current.trim() ? `${current.trimEnd()} ${text}` : text,
    );
  }

  async function openResult() {
    setResultOpen(true);
    setResultText(null);
    setResultError(null);
    if (state.status !== 'ready') return;
    // HTML отдаётся как есть через iframe; markdown (md) тянем текстом.
    if (state.issue.desired_result !== 'md') return;

    setResultLoading(true);
    try {
      const response = await fetch(
        `/issue-resolver/api/v1/issues/${state.issue.id}/result`,
      );
      if (response.status === 404) {
        setResultError('missing');
        return;
      }
      if (!response.ok) {
        setResultError('error');
        return;
      }
      setResultText(await response.text());
    } catch {
      setResultError('error');
    } finally {
      setResultLoading(false);
    }
  }

  if (!issueId) {
    return (
      <section className="panel mx-auto max-w-3xl py-6 px-3 sm:px-4 md:px-6">
        <header className="mb-6">
          <h2 className="glow text-xl font-semibold text-[#00FF41]">Задача</h2>
        </header>
        <div className="rounded-none border border-dashed border-[#008F11] p-8 text-center text-sm text-[#00FF41]/60">
          Выберите задачу из списка.
        </div>
      </section>
    );
  }

  return (
    <section
      ref={panelRef}
      className="panel mx-auto max-w-3xl py-6 px-3 sm:px-4 md:px-6"
    >
      <div className="mb-4 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
        <button
          type="button"
          className="hidden min-h-12 text-sm font-medium text-[#008F11] hover:text-[#00FF41] sm:inline-flex"
          onClick={() => onBack?.()}
        >
          ← Мои задачи
        </button>

        {state.status === 'ready' && (
          <div className="flex shrink-0 items-center gap-3 text-xs text-[#00FF41]/60">
            <span
              data-testid="issue-created-at"
              title="Создана"
              aria-label="Создана"
              className="inline-flex items-center gap-1"
            >
              <CalendarIcon className="h-4 w-4" />
              <time dateTime={state.issue.created_at}>
                {formatDateTime(state.issue.created_at)}
              </time>
            </span>
            <span
              data-testid="issue-updated-at"
              title="Обновлена"
              aria-label="Обновлена"
              className="inline-flex items-center gap-1"
            >
              <RefreshIcon className="h-4 w-4" />
              <time dateTime={state.issue.updated_at}>
                {formatDateTime(state.issue.updated_at)}
              </time>
            </span>
          </div>
        )}
      </div>

      {state.status === 'loading' && (
        <p className="text-sm text-[#00FF41]/60">Загрузка…</p>
      )}

      {state.status === 'error' && (
        <p role="alert" className="text-sm font-medium text-[#FF0033]">
          Не удалось загрузить задачу: {state.message}
        </p>
      )}

      {state.status === 'ready' && (
        <>
          {questionError && (
            <p
              role="alert"
              data-testid="question-error"
              className="mb-4 text-sm font-medium text-[#FF0033]"
            >
              Не удалось ответить на вопрос: {questionError}
            </p>
          )}
          <header className="mb-6">
            <div className="flex flex-wrap items-center gap-3">
              <h2 className="glow min-w-0 break-words text-xl font-semibold text-[#00FF41]">
                {state.issue.title}
              </h2>
              <span
                className="shrink-0 text-xs uppercase tracking-wider"
                style={{ color: statusColor[state.issue.status] }}
              >
                {state.issue.status}
              </span>
            </div>
            {resultAvailable && (
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  data-testid="open-result"
                  onClick={() => void openResult()}
                  className="min-h-9 rounded-none border border-[#00FF41] bg-[#003B00] px-3 py-1 text-xs font-medium text-[#00FF41] hover:bg-[#00FF41] hover:text-[#0D0208]"
                >
                  Показать результат
                </button>
                <a
                  data-testid="download-result"
                  href={`/issue-resolver/api/v1/issues/${state.issue.id}/result/download`}
                  download
                  className="min-h-9 inline-flex items-center rounded-none border border-[#008F11] px-3 py-1 text-xs font-medium text-[#00FF41]/80 hover:border-[#00FF41] hover:text-[#00FF41]"
                >
                  Скачать
                </a>
              </div>
            )}
            {state.issue.jira_issue_url && (
              <a
                className="mt-2 inline-block break-all text-sm text-[#00B4FF] underline"
                href={state.issue.jira_issue_url}
                target="_blank"
                rel="noreferrer"
              >
                {state.issue.jira_issue_url}
              </a>
            )}
          </header>

          <div className="mb-8 grid gap-4 md:grid-cols-2">
            {state.issue.repositories.map((repository) => (
              <div
                key={repository.id}
                className="rounded-none border border-[#008F11] p-4 text-sm"
              >
                <p className="break-all text-[#00FF41]">
                  {repository.repository_url}
                </p>
                <p className="mt-1 text-[#00FF41]/60">
                  Ветка: {repository.branch_name}
                </p>
                {repository.create_mr && (
                  <span
                    data-testid="repo-mr-badge"
                    className="mt-2 inline-block border border-[#00B4FF] px-2 py-0.5 text-xs text-[#00B4FF]"
                  >
                    MR
                  </span>
                )}
              </div>
            ))}
          </div>

          <IssueFilesList
            files={issueFiles}
            iterations={state.iterations}
            onDelete={handleDeleteFile}
            deletingId={deletingFileId}
          />

          {canStart && (
          <section className="mb-8">
            <h3 className="glow mb-1 text-lg font-semibold text-[#00FF41]">
              Новая итерация
            </h3>
            <p className="mb-4 text-sm text-[#00FF41]/60">
              Добавь новый контекст и запусти ещё одну попытку решения задачи.
            </p>

            <form className="space-y-4" onSubmit={handleSubmit}>
              <div>
                <label className={labelClass} htmlFor="iteration-context">
                  Контекст итерации
                </label>
                <MarkdownEditor
                  id="iteration-context"
                  value={context}
                  onChange={setContext}
                  disabled={!canStart}
                  placeholder="Например: попробуй другой подход, обрати внимание на обработку ошибок и добавь тесты…"
                  aria-label="Контекст итерации"
                  minHeight="6rem"
                />
              </div>

              <FilePicker
                id="iteration-files"
                files={files}
                onChange={setFiles}
                disabled={!canStart}
              />

              <fieldset disabled={!canStart}>
                <legend className={labelClass}>Шаги пайплайна</legend>
                <div className="space-y-3">
                  {STEP_OPTIONS.map((step) => {
                    const isResolve = step.value === 'resolve';
                    const prBlocked = step.value === 'pr' && !prAvailable;
                    const checked =
                      isResolve || (!prBlocked && selectedSteps.includes(step.value));
                    const modelEnabled =
                      chosenSteps.has(step.value) && !prBlocked;
                    return (
                      <div
                        key={step.value}
                        className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between"
                      >
                        <label className="flex items-center gap-2 text-sm text-[#00FF41]/80">
                          <input
                            type="checkbox"
                            className="accent-[#00FF41]"
                            checked={checked}
                            disabled={isResolve || prBlocked}
                            onChange={() => toggleStep(step.value)}
                          />
                          {isResolve
                            ? 'Resolve (всегда)'
                            : prBlocked
                              ? `${step.label} (нужен репозиторий)`
                              : step.label}
                        </label>
                        {modelEnabled && (
                          <select
                            aria-label={`Модель для шага ${step.label}`}
                            className={`${inputClass} sm:w-64`}
                            value={stepModels[step.value] ?? ''}
                            onChange={(event) =>
                              updateStepModel(step.value, event.target.value)
                            }
                            disabled={modelsLoading}
                          >
                            <option value="">По умолчанию</option>
                            {models.map((model) => (
                              <option key={model.id} value={model.id}>
                                {model.name ?? model.id}
                              </option>
                            ))}
                          </select>
                        )}
                      </div>
                    );
                  })}
                </div>
              </fieldset>

              {formError && (
                <p role="alert" className="text-sm font-medium text-[#FF0033]">
                  {formError}
                </p>
              )}

              <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
                <p className="text-xs text-[#00FF41]/60">{hint}</p>
                <button
                  type="submit"
                  disabled={!canStart || !context.trim() || submitting}
                  className="min-h-12 w-full rounded-none border border-[#00FF41] bg-[#003B00] px-5 py-2 text-sm font-medium text-[#00FF41] shadow-[0_0_10px_rgba(0,255,65,0.35)] hover:bg-[#00FF41] hover:text-[#0D0208] disabled:opacity-50 md:w-auto"
                >
                  {submitting
                    ? 'Создание итерации…'
                    : 'Запустить новую итерацию'}
                </button>
              </div>
            </form>
          </section>
          )}

          <section ref={iterationsRef} className="mb-8">
            <h3 className="glow mb-1 text-lg font-semibold text-[#00FF41]">
              Итерации
            </h3>
            <p className="mb-4 text-sm text-[#00FF41]/60">
              История запусков задачи и дополнительный контекст для каждого
              запуска.
            </p>

            {state.iterations.length === 0 ? (
              <div className="rounded-none border border-dashed border-[#008F11] p-6 text-center text-sm text-[#00FF41]/60">
                Итераций пока нет.
              </div>
            ) : (
              <ul className="space-y-3">
                {orderedIterations.map((iteration) => {
                  const isSelected = iteration.id === activeIterationId;
                  return (
                  <li
                    key={iteration.id}
                    role="button"
                    tabIndex={0}
                    onClick={() => setSelectedIterationId(iteration.id)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault();
                        setSelectedIterationId(iteration.id);
                      }
                    }}
                    className={`cursor-pointer rounded-none border border-[#008F11] p-4 text-sm${isSelected ? ' ring-1 ring-[#00FF41] bg-[#003B00]/40' : ''}`}
                  >
                    <div className="flex flex-wrap items-center gap-3">
                      <span className="text-[#00FF41]">
                        Итерация #{iteration.number}
                      </span>
                      <span
                        className="text-xs uppercase tracking-wider"
                        style={{ color: statusColor[iteration.status] }}
                      >
                        {iteration.status}
                      </span>
                      <time
                        className="text-xs text-[#00FF41]/60"
                        dateTime={iteration.created_at}
                        title={formatDateTime(iteration.created_at)}
                      >
                        {formatRelativeTime(iteration.created_at)}
                      </time>
                      {iteration.status === 'running' && (
                        <button
                          type="button"
                          data-testid="abort-iteration"
                          disabled={aborting}
                          onClick={(event) => {
                            event.stopPropagation();
                            void handleAbort(iteration.id);
                          }}
                          className="min-h-8 shrink-0 border border-[#FF0033] bg-[#2A0008] px-3 py-1 text-xs font-medium text-[#FF0033] hover:bg-[#FF0033] hover:text-[#0D0208] disabled:opacity-50"
                        >
                          {aborting ? 'Прерываем…' : 'Прервать'}
                        </button>
                      )}
                    </div>

                    {iteration.status === 'running' && abortError && (
                      <p
                        role="alert"
                        className="mt-2 text-xs font-medium text-[#FF0033]"
                      >
                        {abortError}
                      </p>
                    )}

                    {iteration.context && (
                      <p className="mt-2 whitespace-pre-wrap break-words text-[#00FF41]/80">
                        {iteration.context}
                      </p>
                    )}

                    {iteration.steps.length > 0 && (
                      <ul className="mt-2 flex flex-wrap gap-2">
                        {(() => {
                          // Терминальность накапливается по порядку шагов:
                          // после первого failed/aborted/needs_input все
                          // последующие уже не выполнятся → `skipped`.
                          let terminated = false;
                          return iteration.steps.map((step) => {
                            if (!isSelected) {
                              return (
                                <li
                                  key={step}
                                  className="border border-[#008F11] px-2 py-0.5 text-xs text-[#00FF41]/80"
                                >
                                  {step}
                                </li>
                              );
                            }
                            const run = stepRuns.status === 'ready'
                              ? stepRuns.stepRuns
                                  .filter(
                                    (candidate) => candidate.step === step,
                                  )
                                  .sort((a, b) => b.attempt - a.attempt)[0]
                              : undefined;
                            const status = terminated
                              ? 'skipped'
                              : run
                                ? statusOf(run)
                                : 'pending';
                            if (TERMINATED_STATUSES.has(status)) {
                              terminated = true;
                            }
                            const isActive = isActiveStatus(status);
                            return (
                              <li
                                key={step}
                                data-testid={`step-chip-${step}`}
                                data-status={status}
                                className={`flex items-center gap-1 border px-2 py-0.5 text-xs${
                                  isActive
                                    ? ' animate-pulse border-[#00FF41] text-[#00FF41]'
                                    : ' border-[#008F11]'
                                }`}
                                style={
                                  isActive
                                    ? undefined
                                    : { color: stepStatusColor[status] }
                                }
                              >
                                <span>{step}</span>
                                <span aria-hidden="true">
                                  {stepRunMark(status)}
                                </span>
                              </li>
                            );
                          });
                        })()}
                      </ul>
                    )}

                    {isSelected && (
                      <div
                        data-testid="iteration-steps"
                        className="mt-3 border-t border-[#008F11]/40 pt-3"
                      >
                        <h4 className="mb-2 text-xs uppercase tracking-wider text-[#00FF41]/60">
                          Шаги
                        </h4>
                        {stepRuns.status === 'loading' && (
                          <p className="text-xs text-[#00FF41]/60">
                            Загрузка шагов…
                          </p>
                        )}
                        {stepRuns.status === 'error' && (
                          <p
                            role="alert"
                            className="text-xs font-medium text-[#FF0033]"
                          >
                            Не удалось загрузить шаги: {stepRuns.message}
                          </p>
                        )}
                        {stepRuns.status === 'ready' &&
                          (stepRuns.stepRuns.length === 0 ? (
                            <p className="text-xs text-[#00FF41]/60">
                              Шагов пока нет
                            </p>
                          ) : (
                            <ul className="space-y-3">
                              {stepRuns.stepRuns.map((run) => {
                                const events = [
                                  ...sessionEventsOf(run),
                                  ...(liveEventsByRun[run.id] ?? []),
                                ];
                                const report = parseStepReport(
                                  run.report ?? '',
                                );
                                const runStatus = statusOf(run);
                                const aborted = (runStatus as string) === 'aborted';
                                const stepLive = isActiveStatus(runStatus);
                                const duration = formatStepDuration(
                                  stepDurationMs(run, stepLive, now),
                                );
                                const changedFiles = stepChangedFiles(events);
                                const footer = resolveFooter(
                                  events,
                                  run.stats ?? null,
                                );
                                return (
                                  <li
                                    key={run.id}
                                    data-testid="step-run-log"
                                    className="rounded-none border border-[#008F11] p-3 text-xs"
                                  >
                                    <div className="flex flex-wrap items-center gap-2">
                                      <span className="text-[#00FF41]">
                                        {STEP_LABELS[run.step]}
                                      </span>
                                      {run.attempt > 1 && (
                                        <span className="text-[#00FF41]/60">
                                          попытка {run.attempt}
                                        </span>
                                      )}
                                      <span
                                        style={{
                                          color: stepStatusColor[runStatus],
                                        }}
                                      >
                                        {runStatus}
                                      </span>
                                      <button
                                        type="button"
                                        data-testid="step-expand"
                                        onClick={(event) => {
                                          event.stopPropagation();
                                          setExpandedStepRunId(run.id);
                                        }}
                                        className="ml-auto shrink-0 border border-[#008F11] px-2 py-0.5 text-[10px] uppercase tracking-wider text-[#00FF41]/80 hover:border-[#00FF41] hover:text-[#00FF41]"
                                      >
                                        Развернуть
                                      </button>
                                    </div>

                                    {isActiveStatus(runStatus) ? (
                                      <>
                                        {pendingQuestion &&
                                          expandedStepRunId !== run.id && (
                                            <PendingQuestionBanner
                                              question={pendingQuestion}
                                            />
                                          )}
                                        <AutoScrollBox
                                          scrollKey={events.length}
                                          className="mt-2 h-[300px] overflow-auto border border-[#008F11] bg-[#000200] p-2"
                                        >
                                          <div data-testid="step-session">
                                            <SessionView
                                              events={events}
                                              stats={run.stats ?? null}
                                              running={stepLive}
                                              startedAt={run.created_at}
                                              showFooter={false}
                                            />
                                          </div>
                                        </AutoScrollBox>
                                      </>
                                    ) : aborted ? (
                                      <div
                                        data-testid="step-aborted"
                                        className="mt-2 border border-[#FF0033] bg-[#2A0008] p-2"
                                      >
                                        <p className="mb-1 text-[10px] uppercase tracking-wider text-[#FF0033]">
                                          aborted
                                        </p>
                                        <p className="text-[#FF0033]">
                                          Прервано
                                        </p>
                                      </div>
                                    ) : report ? (
                                      <div
                                        data-testid="step-summary"
                                        className="mt-2 border border-[#008F11] bg-[#000200] p-2"
                                      >
                                        <p
                                          className="mb-1 text-[10px] uppercase tracking-wider"
                                          style={{
                                            color:
                                              stepStatusColor[
                                                report.status === 'pass'
                                                  ? 'success'
                                                  : report.status === 'blocked'
                                                    ? 'needs_input'
                                                    : 'failed'
                                              ],
                                          }}
                                        >
                                          {report.status.toUpperCase()}
                                        </p>
                                        <p className="line-clamp-4 whitespace-pre-wrap break-words text-[#00FF41]/80">
                                          {report.summary}
                                        </p>
                                      </div>
                                    ) : (
                                      <p className="mt-2 text-xs text-[#00FF41]/60">
                                        Результат отсутствует.
                                      </p>
                                    )}

                                    <div
                                      data-testid="step-stats"
                                      className="mt-2 flex flex-wrap items-baseline gap-x-3 gap-y-1 border-t border-[#008F11]/40 pt-2 text-[10px] text-[#00FF41]/60"
                                    >
                                      {duration !== '' && (
                                        <span data-testid="step-duration">
                                          ⏱ {duration}
                                        </span>
                                      )}
                                      {footer && (
                                        <span data-testid="step-tokens">
                                          {footer.model !== null &&
                                            `${footer.model} · `}
                                          {footer.percent !== null &&
                                            `CTX ${Math.round(footer.percent)}% · `}
                                          <span
                                            data-testid="session-token-in"
                                            className="inline-flex items-baseline gap-0.5"
                                          >
                                            <TokenUpIcon />
                                            {formatTokens(footer.input)}
                                          </span>{' '}
                                          <span className="session-stats-sep">
                                            ·
                                          </span>{' '}
                                          <span
                                            data-testid="session-token-out"
                                            className="inline-flex items-baseline gap-0.5"
                                          >
                                            <TokenDownIcon />
                                            {formatTokens(footer.output)}
                                          </span>{' '}
                                          <span className="session-stats-sep">
                                            ·
                                          </span>{' '}
                                          кеш {formatTokens(footer.cached)}{' '}
                                          <span className="session-stats-sep">
                                            ·
                                          </span>{' '}
                                          {footer.toolCalls ?? 0} вызовов
                                        </span>
                                      )}
                                      <span data-testid="step-files">
                                        {changedFiles.length === 0
                                          ? 'Файлы не изменялись'
                                          : `Файлы: ${changedFiles
                                              .slice(0, 5)
                                              .map(shortPath)
                                              .join(', ')}${
                                              changedFiles.length > 5
                                                ? ` +${changedFiles.length - 5}`
                                                : ''
                                            }`}
                                      </span>
                                      {report &&
                                        ((report.scenarios?.length ?? 0) > 0 ||
                                          (report.findings?.length ?? 0) > 0) && (
                                          <span data-testid="step-artifacts">
                                            {[
                                              (report.scenarios?.length ?? 0) > 0
                                                ? `${report.scenarios?.length} сценариев`
                                                : null,
                                              (report.findings?.length ?? 0) > 0
                                                ? `${report.findings?.length} findings`
                                                : null,
                                            ]
                                              .filter(
                                                (part): part is string =>
                                                  part !== null,
                                              )
                                              .join(' · ')}
                                          </span>
                                        )}
                                      {run.screenshots_dir && (
                                        <span data-testid="step-screenshots">
                                          Скриншоты: {shortPath(run.screenshots_dir)}
                                        </span>
                                      )}
                                    </div>
                                  </li>
                                );
                              })}
                            </ul>
                          ))}
                      </div>
                    )}
                  </li>
                  );
                })}
              </ul>
            )}
          </section>

        </>
      )}

      {resultOpen && state.status === 'ready' && resultAvailable && (
        <div
          data-testid="result-modal"
          role="dialog"
          aria-modal="true"
          onClick={() => setResultOpen(false)}
          className="fixed inset-0 z-50 flex flex-col bg-[#0D0208]/95 py-4 px-2 sm:px-4"
        >
          <div
            className="flex min-h-0 w-full flex-1 flex-col border border-[#008F11] bg-[#0D0208]"
            onClick={(event) => event.stopPropagation()}
          >
            <header className="flex flex-wrap items-center gap-3 border-b border-[#008F11] py-4 px-2 sm:px-4">
              <span className="text-[#00FF41]">Результат</span>
              <button
                type="button"
                data-testid="result-modal-close"
                aria-label="Закрыть"
                onClick={() => setResultOpen(false)}
                className="ml-auto shrink-0 border border-[#008F11] px-3 py-1 text-sm text-[#00FF41] hover:border-[#00FF41] hover:bg-[#003B00]"
              >
                ✕
              </button>
            </header>
            <div className="min-h-0 flex-1 overflow-auto py-4 px-2 sm:px-4">
              {state.issue.desired_result === 'html' ? (
                <iframe
                  data-testid="result-html"
                  src={`/issue-resolver/api/v1/issues/${state.issue.id}/result`}
                  title="Результат"
                  className="h-full w-full border border-[#008F11] bg-white"
                />
              ) : resultLoading ? (
                <p className="text-sm text-[#00FF41]/60">
                  Загрузка результата…
                </p>
              ) : resultError === 'missing' ? (
                <p className="text-sm text-[#00FF41]/60">
                  Результат ещё не создан
                </p>
              ) : resultError === 'error' ? (
                <p
                  role="alert"
                  className="text-sm font-medium text-[#FF0033]"
                >
                  Не удалось загрузить результат
                </p>
              ) : resultText !== null ? (
                <div data-testid="result-markdown">
                  <AgentMarkdown>{resultText}</AgentMarkdown>
                </div>
              ) : null}
            </div>
          </div>
        </div>
      )}

      {expandedStepRun && (
        <div
          data-testid="step-log-modal"
          role="dialog"
          aria-modal="true"
          onClick={() => setExpandedStepRunId(null)}
          className="fixed inset-0 z-50 flex flex-col bg-[#0D0208]/95 py-4 px-2 sm:px-4"
        >
          <div
            className="flex min-h-0 w-full flex-1 flex-col border border-[#008F11] bg-[#0D0208]"
            onClick={(event) => event.stopPropagation()}
          >
            <header className="flex flex-wrap items-center gap-3 border-b border-[#008F11] py-4 px-2 sm:px-4">
              <span className="text-[#00FF41]">
                {STEP_LABELS[expandedStepRun.step]}
              </span>
              {expandedStepRun.attempt > 1 && (
                <span className="text-[#00FF41]/60">
                  попытка {expandedStepRun.attempt}
                </span>
              )}
              <span
                className="text-xs uppercase tracking-wider"
                style={{ color: stepStatusColor[statusOf(expandedStepRun)] }}
              >
                {statusOf(expandedStepRun)}
              </span>
              <button
                type="button"
                data-testid="step-log-modal-close"
                aria-label="Закрыть"
                onClick={() => setExpandedStepRunId(null)}
                className="ml-auto shrink-0 border border-[#008F11] px-3 py-1 text-sm text-[#00FF41] hover:border-[#00FF41] hover:bg-[#003B00]"
              >
                ✕
              </button>
            </header>

            <div
              ref={modalScrollRef}
              data-testid="step-log-scroll"
              className="min-h-0 flex-1 space-y-4 overflow-auto py-4 px-2 sm:px-4"
            >
              {pendingQuestion &&
                isActiveStatus(statusOf(expandedStepRun)) && (
                  <PendingQuestionBanner question={pendingQuestion} />
                )}
              {expandedEvents.length > 0 ? (
                <section>
                  <h4 className="mb-1 text-[10px] uppercase tracking-wider text-[#00FF41]/50">
                    session
                  </h4>
                  <div data-testid="modal-session">
                    <SessionView
                      events={expandedEvents}
                      stats={expandedStepRun.stats ?? null}
                      showFooter={false}
                      running={isActiveStatus(statusOf(expandedStepRun))}
                      startedAt={expandedStepRun.created_at}
                      onRecallQueued={recallQueued}
                    />
                  </div>
                </section>
              ) : (
                expandedStepRun.stdout.trim() !== '' && (
                  <section>
                    <h4 className="mb-1 text-[10px] uppercase tracking-wider text-[#00FF41]/50">
                      stdout
                    </h4>
                    <div
                      data-testid="modal-stdout"
                      className="border border-[#008F11] bg-[#000200] p-2"
                    >
                      <AgentMarkdown>{expandedStepRun.stdout}</AgentMarkdown>
                    </div>
                  </section>
                )
              )}
              {expandedStepRun.stderr.trim() !== '' && (
                <section>
                  <h4 className="mb-1 text-[10px] uppercase tracking-wider text-[#00FF41]/50">
                    stderr
                  </h4>
                  <pre
                    data-testid="modal-stderr"
                    className="overflow-x-auto whitespace-pre-wrap break-words border border-[#008F11] bg-[#000200] p-2 font-mono text-xs text-[#FF0033]"
                  >
                    {expandedStepRun.stderr}
                  </pre>
                </section>
              )}
              {expandedStepRun.report !== null &&
                expandedStepRun.report.trim() !== '' && (
                  <section>
                    <h4 className="mb-1 text-[10px] uppercase tracking-wider text-[#00FF41]/50">
                      report
                    </h4>
                    <div
                      data-testid="modal-report"
                      className="border border-[#008F11] bg-[#000200] p-2"
                    >
                      <AgentMarkdown>{expandedStepRun.report}</AgentMarkdown>
                    </div>
                  </section>
                )}
            </div>

            {isActiveStatus(statusOf(expandedStepRun)) && (
              <div className="border-t border-[#008F11] py-4 px-2 sm:px-4">
                {controlSnapshot && (
                  <div
                    data-testid="live-controls"
                    className="mb-3 flex flex-wrap items-center gap-2 text-xs"
                  >
                    <label className="flex items-center gap-1 text-[#00FF41]/70">
                      модель
                      <select
                        data-testid="control-model"
                        aria-label="Модель сессии"
                        className={`${inputClass} w-auto py-1`}
                        value={currentModelValue}
                        disabled={controlBusy}
                        onChange={(event) =>
                          handleModelChange(event.target.value)
                        }
                      >
                        {currentModelValue === '' && (
                          <option value="">
                            {controlState?.model ?? '—'}
                          </option>
                        )}
                        {controlSnapshot.models.map((model) => (
                          <option
                            key={modelOptionValue(model.provider, model.id)}
                            value={modelOptionValue(model.provider, model.id)}
                          >
                            {model.name ?? model.id}
                          </option>
                        ))}
                        <option value="__cycle__">↻ следующая</option>
                      </select>
                    </label>

                    <label className="flex items-center gap-1 text-[#00FF41]/70">
                      thinking
                      <select
                        data-testid="control-thinking"
                        aria-label="Уровень размышления"
                        className={`${inputClass} w-auto py-1`}
                        value={controlState?.thinkingLevel ?? ''}
                        disabled={controlBusy}
                        onChange={(event) =>
                          handleThinkingChange(event.target.value)
                        }
                      >
                        {controlState?.thinkingLevel === null && (
                          <option value="">—</option>
                        )}
                        {controlSnapshot.thinkingLevels.map((level) => (
                          <option key={level} value={level}>
                            {level}
                          </option>
                        ))}
                      </select>
                    </label>

                    <button
                      type="button"
                      data-testid="control-compact"
                      disabled={controlBusy}
                      onClick={() => setCompactOpen((open) => !open)}
                      className="min-h-8 border border-[#FFB000] px-2 py-0.5 text-[#FFB000] hover:bg-[#FFB000] hover:text-[#0D0208] disabled:opacity-50"
                    >
                      compact
                    </button>
                    <button
                      type="button"
                      data-testid="control-clear-queue"
                      disabled={controlBusy}
                      onClick={() =>
                        void runControlCommand({ type: 'clear_queue' })
                      }
                      className="min-h-8 border border-[#008F11] px-2 py-0.5 text-[#00FF41]/80 hover:border-[#00FF41] hover:text-[#00FF41] disabled:opacity-50"
                    >
                      очистить очередь
                    </button>
                  </div>
                )}

                {compactOpen && (
                  <div
                    data-testid="compact-panel"
                    className="mb-3 flex flex-col gap-2 sm:flex-row sm:items-center"
                  >
                    <input
                      type="text"
                      aria-label="Инструкции компакции"
                      className={`${inputClass} min-w-0 flex-1`}
                      value={compactInstructions}
                      onChange={(event) =>
                        setCompactInstructions(event.target.value)
                      }
                      placeholder="Инструкции для компакции (необязательно)…"
                    />
                    <button
                      type="button"
                      data-testid="compact-run"
                      onClick={submitCompact}
                      className="min-h-9 shrink-0 border border-[#00FF41] bg-[#003B00] px-3 py-1 text-xs font-medium text-[#00FF41] disabled:opacity-50"
                    >
                      Сжать
                    </button>
                    <button
                      type="button"
                      onClick={() => setCompactOpen(false)}
                      className="min-h-9 shrink-0 border border-[#008F11] px-3 py-1 text-xs text-[#00FF41]/80 hover:border-[#00FF41]"
                    >
                      Отмена
                    </button>
                  </div>
                )}

                <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                  <form
                    className="flex min-w-0 flex-1 flex-wrap gap-2"
                    onSubmit={(event) => {
                      event.preventDefault();
                      if (activeIterationId) {
                        void handleMessageSubmit(activeIterationId, message);
                      }
                    }}
                  >
                    {controlSnapshot && (
                      <select
                        data-testid="send-mode"
                        aria-label="Режим отправки"
                        className={`${inputClass} w-auto py-1`}
                        value={sendMode}
                        disabled={messageSending}
                        onChange={(event) =>
                          setSendMode(event.target.value as SendMode)
                        }
                      >
                        <option value="prompt">prompt</option>
                        <option value="steer">steer</option>
                        <option value="followUp">follow-up</option>
                      </select>
                    )}
                    <input
                      type="text"
                      aria-label="Сообщение"
                      className={`${inputClass} min-w-0 flex-1`}
                      value={message}
                      onChange={(event) => setMessage(event.target.value)}
                      onKeyDown={(event) => {
                        if (commandMatches.length === 0) return;
                        if (event.key === 'ArrowDown') {
                          event.preventDefault();
                          setPaletteIndex(
                            (index) => (index + 1) % commandMatches.length,
                          );
                        } else if (event.key === 'ArrowUp') {
                          event.preventDefault();
                          setPaletteIndex(
                            (index) =>
                              (index - 1 + commandMatches.length) %
                              commandMatches.length,
                          );
                        } else if (event.key === 'Enter' && !event.shiftKey) {
                          event.preventDefault();
                          setMessage(
                            `/${commandMatches[activePaletteIndex].name} `,
                          );
                        }
                      }}
                      placeholder="Написать этому агенту…"
                      disabled={messageSending}
                    />
                    <button
                      type="submit"
                      disabled={!message.trim() || messageSending}
                      className="min-h-9 shrink-0 rounded-none border border-[#00FF41] bg-[#003B00] px-3 py-1 text-xs font-medium text-[#00FF41] disabled:opacity-50"
                    >
                      {messageSending ? 'Отправка…' : 'Отправить'}
                    </button>
                  </form>
                  <button
                    type="button"
                    data-testid="abort-iteration-modal"
                    disabled={aborting}
                    onClick={() => {
                      if (activeIterationId) {
                        void handleAbort(activeIterationId);
                      }
                    }}
                    className="min-h-9 shrink-0 border border-[#FF0033] bg-[#2A0008] px-3 py-1 text-xs font-medium text-[#FF0033] hover:bg-[#FF0033] hover:text-[#0D0208] disabled:opacity-50"
                  >
                    {aborting ? 'Прерываем…' : 'Прервать'}
                  </button>
                </div>

                {commandHint !== null && (
                  <p
                    data-testid="command-hint"
                    className="mt-1 font-mono text-[10px] text-[#00FF41]/50"
                  >
                    /{filledCommand?.name} {commandHint}
                  </p>
                )}

                {commandMatches.length > 0 && (
                  <div
                    data-testid="command-palette"
                    className="mt-2 border border-[#008F11] bg-[#000200] text-xs"
                  >
                    {commandMatches.map((command, index) => (
                      <button
                        key={command.name}
                        type="button"
                        data-testid={`command-option-${command.name}`}
                        data-active={index === activePaletteIndex ? 'true' : 'false'}
                        onClick={() => setMessage(`/${command.name} `)}
                        className={`block w-full px-2 py-1 text-left hover:bg-[#003B00]${index === activePaletteIndex ? ' bg-[#003B00]' : ''}`}
                      >
                        <span className="text-[#00FF41]">
                          /{command.name}
                        </span>
                        {command.argumentHint && (
                          <span className="ml-1 font-mono text-[10px] text-[#00FF41]/40">
                            {command.argumentHint}
                          </span>
                        )}
                        <span className="ml-2 border border-[#008F11] px-1 text-[10px] uppercase tracking-wider text-[#00FF41]/60">
                          {command.source}
                        </span>
                        {command.description && (
                          <span className="ml-2 text-[#00FF41]/50">
                            {command.description}
                          </span>
                        )}
                      </button>
                    ))}
                  </div>
                )}

                {controlError && (
                  <p
                    role="alert"
                    data-testid="control-error"
                    className="mt-2 text-xs font-medium text-[#FF0033]"
                  >
                    {controlError}
                  </p>
                )}
                {messageError && (
                  <p
                    role="alert"
                    data-testid="message-error"
                    className="mt-2 text-xs font-medium text-[#FF0033]"
                  >
                    {messageError}
                  </p>
                )}
                {abortError && (
                  <p
                    role="alert"
                    className="mt-2 text-xs font-medium text-[#FF0033]"
                  >
                    {abortError}
                  </p>
                )}
              </div>
            )}

            <SessionStatsBar
              events={expandedEvents}
              stats={expandedStepRun.stats ?? null}
              className="shrink-0 border-t border-[#008F11] px-2 py-2 sm:px-4"
            />
          </div>
        </div>
      )}

      {pendingQuestion && activeIterationId && (
        <QuestionModal
          key={pendingQuestion.id}
          question={pendingQuestion}
          submitting={questionSubmitting}
          error={questionError}
          onSubmit={(payload) =>
            void handleQuestionResponse(pendingQuestion, payload)
          }
          onCancel={() =>
            void handleQuestionResponse(pendingQuestion, { cancelled: true })
          }
        />
      )}
    </section>
  );
}

/** Баннер ожидаемого ответа агента: виден на превью running-шага и в
 * развёрнутой модалке до появления интерактивной `question-modal`. */
function PendingQuestionBanner({ question }: { question: QuestionEvent }) {
  const options = question.options ?? [];
  return (
    <div
      data-testid="step-pending-question"
      className="mt-2 border border-[#FFB000] bg-[#1A1000] p-2"
    >
      <p className="text-[10px] uppercase tracking-wider text-[#FFB000]">
        Агент ждёт ответа
      </p>
      <p className="mt-1 break-words text-xs text-[#FFB000]">
        {question.title}
      </p>
      {options.length > 0 && (
        <p className="mt-1 break-words text-[10px] text-[#FFB000]/80">
          {options.join(' / ')}
        </p>
      )}
    </div>
  );
}

interface QuestionModalProps {
  question: QuestionEvent;
  submitting: boolean;
  error: string | null;
  onSubmit: (payload: { value?: string; confirmed?: boolean }) => void;
  onCancel: () => void;
}

/**
 * Модалка интерактивного вопроса pi-расширения. Тип `method` определяет
 * контрол: select → radio, confirm → Да/Нет, input → строка, editor → textarea.
 * state локальный, ремоунт по `key={question.id}` сбрасывает ответ между
 * вопросами.
 */
function QuestionModal({
  question,
  submitting,
  error,
  onSubmit,
  onCancel,
}: QuestionModalProps) {
  const [value, setValue] = useState(
    question.prefill ?? question.options?.[0] ?? '',
  );
  const isConfirm = question.method === 'confirm';
  const submitLabel = question.method === 'editor' ? 'Отправить' : 'Ответить';

  // Автофокус при монтировании (ремоунт по key={question.id}): у input/editor
  // каретка в конец значения, чтобы префилл не оставлял её в позиции 0;
  // select/confirm — автофокус на radio-варианте / кнопке «Да» в JSX.
  const inputRef = useRef<HTMLInputElement | null>(null);
  const editorRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    if (submitting) return;
    const field = inputRef.current ?? editorRef.current;
    if (!field) return;
    field.focus();
    field.setSelectionRange(field.value.length, field.value.length);
  }, []);

  return (
    <div
      data-testid="question-modal"
      role="dialog"
      aria-modal="true"
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          if (!submitting) onCancel();
        }
      }}
      className="fixed inset-0 z-50 flex items-center justify-center bg-[#0D0208]/95 py-4 px-2 sm:px-4"
    >
      <div
        data-testid="question-prompt"
        className="w-full max-w-lg border border-[#00FF41] bg-[#0D0208] py-5 px-3 sm:px-5 shadow-[0_0_18px_rgba(0,255,65,0.35)]"
      >
        <header className="mb-3 flex items-center gap-2">
          <span className="glow text-sm font-semibold text-[#00FF41]">
            Агент спрашивает
          </span>
          <span className="text-[10px] uppercase tracking-wider text-[#00FF41]/50">
            {question.method}
          </span>
        </header>

        <p className="break-words text-sm text-[#00FF41]">{question.title}</p>
        {question.message && (
          <p className="mt-2 whitespace-pre-wrap break-words text-xs text-[#00FF41]/70">
            {question.message}
          </p>
        )}

        {question.method === 'select' && (
          <fieldset
            className="mt-4 space-y-2"
            disabled={submitting}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                if (!submitting && value.trim() !== '') onSubmit({ value });
              }
            }}
          >
            {(question.options ?? []).map((option) => (
              <label
                key={option}
                className="flex cursor-pointer items-center gap-2 text-sm text-[#00FF41]/80"
              >
                <input
                  type="radio"
                  name={`question-${question.id}`}
                  className="accent-[#00FF41]"
                  value={option}
                  autoFocus={value === option}
                  checked={value === option}
                  onChange={() => setValue(option)}
                  disabled={submitting}
                />
                {option}
              </label>
            ))}
          </fieldset>
        )}

        {question.method === 'input' && (
          <input
            ref={inputRef}
            type="text"
            aria-label="Ответ"
            className={`${inputClass} mt-4`}
            value={value}
            placeholder={question.placeholder ?? ''}
            onChange={(event) => setValue(event.target.value)}
            onKeyDown={(event) => {
              if (
                event.key === 'Enter' &&
                !event.shiftKey &&
                !event.ctrlKey &&
                !event.metaKey &&
                !event.altKey
              ) {
                event.preventDefault();
                if (!submitting && value.trim() !== '') onSubmit({ value });
              }
            }}
            disabled={submitting}
          />
        )}

        {question.method === 'editor' && (
          <textarea
            ref={editorRef}
            aria-label="Ответ"
            className={`${inputClass} mt-4`}
            rows={5}
            value={value}
            placeholder={question.placeholder ?? ''}
            onChange={(event) => setValue(event.target.value)}
            onKeyDown={(event) => {
              if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
                event.preventDefault();
                if (!submitting && value.trim() !== '') onSubmit({ value });
              }
            }}
            disabled={submitting}
          />
        )}

        {error && (
          <p role="alert" className="mt-3 text-xs font-medium text-[#FF0033]">
            {error}
          </p>
        )}

        <div className="mt-5 flex flex-wrap items-center justify-end gap-2">
          {isConfirm && (
            <>
              <button
                type="button"
                disabled={submitting}
                onClick={() => onSubmit({ confirmed: false })}
                className="min-h-9 rounded-none border border-[#FF0033] px-4 py-1 text-sm font-medium text-[#FF0033] hover:bg-[#FF0033] hover:text-[#0D0208] disabled:opacity-50"
              >
                Нет
              </button>
              <button
                type="button"
                disabled={submitting}
                autoFocus
                onClick={() => onSubmit({ confirmed: true })}
                className="min-h-9 rounded-none border border-[#00FF41] bg-[#003B00] px-4 py-1 text-sm font-medium text-[#00FF41] hover:bg-[#00FF41] hover:text-[#0D0208] disabled:opacity-50"
              >
                Да
              </button>
            </>
          )}

          {!isConfirm && (
            <button
              type="button"
              disabled={submitting || value.trim() === ''}
              onClick={() => onSubmit({ value })}
              className="min-h-9 rounded-none border border-[#00FF41] bg-[#003B00] px-4 py-1 text-sm font-medium text-[#00FF41] hover:bg-[#00FF41] hover:text-[#0D0208] disabled:opacity-50"
            >
              {submitting ? 'Отправка…' : submitLabel}
            </button>
          )}

          <button
            type="button"
            data-testid="question-cancel"
            disabled={submitting}
            onClick={onCancel}
            className="min-h-9 rounded-none border border-[#008F11] px-4 py-1 text-sm font-medium text-[#00FF41]/80 hover:border-[#00FF41] hover:text-[#00FF41] disabled:opacity-50"
          >
            Отмена
          </button>
        </div>
      </div>
    </div>
  );
}