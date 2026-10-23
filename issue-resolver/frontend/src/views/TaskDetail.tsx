import {
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from 'react';
import {
  QueryClient,
  QueryClientContext,
  QueryClientProvider,
  useQueryClient,
} from '@tanstack/react-query';
import type {
  CreateIterationRequest,
  Issue,
  IssueFile,
  Iteration,
  ModelDescriptor,
  PipelineStep,
  PromptMode,
  SessionCommand,
  StepModels,
  StepThinkingLevels,
  StepRunStatus,
  WorkspaceFile,
} from '@issue-resolver/shared';
import {
  extractRepoNameFromUrl,
  formatDateTime,
  formatRelativeTime,
} from '@issue-resolver/shared';
import { canStartIteration, extractIssueKeyFromUrl, isIterationActive, parseStepReport } from '@issue-resolver/shared';
import {
  API_BASE,
  abortIteration,
  createIteration,
  createIterationWithFiles,
  updateIteration,
  deleteIssueFile,
  devServerPortOf,
  fetchReviewComments,
  getIssueFiles,
  getIterations,
  getModels,
  getQuestionAnswers,
  getReportStatus,
  getResultFiles,
  promptIteration,
  queueIteration,
  repeatIteration,
  runReportAgent,
  startIssue,
  resultFilesArchiveUrl,
  sendIterationCommand,
  sendIterationMessage,
  sendUiResponse,
  stopDevServers,
} from '../api/client';
import {
  useIssue,
  useIterationControl,
  useIterations,
  useStepRuns,
} from '../stores/queries';
import {
  DELETE_TIMEOUT_MS,
  subscribeToIssueEvents,
} from '../api/sse';
import {
  sessionEventsOf,
  type SessionEvent,
  type StepRunWithEvents,
} from '../api/session-events';
import AgentMarkdown from '../components/AgentMarkdown';
import ArtifactsModal from '../components/ArtifactsModal';
import AutoScrollBox from '../components/AutoScrollBox';
import FilePicker from '../components/FilePicker';
import PipelineStepsSection from '../components/PipelineStepsSection';
import { usePipelineSteps } from '../hooks/usePipelineSteps';
import {
  inputClass as FORM_INPUT_CLASS,
  labelClass as FORM_LABEL_CLASS,
} from '../components/formStyles';
import IssueFilesList from '../components/IssueFilesList';
import MarkdownEditor from '../components/MarkdownEditor';
import ModelThinkingSelect from '../components/ModelThinkingSelect';
import RoomAgentTabs from '../components/RoomAgentTabs';
import SessionView from '../components/SessionView';
import SessionStatsBar, {
  formatAvgSpeed,
  formatCost,
  formatInstantSpeed,
  formatTokens,
  resolveFooter,
  TokenDownIcon,
  TokenUpIcon,
} from '../components/SessionStatsBar';
import { CacheIcon } from '../components/TokenStats';
import StepReportView from '../components/StepReportView';
import { thinkingLevelsFor } from '../constants/thinking-levels';
import { statusColor, stepStatusColor } from '../theme';
import {
  REPO_PREP_COLORS,
  REPO_PREP_LABELS,
  REPO_PREP_MARKS,
  repoDevPort,
  repoFullNameFromUrl,
  repoPrepStatus,
} from './repoPrep';

const STEP_OPTIONS: ReadonlyArray<{ value: PipelineStep; label: string }> = [
  { value: 'refine', label: 'Планирование' },
  { value: 'resolve', label: 'Исполнение' },
  { value: 'review', label: 'Код-ревью' },
  { value: 'test', label: 'Тест' },
  { value: 'pr', label: 'PR' },
];

const STEP_LABELS: Record<PipelineStep, string> = {
  refine: 'Планирование',
  resolve: 'Исполнение',
  review: 'Код-ревью',
  test: 'Тест',
  pr: 'PR',
  report: 'Отчёт',
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

/**
 * Room-режим итерации: ПОСЛЕДНИЙ refine-отчёт (по attempt) рекомендовал
 * комнату. Это ровно то условие, по которому движок запускает `runRoomResolve`
 * (`planExecutionMode(execution) === 'room'`); нет refine/execution → single.
 */
function isRoomIteration(runs: StepRunWithEvents[]): boolean {
  const latestRefine = runs
    .filter((run) => run.step === 'refine')
    .sort((a, b) => b.attempt - a.attempt)[0];
  const mode = parseStepReport(latestRefine?.report ?? '')?.execution?.mode;
  // staged-резолв (последовательные этапы) отображается теми же вкладками
  // комнаты: агенты несут `stage`, порядок/подписи разбирает RoomAgentTabs.
  return mode === 'room' || mode === 'stages';
}

/** Интерактивный вопрос живой pi-сессии (`extension_ui_request`). */
type QuestionEvent = Extract<SessionEvent, { type: 'question' }>;

/** Режим отправки сообщения в живую сессию: `prompt` — новая инструкция,
 * `steer` — прервать текущий ход, `followUp` — встать в очередь. */
type SendMode = 'prompt' | 'steer' | 'followUp';

/** Статус шага подготовки рабочей папки из `workspace_progress`. */
type WorkspaceStepStatus = 'running' | 'done' | 'warning' | 'error';

/**
 * Один шаг подготовки. Ключ уникален парой step+repo: `cloning` публикуется
 * на каждый репозиторий.
 */
type WorkspaceProgressStep = {
  key: string;
  step: string;
  repo?: string;
  status: WorkspaceStepStatus;
  message?: string;
  /** Порт поднятого dev-сервера (шаг `dev_server`). */
  devPort?: number;
};

/** Накопленный прогресс разовой подготовки одной итерации. */
type WorkspaceProgress = {
  steps: WorkspaceProgressStep[];
  /** Пришёл терминальный `ready`/`error` — готовим затухание. */
  finished: boolean;
  /** Анимация исчезновения уже запущена. */
  fading: boolean;
  /** Анимация закончилась — панель больше не рендерим. */
  dismissed: boolean;
};

const WORKSPACE_STEP_LABELS: Record<string, string> = {
  creating_dirs: 'Создание рабочей папки',
  cloning: 'Клонирование',
  installing: 'Установка зависимостей',
  dev_server: 'Запуск dev-сервера',
  checking_instructions: 'Проверка инструкции запуска',
  devops: 'DevOps',
  analyzing: 'Настройка проекта',
  ready: 'Готово',
};

const WORKSPACE_STEP_STATUSES: ReadonlySet<string> = new Set([
  'running',
  'done',
  'warning',
  'error',
]);

const WORKSPACE_STEP_COLORS: Record<WorkspaceStepStatus, string> = {
  running: '#FFB000',
  done: '#00FF41',
  warning: '#FFB000',
  error: '#FF0033',
};

/** Подпись шага подготовки: если шаг привязан к репозиторию — дописываем его. */
function workspaceStepLabel(step: string, repo?: string): string {
  const label = WORKSPACE_STEP_LABELS[step] ?? step;
  return repo ? `${label} ${repo}` : label;
}

/** Иконка статуса шага: running — ⏳, done — ✓, error — ✕. */
function workspaceStepMark(status: WorkspaceStepStatus): string {
  switch (status) {
    case 'done':
      return '✓';
    case 'warning':
      return '!';
    case 'error':
      return '✕';
    default:
      return '⏳';
  }
}

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

/** Человекочитаемое имя репозитория из git URL. */
function repoShortName(url: string): string {
  const cleaned = url.replace(/\.git$/, '');
  const sshMatch = /[:/]([^/]+\/[^/]+)$/.exec(cleaned);
  if (sshMatch) return sshMatch[1];
  const segments = cleaned.replace(/^https?:\/\//, '').split('/');
  return segments.slice(-2).join('/');
}

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

const inputClass = FORM_INPUT_CLASS;
const labelClass = FORM_LABEL_CLASS;

interface TaskDetailProps {
  issueId?: string | null;
  /** Открыть модалку отчёта сразу после загрузки (deep-link `…/result`). */
  autoOpenResult?: boolean;
}

/** Имя HTML-файла отчёта для атрибута `download`. */
const RESULT_HTML_FILENAME = 'report.html';

/**
 * Ответ HEAD-проба `/result`: тип содержимого и происхождение артефакта.
 * `source` приходит из `x-artifact-source` (backend/src/routes/issues.ts):
 * `root` — свежий отчёт из корня воркспейса, `iteration-snapshot` — снапшот
 * последней завершённой итерации (то есть ПРЕДЫДУЩАЯ версия).
 */
type ArtifactMeta = {
  status: number;
  contentType: string;
  source: string | null;
  mtime: string | null;
};

/** Имя MD-файла отчёта для скачивания агентами. */
const RESULT_MD_FILENAME = 'report.md';

type LoadState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; issue: Issue; iterations: Iteration[] };

type StepRunsState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; stepRuns: StepRunWithEvents[] };

function filterArtifacts(files: IssueFile[]): IssueFile[] {
  return files.filter((file) => {
    const path = file.rel_path;
    // Исключаем служебные каталоги и lock-файлы.
    if (
      path.startsWith('node_modules/') ||
      path.startsWith('.git/') ||
      path.startsWith('.yarn/') ||
      path.startsWith('.cache/')
    ) {
      return false;
    }
    const name = file.name;
    if (
      name === 'package-lock.json' ||
      name === 'yarn.lock' ||
      name === 'bun.lockb' ||
      name === 'pnpm-lock.yaml' ||
      name.endsWith('.log')
    ) {
      return false;
    }
    return true;
  });
}

export default function TaskDetail(props: TaskDetailProps) {
  return (
    <TaskDetailQueryBoundary>
      <TaskDetailView {...props} />
    </TaskDetailQueryBoundary>
  );
}

/**
 * Гарантирует наличие QueryClient. В приложении провайдер ставит `main.tsx`,
 * но компонент (и `App`) в тестах монтируется напрямую — без провайдера любой
 * `useQuery` бросил бы «No QueryClient set». Если провайдер уже есть — просто
 * пробрасываем детей в общий клиент приложения; иначе создаём локальный клиент
 * на время жизни карточки, чтобы тесты не делили кэш между собой.
 */
function TaskDetailQueryBoundary({ children }: { children: ReactNode }) {
  const existing = useContext(QueryClientContext);
  const [fallbackClient] = useState(() =>
    existing === undefined
      ? new QueryClient({
          defaultOptions: {
            queries: {
              staleTime: 30_000,
              refetchOnWindowFocus: false,
              retry: false,
            },
          },
        })
      : null,
  );

  if (existing !== undefined || fallbackClient === null) {
    return <>{children}</>;
  }
  return (
    <QueryClientProvider client={fallbackClient}>
      {children}
    </QueryClientProvider>
  );
}

function TaskDetailView({
  issueId,
  autoOpenResult,
}: TaskDetailProps) {
  const queryClient = useQueryClient();
  const issueQuery = useIssue(issueId);
  const iterationsQuery = useIterations(issueId);
  const [state, setState] = useState<LoadState>({ status: 'loading' });
  const [context, setContext] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [issueFiles, setIssueFiles] = useState<IssueFile[]>([]);
  // Файлы, порождённые агентом в рабочей папке последней completed-итерации
  // (кроме самого артефакта отчёта).
  const [resultFiles, setResultFiles] = useState<WorkspaceFile[]>([]);
  const [artifactsOpen, setArtifactsOpen] = useState(false);
  const [deletingFileId, setDeletingFileId] = useState<string | null>(null);
  const [workerCount, setWorkerCount] = useState<number>(1);
  // Флаг: prRepoIds уже инициализированы из issue.repositories.create_mr.
  const [prRepoIdsSeeded, setPrRepoIdsSeeded] = useState(false);
  const [models, setModels] = useState<ModelDescriptor[]>([]);
  const [modelsLoading, setModelsLoading] = useState(true);
  // Шаг/модель/thinking/MR-репозитории модалки итерации — общий хук с формой
  // задачи (`usePipelineSteps`), чтобы логика не дублировалась.
  const iterationPrRepoDefaults = useMemo(
    () =>
      state.status === 'ready'
        ? state.issue.repositories.map((repository) => repository.id)
        : [],
    [state],
  );
  const {
    selectedSteps,
    setSelectedSteps,
    stepModels,
    stepThinkingLevels,
    prRepoIds,
    setPrRepoIds,
    chosenSteps,
    toggleStep,
    updateStepModel,
    updateStepThinkingLevel,
    togglePrRepo,
  } = usePipelineSteps({
    models,
    prAvailable:
      state.status === 'ready' && state.issue.repositories.length > 0,
    defaultPrRepoIds: iterationPrRepoDefaults,
  });
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  // Live-события сессии, разложенные по stepRunId: кладём их в SessionView
  // соответствующего шага, не дожидаясь следующего GET /step-runs.
  const [liveEventsByRun, setLiveEventsByRun] = useState<
    Record<string, SessionEvent[]>
  >({});
  const [refreshTick, setRefreshTick] = useState(0);
  // MR-ссылки в шапке задачи: `issue.merge_requests` — персистентные из БД
  // (переживают перезагрузку), `liveMrUrls` — из живых SSE-событий
  // `stream: 'mr'` (мгновенно, но без перезагрузки).
  const [liveMrUrls, setLiveMrUrls] = useState<string[]>([]);
  const [message, setMessage] = useState('');
  const [messageSending, setMessageSending] = useState(false);
  const [messageError, setMessageError] = useState<string | null>(null);
  const [aborting, setAborting] = useState(false);
  const [abortError, setAbortError] = useState<string | null>(null);
  const [repeatingId, setRepeatingId] = useState<string | null>(null);
  const [repeatError, setRepeatError] = useState<string | null>(null);
  const [fetchingReviewId, setFetchingReviewId] = useState<string | null>(null);
  const [queueingId, setQueueingId] = useState<string | null>(null);
  const [fetchReviewError, setFetchReviewError] = useState<string | null>(null);
  const [fetchReviewMessage, setFetchReviewMessage] = useState<string | null>(null);
  const [startingDraft, setStartingDraft] = useState(false);
  const [startDraftError, setStartDraftError] = useState<string | null>(null);

  const [expandedStepRunId, setExpandedStepRunId] = useState<string | null>(
    null,
  );
  // Модалка вывода issue-уровневого отчёта: у него нет `step_run`, поэтому
  // раскрывается отдельным флагом, а не через `expandedStepRunId`.
  const [reportExpanded, setReportExpanded] = useState(false);
  const modalScrollRef = useRef<HTMLDivElement | null>(null);
  const modalPinnedRef = useRef(true);
  /** ID прогона, к которому уже скроллили страницу — не дёргаем повторно. */
  const lastScrolledRunRef = useRef<string | null>(null);
  const [resultOpen, setResultOpen] = useState(false);
  // Метаданные артефакта отчёта (HEAD /result): откуда он взят и какого типа.
  // Нужны, чтобы НЕ совать markdown в iframe для HTML и не выдавать прошлый
  // отчёт за текущий (см. `x-artifact-source` в backend/src/routes/issues.ts).
  const [artifactMeta, setArtifactMeta] = useState<ArtifactMeta | null>(null);
  // Механические сигналы по артефактам из `/report/status`: наблюдённая модель
  // прогона и предупреждения детектов. Это место UI, а не место в артефакте:
  // имя модели запрещено в report.md/report.html (GLOBAL_AGENTS), но человек
  // должен видеть, на чём отчёт собран и чем сервер недоволен.
  const [reportMeta, setReportMeta] = useState<{
    observedModel?: string;
    warnings: string[];
  }>({ warnings: [] });
  const [jiraPreviewOpen, setJiraPreviewOpen] = useState(false);
  const [jiraPreviewText, setJiraPreviewText] = useState<string | null>(null);
  const [jiraPreviewLoading, setJiraPreviewLoading] = useState(false);
  const [selectedIterationId, setSelectedIterationId] = useState<string | null>(
    null,
  );
  // id уже отвеченных/отменённых вопросов: гасит повторную модалку.
  const [answeredQuestionIds, setAnsweredQuestionIds] = useState<Set<string>>(
    () => new Set(),
  );

  const [stoppingDevServers, setStoppingDevServers] = useState(false);
  // Задача удаляется (SSE `issue_deleting`): показываем заглушку вместо
  // карточки, а на `issue_deleted` уходим на список.
  const [deleting, setDeleting] = useState(false);
  // Предупреждение, если финал удаления не пришёл за `DELETE_TIMEOUT_MS`.
  const [deleteTimeoutError, setDeleteTimeoutError] = useState<string | null>(
    null,
  );
  const deleteTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [devServerError, setDevServerError] = useState<string | null>(null);
  const [devPortCopied, setDevPortCopied] = useState(false);
  const devPortCopiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );

  const [questionSubmitting, setQuestionSubmitting] = useState(false);
  const [questionError, setQuestionError] = useState<string | null>(null);
  // Живой статус шага из `step_status`: снапшот `stepRuns` не обновляется во
  // время работы, поэтому running-статус берём из SSE (ключ — stepRunId).
  const [liveStatusByRun, setLiveStatusByRun] = useState<
    Record<string, StepRunStatus>
  >({});
  // Прогресс разовой подготовки рабочей папки (`workspace_progress`):
  // событие issue-уровневое, id итерации в нём нет — панель одна на задачу.
  const [workspaceProgress, setWorkspaceProgress] =
    useState<WorkspaceProgress | null>(null);
  // Отчёт задачи (`report`-агент): `ready` — `report.md` уже есть,
  // `running` — генерация идёт сейчас (локальный триггер + опрос статуса).
  const [reportReady, setReportReady] = useState(false);
  const [reportRunning, setReportRunning] = useState(false);
  const [reportError, setReportError] = useState<string | null>(null);
  /** Время старта текущей генерации: старый `report.md` по mtime не засчитываем. */
  const reportStartRef = useRef(0);
  /** Ref-гарда против гонки: стейт-апдейты асинхронны, ref — мгновенный. */
  const reportRunningRef = useRef(false);
  /** Модель для ручного запуска отчёта (переопределяет step_models.report). */
  const [reportModel, setReportModel] = useState<string>('');
  /** Thinking level для ручного запуска отчёта. */
  const [reportThinkingLevel, setReportThinkingLevel] = useState<string>('');
  // Ошибка подготовки из `iteration_status` (`status: 'failed'`, поле error).
  const [iterationErrors, setIterationErrors] = useState<
    Record<string, string>
  >({});
  const progressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Управление живой pi-сессией (модель/thinking/очередь/компакция). `null`,
  // пока активного шаг-сеанса нет (409) или роут ещё не ответил — тогда
  // панель управления просто не рендерится.
  const [controlTick, setControlTick] = useState(0);
  const [controlBusy, setControlBusy] = useState(false);
  const [controlError, setControlError] = useState<string | null>(null);
  const [sendMode, setSendMode] = useState<SendMode>('steer');
  const [compactOpen, setCompactOpen] = useState(false);
  const [compactInstructions, setCompactInstructions] = useState('');
  const [paletteIndex, setPaletteIndex] = useState(0);
  // Мягко подвести список к началу после создания новой итерации.
  const [scrollToIterations, setScrollToIterations] = useState(false);
  // Модалка новой итерации: открывается по кнопке, закрывается по Escape/клику на фон/сабмиту.
  const [showIterationModal, setShowIterationModal] = useState(false);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const iterationsRef = useRef<HTMLDivElement | null>(null);

  // На входе показываем верх страницы: там же — свежайшая итерация.
  useEffect(() => {
    const panel = panelRef.current;
    if (panel && typeof panel.scrollIntoView === 'function') {
      panel.scrollIntoView({ block: 'start' });
    }
  }, [issueId]);

  // Сбрасываем таймер подсветки «Скопировано» при размонтировании.
  useEffect(
    () => () => {
      if (devPortCopiedTimerRef.current) {
        clearTimeout(devPortCopiedTimerRef.current);
      }
    },
    [],
  );

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

  /**
   * Шаг, чей неотвеченный вопрос ещё нужно показывать: помимо активных, это
   * `needs_input` — шаг завершился blocked-отчётом (exit 0 + status blocked)
   * и ждёт ответа. В карточке шага он не «живой» (там `isActiveStatus`), но
   * вопрос из его событий обязан всплывать, иначе задача в статусе `question`
   * при открытии не показывает вопрос.
   */
  const isQuestionEligibleStatus = (status: StepRunStatus) =>
    isActiveStatus(status) || status === 'needs_input';

  // Сброс per-issue UI-состояния при смене задачи (как в прежнем ручном
  // эффекте загрузки): вопрос и его ошибка не должны «протекать» на другую задачу.
  useEffect(() => {
    if (!issueId) return;
    setState({ status: 'loading' });
    setAnsweredQuestionIds(new Set());
    setQuestionError(null);
  }, [issueId]);

  // Гидратация локального `state` из кэша react-query. `state` остаётся
  // локальным, потому что SSE пишет в него живой статус задачи (см. подписку).
  useEffect(() => {
    if (!issueId) return;
    const error = issueQuery.error ?? iterationsQuery.error;
    if (issueQuery.isError || iterationsQuery.isError) {
      setState({
        status: 'error',
        message: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    if (!issueQuery.data || !iterationsQuery.data) return;
    const issue = issueQuery.data;
    setState({
      status: 'ready',
      issue,
      iterations: [...iterationsQuery.data].sort((a, b) => a.number - b.number),
    });
    setSelectedSteps(issue.pipeline_steps);
    // Первый раз инициализируем prRepoIds из create_mr флагов репозиториев.
    if (!prRepoIdsSeeded) {
      setPrRepoIds(
        new Set(
          issue.repositories
            .filter((repo) => repo.create_mr)
            .map((repo) => repo.id),
        ),
      );
      setPrRepoIdsSeeded(true);
    }
  }, [
    issueId,
    issueQuery.data,
    issueQuery.isError,
    issueQuery.error,
    iterationsQuery.data,
    iterationsQuery.isError,
    iterationsQuery.error,
    prRepoIdsSeeded,
  ]);

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

  const stepRunsQuery = useStepRuns(activeIterationId);

  // Смена итерации: живой статус предыдущей больше не актуален.
  useEffect(() => {
    setLiveStatusByRun({});
  }, [activeIterationId]);

  // `refreshTick` — сигнал SSE «перечитать прогоны» (новый шаг, терминальный
  // статус, вопрос): инвалидируем кэш step-runs текущей итерации.
  useEffect(() => {
    if (refreshTick === 0 || !activeIterationId) return;
    void queryClient.invalidateQueries({
      queryKey: ['step-runs', activeIterationId],
    });
  }, [refreshTick, activeIterationId, queryClient]);

  // Серверные ответы авторитетны: после reload/на другом устройстве уже
  // отвеченные вопросы не должны всплывать повторно. Union с локальными
  // оптимистичными id — сбой запроса деградирует в прежнее поведение.
  useEffect(() => {
    if (!activeIterationId) return;
    let cancelled = false;
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

  const stepRuns: StepRunsState = !activeIterationId
    ? { status: 'idle' }
    : stepRunsQuery.isLoading
      ? { status: 'loading' }
      : stepRunsQuery.isError
        ? {
            status: 'error',
            message:
              stepRunsQuery.error instanceof Error
                ? stepRunsQuery.error.message
                : String(stepRunsQuery.error),
          }
        : {
            status: 'ready',
            stepRuns: Array.isArray(stepRunsQuery.data)
              ? stepRunsQuery.data
              : [],
          };

  // Вложения задачи. Перезагружаются вместе с refreshTick: терминальный
  // статус итерации и создание новой итерации (см. handleSubmit).
  useEffect(() => {
    if (!issueId) return;
    let cancelled = false;
    getIssueFiles(issueId)
      .then((list) => {
        if (!cancelled) setIssueFiles(filterArtifacts(list));
      })
      .catch(() => {
        if (!cancelled) setIssueFiles([]);
      });
    return () => {
      cancelled = true;
    };
  }, [issueId, refreshTick]);

  /** Запускает затухание панели прогресса через 3с после `ready`/`error`. */
  const scheduleProgressFade = () => {
    if (progressTimerRef.current) return;
    progressTimerRef.current = setTimeout(() => {
      progressTimerRef.current = null;
      setWorkspaceProgress((current) => {
        if (!current || current.fading) return current;
        return { ...current, fading: true };
      });
    }, 3000);
  };

  /** `onAnimationEnd`: убирает отыгравшую панель из DOM. */
  const dismissProgress = () => {
    setWorkspaceProgress((current) =>
      current ? { ...current, dismissed: true } : current,
    );
  };

  useEffect(() => {
    if (!issueId) return;

    setLiveEventsByRun({});
    setLiveStatusByRun({});
    setWorkspaceProgress(null);
    setReportReady(false);
    setReportRunning(false);
    setReportError(null);
    setIterationErrors({});
    setDeleting(false);
    setDeleteTimeoutError(null);
    setLiveMrUrls([]);

    const unsubscribe = subscribeToIssueEvents(issueId, {
      // MR-ссылка шага pr приходит отдельным log-событием `stream: 'mr'`.
      // Копим её в state, чтобы показать в шапке сразу после создания MR,
      // не дожидаясь обновления issue.merge_requests в БД.
      onLog: (event) => {
        // MR-ссылка шага pr приходит отдельным log-событием `stream: 'mr'`.
        // Копим её в state, чтобы показать в шапке сразу после создания MR,
        // не дожидаясь обновления issue.merge_requests в БД.
        if (event.stream === 'mr') {
          const url = event.data.trim();
          if (!url) return;
          setLiveMrUrls((current) =>
            current.includes(url) ? current : [...current, url],
          );
          return;
        }
        // DevOps/Report шлют живой stdout/stderr обычными `log`-событиями
        // с синтетическим stepRunId
        // (`{issueId}/devops` | `{issueId}/report`). Копим чанки как
        // `text`-события SessionView, не дожидаясь GET /step-runs.
        if (event.stream !== 'stdout' && event.stream !== 'stderr') return;
        const stepRunId = event.stepRunId;
        if (!stepRunId || event.data === '') return;
        setLiveEventsByRun((current) => ({
          ...current,
          [stepRunId]: [
            ...(current[stepRunId] ?? []),
            { type: 'text' as const, text: event.data },
          ].slice(-500),
        }));
      },
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
        // `data` — плоская строка статуса ИЛИ JSON `{status, step, model}`
        // (для status='running'). Разбираем оба варианта, чтобы терминальные
        // статусы и новый формат одинаково доходили до карточки.
        let status: string = event.data;
        try {
          const parsed = JSON.parse(event.data) as { status?: unknown };
          if (typeof parsed?.status === 'string') status = parsed.status;
        } catch {
          // старый формат — строка
        }
        if (stepRunId && isStepRunStatus(status)) {
          setLiveStatusByRun((current) => ({
            ...current,
            [stepRunId]: status,
          }));
          // Снапшот `stepRuns` не знает о новом прогоне (движок создаёт
          // step_run на каждый шаг: refine→resolve), а `step_status` несёт
          // только stepRunId без step/attempt — без перечитки карточка
          // нового шага не отрисуется. Перечитываем и на терминальном
          // статусе: он же подтягивает отчёт завершившегося шага.
          setRefreshTick((tick) => tick + 1);
        }
      },
      onIterationStatus: (event) => {
        // data — JSON-строка iteration_status; статус и текст ошибки лежат
        // внутри, а не в поле самого SSEEvent. Без разбора карточка не
        // замечает completed/failed и не показывает ошибку подготовки.
        let parsedData: { status?: string; error?: string } = {};
        try {
          parsedData = JSON.parse(event.data) as {
            status?: string;
            error?: string;
          };
        } catch {
          parsedData = {};
        }
        const status = parsedData.status;
        const error =
          typeof parsedData.error === 'string' ? parsedData.error : undefined;
        const failedIterationId = event.iterationId;
        if (status === 'failed' && error && failedIterationId) {
          setIterationErrors((current) => ({
            ...current,
            [failedIterationId]: error,
          }));
        }
        if (status === 'question' || status === 'running') {
          // Живой статус задачи: `question` пока агент ждёт ответа, обратно
          // в `running` после ответа — без перезагрузки карточки.
          setState((current) =>
            current.status === 'ready'
              ? { ...current, issue: { ...current.issue, status } }
              : current,
          );
          // Вопрос дозаписывается в `step_runs.events` уже после первичной
          // загрузки. Перечитываем прогоны, чтобы вопрос, персистентный на
          // момент перехода в `question`, не терялся (напр. при переподключении
          // SSE, когда live-событие не пришло).
          if (status === 'question') {
            setRefreshTick((tick) => tick + 1);
          }
        }
        if (
          status === 'completed' ||
          status === 'failed' ||
          status === 'cancelled'
        ) {
          // На терминальной итерации бэкенд fire-and-forget спавнит
          // report-агента: показываем «⏳ Генерируется» и опрашиваем статус.
          // Гарда: если уже идёт ручной прогон — не перезатираем.
          if (reportRunningRef.current) return;
          reportStartRef.current = Date.now();
          reportRunningRef.current = true;
          setReportRunning(true);
          // Сервер — источник истины для терминального статуса: инвалидируем
          // issue/iterations, гидратация `state` подхватит свежие данные.
          void queryClient.invalidateQueries({ queryKey: ['issue', issueId] });
          void queryClient.invalidateQueries({
            queryKey: ['iterations', issueId],
          });
          setRefreshTick((tick) => tick + 1);
        }
      },
      onWorkspaceProgress: (payload) => {
        if (!WORKSPACE_STEP_STATUSES.has(payload.status)) return;
        const status = payload.status as WorkspaceStepStatus;
        // Первый шаг новой подготовки: прошлая панель уже отыграла —
        // начинаем с чистого листа (иначе dismissed-панель не вернулась бы).
        const fresh =
          payload.step === 'creating_dirs' && status === 'running';
        if (fresh && progressTimerRef.current) {
          clearTimeout(progressTimerRef.current);
          progressTimerRef.current = null;
        }
        const key = `${payload.step}:${payload.repo ?? ''}`;
        setWorkspaceProgress((current) => {
          const entry: WorkspaceProgress =
            fresh || !current
              ? { steps: [], finished: false, fading: false, dismissed: false }
              : current;
          const existing = entry.steps.findIndex((step) => step.key === key);
          const next: WorkspaceProgressStep = {
            key,
            step: payload.step,
            repo: payload.repo,
            status,
            message: payload.message,
            devPort: payload.devPort,
          };
          const steps =
            existing >= 0
              ? entry.steps.map((step, index) =>
                  index === existing ? { ...step, ...next } : step,
                )
              : [...entry.steps, next];
          const finished =
            entry.finished || payload.step === 'ready' || status === 'error';
          return { ...entry, steps, finished };
        });
        if (payload.step === 'ready' || status === 'error') {
          scheduleProgressFade();
        }
      },
      onIssueDeleting: (payload) => {
        if (payload.issueId !== issueId) return;
        if (payload.phase === 'error') {
          if (deleteTimeoutRef.current) {
            clearTimeout(deleteTimeoutRef.current);
            deleteTimeoutRef.current = null;
          }
          setDeleting(false);
          setDeleteTimeoutError(
            payload.message ?? 'Не удалось удалить задачу',
          );
          return;
        }
        setDeleting(true);
      },
      onIssueDeleted: (payload) => {
        if (payload.issueId !== issueId) return;
        if (deleteTimeoutRef.current) {
          clearTimeout(deleteTimeoutRef.current);
          deleteTimeoutRef.current = null;
        }
        setDeleting(true);
        window.location.hash = '#/';
      },
    });

    return () => {
      unsubscribe();
      if (progressTimerRef.current) {
        clearTimeout(progressTimerRef.current);
        progressTimerRef.current = null;
      }
      if (deleteTimeoutRef.current) {
        clearTimeout(deleteTimeoutRef.current);
        deleteTimeoutRef.current = null;
      }
    };
  }, [issueId]);

  // Страховка от «зависшего» удаления: если SSE замолчал и за
  // `DELETE_TIMEOUT_MS` не пришёл ни `issue_deleted`, ни `phase: 'error'` —
  // снимаем заглушку и предупреждаем, что задача могла удалиться частично.
  useEffect(() => {
    if (!deleting) return;
    deleteTimeoutRef.current = setTimeout(() => {
      deleteTimeoutRef.current = null;
      setDeleting(false);
      setDeleteTimeoutError(
        'Таймаут удаления. Задача может быть удалена частично. Обновите страницу.',
      );
    }, DELETE_TIMEOUT_MS);
    return () => {
      if (deleteTimeoutRef.current) {
        clearTimeout(deleteTimeoutRef.current);
        deleteTimeoutRef.current = null;
      }
    };
  }, [deleting]);

  useEffect(() => {
    if (expandedStepRunId === null && !reportExpanded) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        closeModal();
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [expandedStepRunId, reportExpanded]);

  useEffect(() => {
    if (!resultOpen) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setResultOpen(false);
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [resultOpen]);

  useEffect(() => {
    if (!jiraPreviewOpen) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setJiraPreviewOpen(false);
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [jiraPreviewOpen]);

  // Deep-link из списка задач: `#/tasks/<id>/result` сразу открывает
  // модалку отчёта после готовности задачи. `openResult` — function
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

  // Issue-уровневые сессии DevOps/Report: их stepRunId синтетические
  // (`{issueId}/devops` | `{issueId}/report`), событий в step_runs нет —
  // SessionView кормится только живыми `log`-чанками (text-события).
  const devopsRunId = issueId ? `${issueId}/devops` : '';
  const reportRunId = issueId ? `${issueId}/report` : '';
  const devopsEvents = liveEventsByRun[devopsRunId] ?? [];
  const reportEvents = liveEventsByRun[reportRunId] ?? [];

  /**
   * Цель модалки вывода: прогон шага ИЛИ issue-уровневый `report`-прогон.
   * У отчёта нет `step_run`, поэтому его поля выводятся из живого буфера
   * SSE (`reportEvents`) и флага прогона, а адрес управления совпадает с
   * синтетическим `sessionId` (`{issueId}/report`), под которым сессия
   * зарегистрирована в реестре. Один и тот же control-роут обслуживает обе
   * цели — `/iterations/:id/...`.
   */
  const modalTarget: {
    title: string;
    attempt: number;
    status: StepRunStatus;
    active: boolean;
    events: SessionEvent[];
    stats: StepRunWithEvents['stats'];
    stdout: string;
    stderr: string;
    report: string | null;
    startedAt: string | undefined;
    sessionId: string;
  } | null = expandedStepRun
    ? {
        title: STEP_LABELS[expandedStepRun.step],
        attempt: expandedStepRun.attempt,
        status: statusOf(expandedStepRun),
        active: isActiveStatus(statusOf(expandedStepRun)),
        events: expandedEvents,
        stats: expandedStepRun.stats ?? null,
        stdout: expandedStepRun.stdout,
        stderr: expandedStepRun.stderr,
        report: expandedStepRun.report,
        startedAt: expandedStepRun.created_at,
        sessionId: expandedStepRun.iteration_id,
      }
    : reportExpanded
      ? {
          title: STEP_LABELS.report,
          attempt: 1,
          status: reportRunning
            ? 'running'
            : reportError !== null
              ? 'failed'
              : 'success',
          active: reportRunning,
          events: reportEvents,
          stats: null,
          stdout: '',
          stderr: '',
          report: null,
          startedAt: undefined,
          sessionId: reportRunId,
        }
      : null;

  /** Закрывает модалку вывода для обеих целей (шаг и отчёт). */
  function closeModal() {
    setExpandedStepRunId(null);
    setReportExpanded(false);
  }

  // Модалка вывода: автоскролл вниз только пока пользователь прибит ко дну.
  const handleModalScroll = useCallback(() => {
    const el = modalScrollRef.current;
    if (!el) return;
    modalPinnedRef.current =
      el.scrollHeight - el.scrollTop - el.clientHeight < 50;
  }, []);

  useEffect(() => {
    const el = modalScrollRef.current;
    if (el && modalPinnedRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [modalTarget?.events]);

  // Question-события активной итерации (персист + live) в порядке появления,
  // без дублей по id. Учитываем только ещё выполняющиеся шаги: вопрос
  // завершённого прогона не должен открывать модалку даже без ответа (иначе
  // персистентные вопросы Refine всплывают при работающем Resolve).
  const questionEvents = useMemo<QuestionEvent[]>(() => {
    if (stepRuns.status !== 'ready') return [];
    const seen = new Set<string>();
    const questions: QuestionEvent[] = [];
    for (const run of stepRuns.stepRuns) {
      if (!isQuestionEligibleStatus(statusOf(run))) continue;
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

  // Неотвеченные вопросы активной итерации: каждый рисуется баннером, а
  // `activeQuestionId` определяет, какая модалка открыта. Так закрытая модалка
  // не прячет вопрос — баннер остаётся кликабельным.
  const unansweredQuestions = useMemo(
    () =>
      questionEvents.filter(
        (question) => !answeredQuestionIds.has(question.id),
      ),
    [questionEvents, answeredQuestionIds],
  );



  // Авто-скролл внутри карточки итерации к running-исполнителю.
  // Когда появляется НОВЫЙ running-шаг — скроллим его карточку в зону
  // видимости ОДИН раз. После этого пользователь свободно листает страницу.
  // Сброс: когда running-шагов нет или текущий завершился — следующий
  // новый running снова получит скролл.
  // Если есть неотвеченные вопросы — скролл не срабатывает: пользователь
  // должен видеть вопрос, а не улетать к агенту.
  useEffect(() => {
    if (unansweredQuestions.length > 0) return;
    if (stepRuns.status !== 'ready') return;
    const runs = stepRuns.stepRuns;
    const firstRunning = runs.find((run) => {
      const status = liveStatusByRun[run.id] ?? statusOf(run);
      return isActiveStatus(status);
    });
    if (!firstRunning) {
      lastScrolledRunRef.current = null;
      return;
    }

    // Уже скроллили к этому же прогону — не дёргаем страницу повторно.
    if (lastScrolledRunRef.current === firstRunning.id) return;
    lastScrolledRunRef.current = firstRunning.id;

    const timer = setTimeout(() => {
      const el = document.querySelector(
        `[data-step-run-id="${firstRunning.id}"]`,
      );
      if (el && typeof (el as HTMLElement).scrollIntoView === 'function') {
        (el as HTMLElement).scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }
    }, 100);
    return () => clearTimeout(timer);
  }, [stepRuns, liveStatusByRun, unansweredQuestions]);

  // Опрос снимка управления (react-query, refetchInterval 4с) для ЦЕЛИ
  // модалки: прогон шага адресуется id итерации, отчёт — синтетическим
  // `{issueId}/report`. При 409/отсутствии живого сеанса `getIterationControl`
  // отдаёт null → панель скрыта.
  const modalSessionId = modalTarget?.sessionId ?? null;
  const modalRunning = modalTarget?.active ?? false;
  const controlQuery = useIterationControl(modalSessionId, modalRunning);
  const controlSnapshot = modalRunning ? (controlQuery.data ?? null) : null;

  // `controlTick` — сигнал «перечитать снапшот» после управляющей команды
  // (promptIteration в handleMessageSubmit).
  useEffect(() => {
    if (controlTick === 0 || !modalSessionId) return;
    void queryClient.invalidateQueries({
      queryKey: ['iteration-control', modalSessionId],
    });
  }, [controlTick, modalSessionId, queryClient]);

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

  const canStartNormal =
    state.status === 'ready' ? canStartIteration(state.iterations) : false;
  // Можно создать черновик: есть активная итерация (running/pending/preparing),
  // но нет draft/pending.
  const hasActiveIteration =
    state.status === 'ready'
      ? state.iterations.some((it) => isIterationActive(it.status))
      : false;
  const hasDraftIteration =
    state.status === 'ready'
      ? state.iterations.some((it) => it.status === 'draft')
      : false;
  const canStartDraftForm = hasActiveIteration && !hasDraftIteration;
  const canStart = canStartNormal || canStartDraftForm;
  const submitButtonLabel = hasDraftIteration
    ? 'Сохранить черновик'
    : hasActiveIteration
      ? 'Создать черновик'
      : 'Запустить новую итерацию';
  // Новые итерации показываем первыми; сам state не мутируем —
  // activeIterationId по умолчанию берёт последний (свежайший) элемент.
  const orderedIterations =
    state.status === 'ready'
      ? [...state.iterations].sort((a, b) => b.number - a.number)
      : [];
  const prAvailable =
    state.status === 'ready' && state.issue.repositories.length > 0;
  const resultAvailable = state.status === 'ready';
  // MR-ссылки для шапки: персистентные из issue.merge_requests + живые из SSE,
  // дедуп по URL (событие и данные задачи дублируют друг друга).
  const mrItems = useMemo(() => {
    const byUrl = new Map<string, { url: string; repositoryUrl: string }>();
    const stored = state.status === 'ready' ? state.issue.merge_requests : null;
    if (stored) {
      for (const mr of stored) {
        if (!byUrl.has(mr.url)) {
          byUrl.set(mr.url, { url: mr.url, repositoryUrl: mr.repository_url });
        }
      }
    }
    for (const url of liveMrUrls) {
      if (!byUrl.has(url)) byUrl.set(url, { url, repositoryUrl: '' });
    }
    return [...byUrl.values()];
  }, [state, liveMrUrls]);


  // Готов ли отчёт: эндпоинт отдаёт отчёт последней
  // completed-итерации, а снапшот создаётся в момент её завершения. Значит
  // готовность = есть хоть одна завершённая итерация (не важно, что лежит
  // в отчёте resolve-шага).
  const resultReady =
    state.status === 'ready' &&
    state.iterations.some((iteration) => iteration.status === 'completed');
  // Подготовка завершена: либо пришёл терминальный `ready`, либо задача уже
  // вышла из фазы подготовки (после перезагрузки SSE-события не реплеятся).
  const workspaceReady =
    workspaceProgress !== null
      ? workspaceProgress.steps.some(
          (step) => step.step === 'ready' && step.status === 'done',
        )
      : state.status === 'ready' &&
        state.issue.status !== 'pending' &&
        state.issue.status !== 'preparing';
  // Сводка по репозиториям для шапки: статус — из накопленного прогресса.
  const repoRows =
    state.status === 'ready'
      ? state.issue.repositories.map((repository) => ({
          repository,
          fullName: repoFullNameFromUrl(repository.repository_url),
          status: repoPrepStatus(
            extractRepoNameFromUrl(repository.repository_url),
            repository.bootstrap_enabled,
            workspaceProgress?.steps ?? [],
            workspaceReady,
          ),
          devPort:
            repoDevPort(
              extractRepoNameFromUrl(repository.repository_url),
              workspaceProgress?.steps ?? [],
            ) ?? devServerPortOf(state.issue) ?? undefined,
        }))
      : [];

  // HEAD-проб артефакта при открытии модалки. 404 → «отчёта ещё нет»,
  // не-html → «только markdown», `iteration-snapshot` → бейдж «предыдущая
  // версия». Ошибку сети молча гасим: показываем iframe, как раньше.
  useEffect(() => {
    if (!resultOpen || !issueId) {
      setArtifactMeta(null);
      return;
    }
    let cancelled = false;
    fetch(`${API_BASE}/issues/${issueId}/result`, { method: 'HEAD' })
      .then((response) => {
        if (cancelled) return;
        setArtifactMeta({
          status: response.status,
          contentType: response.headers.get('content-type') ?? '',
          source: response.headers.get('x-artifact-source'),
          mtime: response.headers.get('x-artifact-mtime'),
        });
      })
      .catch(() => {
        if (!cancelled) setArtifactMeta(null);
      });
    return () => {
      cancelled = true;
    };
  }, [resultOpen, issueId]);

  // Список порождённых файлов. Best-effort: сеть/не-2xx → пустой список,
  // чтобы шапка не падала. Перезагружается с refreshTick (терминал итерации,
  // новая итерация) и когда отчёт становится готов.
  useEffect(() => {
    if (!issueId || !resultReady) {
      setResultFiles([]);
      return;
    }
    let cancelled = false;
    getResultFiles(issueId)
      .then((list) => {
        if (!cancelled) setResultFiles(list);
      })
      .catch(() => {
        if (!cancelled) setResultFiles([]);
      });
    return () => {
      cancelled = true;
    };
  }, [issueId, resultReady, refreshTick]);

  // Статус отчёта (`report.md`): разово при заходе и опрос, пока идёт
  // генерация. Report-агент пишет файл fire-and-forget — явного SSE-финала
  // нет, поэтому готовность определяем по mtime файла (GET /report/status).
  useEffect(() => {
    if (!issueId) return;
    let cancelled = false;

    const apply = (next: Awaited<ReturnType<typeof getReportStatus>>) => {
      if (cancelled) return;
      setReportMeta({
        observedModel: next.observedModel,
        warnings: next.warnings ?? [],
      });
      if (next.status !== 'success') {
        if (!reportRunning) setReportReady(false);
        return;
      }
      // Пока идёт новый прогон, старый report.md (mtime до старта) не считаем.
      const fresh =
        !reportRunning ||
        (next.lastRunAt !== undefined &&
          new Date(next.lastRunAt).getTime() >=
            reportStartRef.current - 5000);
      if (!fresh) return;
      setReportReady(true);
      reportRunningRef.current = false;
      setReportRunning(false);
    };

    if (!reportRunning) {
      getReportStatus(issueId)
        .then(apply)
        .catch(() => {
          if (!cancelled) setReportReady(false);
        });
      return () => {
        cancelled = true;
      };
    }

    let attempts = 0;
    const poll = () => {
      getReportStatus(issueId)
        .then(apply)
        .catch(() => {});
    };
    poll();
    const timer = setInterval(() => {
      // ~5 мин — сдаёмся, чтобы не крутить опрос вечно (например, на cancelled).
      if (++attempts > 100) {
        clearInterval(timer);
        setReportRunning(false);
        return;
      }
      poll();
    }, 3000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [issueId, reportRunning]);
  // Room-режим итерации: последний refine рекомендовал комнату. Для активного
  // resolve карточка шага показывает вкладки агентов вместо одной сессии.
  const roomIteration =
    stepRuns.status === 'ready' && isRoomIteration(stepRuns.stepRuns);
  const hint = !context.trim()
    ? 'Укажи контекст для новой итерации.'
    : selectedSteps.includes('review')
      ? 'После Resolver автоматически запустится Код-ревью.'
      : 'Итерация завершится сразу после работы Resolver.';

  // Один живой тик на все карточки шагов: активные показывают elapsed.
  const anyActiveStep =
    stepRuns.status === 'ready' &&
    stepRuns.stepRuns.some((run) => isActiveStatus(statusOf(run)));
  const now = useNow(anyActiveStep);

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

    // В тело идут только thinking-уровни выбранных шагов.
    const activeStepThinkingLevels = Object.fromEntries(
      Object.entries(stepThinkingLevels).filter(
        ([step]) =>
          chosenSteps.has(step as PipelineStep) &&
          (step !== 'pr' || prAvailable),
      ),
    ) as StepThinkingLevels;

    const request: CreateIterationRequest = {
      context,
      is_review_need: selectedSteps.includes('review'),
      review_context: '',
      steps: effectiveSteps.length > 0 ? effectiveSteps : undefined,
      step_models:
        Object.keys(activeStepModels).length > 0 ? activeStepModels : undefined,
      step_thinking_levels:
        Object.keys(activeStepThinkingLevels).length > 0
          ? activeStepThinkingLevels
          : undefined,
      // ID репозиториев для MR. Массив авторитетен: выбран шаг pr → шлём
      // текущий выбор (возможно пустой — снимает все галочки), не выбран →
      // пустой массив (сбрасываем create_mr, чтобы `pr` не возвращался).
      pr_repository_ids: selectedSteps.includes('pr') ? [...prRepoIds] : [],
      worker_count: workerCount > 0 ? workerCount : undefined,
    };

    setFormError(null);
    setSubmitting(true);

    try {
      if (hasDraftIteration) {
        // Редактируем существующий черновик — обновляем только context.
        const draft = state.status === 'ready'
          ? state.iterations.find((it) => it.status === 'draft')
          : undefined;
        if (!draft) throw new Error('Черновик не найден');
        await updateIteration(draft.id, { context });
      } else if (files.length > 0) {
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
      setWorkerCount(1);
      setScrollToIterations(true);
      setRefreshTick((tick) => tick + 1);
      // Успешное создание итерации/сохранение черновика закрывает модалку.
      setShowIterationModal(false);
    } catch (error) {
      setFormError(error instanceof Error ? error.message : String(error));
    } finally {
      setSubmitting(false);
    }
  }

  async function handleStopDevServers() {
    if (state.status !== 'ready') return;
    const id = state.issue.id;
    setStoppingDevServers(true);
    setDevServerError(null);
    try {
      await stopDevServers(id);
      // Backend гасит процессы и обнуляет порт — отражаем это локально, не
      // дожидаясь следующего GET.
      setState((current) =>
        current.status === 'ready'
          ? {
              ...current,
              issue: { ...current.issue, dev_server_port: null },
            }
          : current,
      );
    } catch (error) {
      setDevServerError(
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      setStoppingDevServers(false);
    }
  }

  async function copyDevServerPort(port: number) {
    try {
      await navigator.clipboard?.writeText(String(port));
      setDevPortCopied(true);
      if (devPortCopiedTimerRef.current) {
        clearTimeout(devPortCopiedTimerRef.current);
      }
      devPortCopiedTimerRef.current = setTimeout(
        () => setDevPortCopied(false),
        1500,
      );
    } catch {
      // Clipboard может быть недоступен (нет прав/не secure context) —
      // порт всё равно виден в индикаторе.
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

  async function handleFetchReview(iteration: Iteration) {
    if (!issueId) return;
    if (isIterationActive(iteration.status)) {
      setFetchReviewError(
        'Нельзя получить ревью для активной итерации.',
      );
      return;
    }
    setFetchReviewError(null);
    setFetchingReviewId(iteration.id);

    try {
      const { comments, errors } = await fetchReviewComments(iteration.id);

      if (comments.length === 0) {
        // Комментариев нет — код ревью чист.
        setFetchReviewError(null);
        setFetchReviewMessage(
          'Комментариев ревью нет — код чист ✨',
        );
        // Сообщение исчезнет через 4 секунды.
        setTimeout(() => setFetchReviewMessage(null), 4000);
        return;
      }

      // Формируем текст комментариев как markdown.
      const lines: string[] = [
        `# Review Comments`,
        `> Fetched from MR/PR of iteration #${iteration.number}`,
        '',
      ];
      for (const c of comments) {
        const location = c.file
          ? `${c.file}${c.line !== null ? `:${c.line}` : ''}`
          : 'общий комментарий';
        lines.push(
          `- **${c.author}** [${c.repo} → ${location}]:`,
          `  ${c.body}`,
          '',
        );
      }
      if (errors && errors.length > 0) {
        lines.push(
          '',
          '⚠ Некоторые MR не удалось опросить:',
          ...errors.map((e) => `  - ${e}`),
        );
      }
      const reviewText = lines.join('\n');

      // Создаём файл с комментариями и предзаполняем поле контекста.
      const reviewFile = new File(
        [reviewText],
        `review-iteration-${iteration.number}.md`,
        { type: 'text/markdown' },
      );
      setFiles([reviewFile]);
      setContext(
        `Review comments from iteration #${iteration.number}. ` +
          `See attached file for details.`,
      );
    } catch (error) {
      setFetchReviewError(
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      setFetchingReviewId(null);
    }
  }

  async function handleQueue(iteration: Iteration) {
    if (!issueId) return;
    if (iteration.status !== 'draft') return;
    setQueueingId(iteration.id);
    try {
      await queueIteration(iteration.id);
      const iterations = await getIterations(issueId);
      setState((current) =>
        current.status === 'ready'
          ? {
              ...current,
              iterations: [...iterations].sort((a, b) => a.number - b.number),
            }
          : current,
      );
      setRefreshTick((tick) => tick + 1);
    } catch (error) {
      setRepeatError(
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      setQueueingId(null);
    }
  }

  async function handleRepeat(iteration: Iteration) {
    if (!issueId) return;
    if (isIterationActive(iteration.status)) {
      setRepeatError(
        'Нельзя повторить активную итерацию — дождитесь её завершения или отмены.',
      );
      return;
    }
    setRepeatError(null);
    setRepeatingId(iteration.id);

    try {
      const created = await repeatIteration(iteration.id);
      const iterations = await getIterations(issueId);
      setState((current) =>
        current.status === 'ready'
          ? {
              ...current,
              iterations: [...iterations].sort((a, b) => a.number - b.number),
            }
          : current,
      );
      setSelectedIterationId(created.id);
      setRefreshTick((tick) => tick + 1);
    } catch (error) {
      setRepeatError(error instanceof Error ? error.message : String(error));
    } finally {
      setRepeatingId(null);
    }
  }

  async function handleStartDraft() {
    if (!issueId) return;
    setStartDraftError(null);
    setStartingDraft(true);

    try {
      const result = await startIssue(issueId);
      const iterations = await getIterations(issueId);
      setState((current) =>
        current.status === 'ready'
          ? {
              ...current,
              issue: { ...current.issue, status: 'pending' },
              iterations: [...iterations].sort((a, b) => a.number - b.number),
            }
          : current,
      );
      setSelectedIterationId(result.iterationId);
      setRefreshTick((tick) => tick + 1);
    } catch (error) {
      setStartDraftError(
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      setStartingDraft(false);
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
    if (!modalSessionId) return;
    setControlError(null);
    setControlBusy(true);

    try {
      const result = await sendIterationCommand(modalSessionId, command);
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
  }

  /** Кнопка «🔄 Обновить»: принудительный ре-ран report-агента. */
  async function handleRefreshReport() {
    if (state.status !== 'ready' || reportRunningRef.current) return;
    setReportError(null);
    reportStartRef.current = Date.now();
    reportRunningRef.current = true;
    setReportRunning(true);
    try {
      const modelParam = reportModel || undefined;
      const thinkingParam = reportThinkingLevel || undefined;
      await runReportAgent(state.issue.id, modelParam, thinkingParam);
    } catch (error) {
      reportRunningRef.current = false;
      setReportRunning(false);
      setReportError(
        error instanceof Error
          ? error.message
          : 'Не удалось запустить генерацию отчёта',
      );
    }
  }

  async function openJiraPreview() {
    setJiraPreviewOpen(true);
    setJiraPreviewText(null);
    if (state.status !== 'ready' || !state.issue.jira_issue_url) return;
    setJiraPreviewLoading(true);
    try {
      const response = await fetch(
        `/issue-resolver/api/v1/issues/${state.issue.id}/jira-preview`,
      );
      if (!response.ok) throw new Error('not found');
      setJiraPreviewText(await response.text());
    } catch {
      setJiraPreviewText(null);
    } finally {
      setJiraPreviewLoading(false);
    }
  }

  if (!issueId) {
    return (
      <div className="mx-auto max-w-4xl py-6 px-3 sm:px-4 md:px-6">
        <header className="mb-6">
          <h2 className="glow text-xl font-semibold text-[#00FF41]">Задача</h2>
        </header>
        <div className="rounded-none border border-dashed border-[#008F11] p-8 text-center text-sm text-[#00FF41]/60">
          Выберите задачу из списка.
        </div>
      </div>
    );
  }

  if (deleting) {
    return (
      <div className="mx-auto max-w-4xl py-6 px-3 sm:px-4 md:px-6">
        <div
          data-testid="task-deleting"
          className="flex items-center justify-center gap-2 rounded-none border border-dashed border-[#008F11] p-8 text-center text-sm italic text-[#00FF41]/60"
        >
          <span
            aria-hidden="true"
            className="inline-block h-3 w-3 shrink-0 animate-spin rounded-full border-2 border-[#00FF41]/30 border-t-[#00FF41]"
          />
          Задача удаляется...
        </div>
      </div>
    );
  }

  return (
    <div
      ref={panelRef}
      className="mx-auto max-w-4xl py-6 px-3 sm:px-4 md:px-6"
    >
      <div className="space-y-4">
      <div
        data-testid="task-island"
        className="rounded-none border border-[#008F11] p-4"
      >
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
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

      {deleteTimeoutError && (
        <p
          role="alert"
          data-testid="delete-timeout"
          className="mb-4 text-sm font-medium text-[#FFB000]"
        >
          {deleteTimeoutError}
        </p>
      )}

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
          <header>
            <div className="flex flex-wrap items-center gap-3">
              <h2 className="glow min-w-0 break-words text-xl font-semibold text-[#00FF41]">
                {state.issue.title}
              </h2>
              <span
                data-testid="issue-status"
                data-status={state.issue.status}
                className="shrink-0 text-xs uppercase tracking-wider transition-base"
                style={{ color: statusColor[state.issue.status] }}
              >
                {state.issue.status}
              </span>
              {state.issue.workspace_missing === true && (
                <span
                  data-testid="workspace-missing"
                  title="Рабочая папка задачи была удалена"
                  className="shrink-0 border border-[#FFB000] px-2 py-0.5 text-xs font-medium text-[#FFB000]"
                >
                  Файлы задачи отсутствуют
                </span>
              )}
            </div>
            {repoRows.length > 0 && (
              <div
                data-testid="repo-status"
                className="mt-3 border border-[#008F11] bg-[#002B00]/30 px-3 py-2"
              >
                <h4 className="mb-1 text-xs uppercase tracking-wider text-[#00FF41]/60">
                  Репозитории
                </h4>
                <ul className="space-y-1">
                  {repoRows.map(({ repository, fullName, status, devPort }) => (
                    <li
                      key={repository.id}
                      data-testid="repo-status-row"
                      data-repo={fullName}
                      data-status={status}
                      className="flex flex-wrap items-center gap-2 text-xs"
                    >
                      <span
                        data-testid="repo-status-dot"
                        data-status={status}
                        role="img"
                        aria-label={REPO_PREP_LABELS[status]}
                        title={REPO_PREP_LABELS[status]}
                        className="transition-base"
                        style={{ color: REPO_PREP_COLORS[status] }}
                      >
                        {REPO_PREP_MARKS[status]}
                      </span>
                      <span className="text-[#00FF41]">{fullName}</span>
                      <span className="text-[#00FF41]/50">
                        {repository.branch_name}
                      </span>
                      <span className="text-[#00FF41]/50">
                        {REPO_PREP_LABELS[status]}
                      </span>
                      {status === 'ready' && devPort !== undefined && (
                        <span className="inline-flex items-center gap-1.5">
                          <button
                            type="button"
                            data-testid="repo-dev-port"
                            title={`Скопировать порт ${devPort}`}
                            aria-label={`Скопировать порт dev-сервера ${devPort}`}
                            onClick={() => void copyDevServerPort(devPort)}
                            className="text-[#00B4FF] hover:text-[#00FF41] transition-base"
                          >
                            Dev: localhost:{devPort}
                          </button>
                          <button
                            type="button"
                            data-testid="repo-stop-dev"
                            disabled={stoppingDevServers}
                            onClick={() => void handleStopDevServers()}
                            title="Остановить dev-серверы"
                            aria-label="Остановить dev-серверы"
                            className="text-[#FF0033] hover:text-[#FF5555] disabled:opacity-40 transition-base"
                          >
                            <StopIcon className="h-3 w-3" />
                          </button>
                        </span>
                      )}
                      {repository.create_mr && (() => {
                        const mrMatch = mrItems.find(
                          (item) =>
                            item.repositoryUrl ===
                            repository.repository_url,
                        );
                        if (mrMatch) {
                          return (
                            <a
                              data-testid="repo-mr-link"
                              href={mrMatch.url}
                              target="_blank"
                              rel="noreferrer noopener"
                              title={mrMatch.url}
                              className="border border-[#00B4FF] px-1 py-0.5 text-[10px] text-[#00B4FF] no-underline hover:bg-[#00B4FF] hover:text-[#0D0208] transition-base"
                            >
                              MR
                            </a>
                          );
                        }
                        return (
                          <span
                            data-testid="repo-mr-badge"
                            className="border border-[#555] px-1 py-0.5 text-[10px] text-[#555]"
                          >
                            MR
                          </span>
                        );
                      })()}
                      {repository.bootstrap_enabled === false && (
                        <span className="text-[#FFB000]">
                          (запуск отключён)
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {state.issue.jira_issue_url && (
              <div className="mt-3">
                <button
                  type="button"
                  data-testid="open-jira-preview"
                  onClick={() => void openJiraPreview()}
                  className="min-h-9 rounded-none border border-[#00B4FF] bg-[#001018] px-3 py-1 text-xs font-medium text-[#00B4FF] hover:bg-[#00B4FF] hover:text-[#0D0208] transition-base"
                >
                  Jira
                </button>
              </div>
            )}
            {devPortCopied && (
              <p className="mt-2 text-xs text-[#00FF41]/60">Скопировано</p>
            )}
            {devServerError && (
              <p
                role="alert"
                className="mt-2 text-xs font-medium text-[#FF0033]"
              >
                Не удалось остановить dev-серверы: {devServerError}
              </p>
            )}

            {resultAvailable && (
              <section
                data-testid="report-section"
                className="mt-3 border border-[#008F11] bg-[#002B00]/40 px-3 py-2"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <h4 className="text-xs uppercase tracking-wider text-[#00FF41]/60">
                    📄 Отчёт и артефакты
                  </h4>
                  <span className="ml-auto text-xs">
                    {reportRunning ? (
                      <span
                        data-testid="report-generating"
                        className="text-[#FFB000]"
                      >
                        ⏳ Генерируется…
                      </span>
                    ) : reportReady ? (
                      <span
                        data-testid="report-ready"
                        className="text-[#00FF41]/80"
                      >
                        ✓ Сгенерирован
                      </span>
                    ) : (
                      <span
                        data-testid="report-idle"
                        className="text-[#00FF41]/50"
                      >
                        Отчёт ещё не сгенерирован
                      </span>
                    )}
                  </span>
                </div>

                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    data-testid="open-result"
                    disabled={!resultReady}
                    onClick={() => void openResult()}
                    className="min-h-9 rounded-none border border-[#00FF41] bg-[#003B00] px-3 py-1 text-xs font-medium text-[#00FF41] hover:bg-[#00FF41] hover:text-[#0D0208] disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-[#003B00] disabled:hover:text-[#00FF41] transition-base"
                  >
                    Показать отчёт
                  </button>
                  <button
                    type="button"
                    data-testid="open-artifacts"
                    onClick={() => setArtifactsOpen(true)}
                    disabled={!resultReady || resultFiles.length === 0}
                    className="min-h-9 rounded-none border border-[#008F11] px-3 py-1 text-xs font-medium text-[#00FF41]/80 hover:border-[#00FF41] hover:text-[#00FF41] disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-[#008F11] disabled:hover:text-[#00FF41]/80 transition-base"
                  >
                    Артефакты ({resultFiles.length})
                  </button>
                  {reportReady && (
                    <a
                      data-testid="report-md"
                      href={`/issue-resolver/api/v1/issues/${state.issue.id}/result/md/download`}
                      download={RESULT_MD_FILENAME}
                      className="inline-flex min-h-9 items-center rounded-none border border-[#008F11] px-3 py-1 text-xs font-medium text-[#00FF41]/80 transition-base hover:border-[#00FF41] hover:text-[#00FF41]"
                    >
                      📥 MD
                    </a>
                  )}
                  <button
                    type="button"
                    data-testid="refresh-report"
                    disabled={reportRunning}
                    onClick={() => void handleRefreshReport()}
                    className="min-h-9 rounded-none border border-[#008F11] px-3 py-1 text-xs font-medium text-[#00FF41]/80 hover:border-[#00FF41] hover:text-[#00FF41] disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-[#008F11] disabled:hover:text-[#00FF41]/80 transition-base"
                  >
                    🔄 Обновить
                  </button>
                  {reportEvents.length > 0 && (
                    <button
                      type="button"
                      data-testid="report-expand"
                      onClick={() => {
                        setExpandedStepRunId(null);
                        setReportExpanded(true);
                      }}
                      className="ml-auto shrink-0 border border-[#008F11] px-2 py-0.5 text-[10px] uppercase tracking-wider text-[#00FF41]/80 hover:border-[#00FF41] hover:text-[#00FF41] transition-base"
                    >
                      ⤢ Вывод
                    </button>
                  )}
                </div>

                {models.length > 0 && (
                  <details className="mt-2">
                    <summary className="w-fit cursor-pointer text-[11px] text-[#00FF41]/50 hover:text-[#00FF41]/80">
                      ⚙ Выбрать модель
                    </summary>
                    <div className="mt-1">
                      <ModelThinkingSelect
                        models={models}
                        thinkingLevels={thinkingLevelsFor(models.find((m) => `${m.provider}/${m.id}` === reportModel))}
                        modelValue={reportModel}
                        thinkingValue={reportThinkingLevel}
                        disabled={reportRunning}
                        thinkingDisabled={!reportModel}
                        modelOptionValue={(m) => `${m.provider}/${m.id}`}
                        modelOptionLabel={(m) => m.id}
                        modelPlaceholder="модель по умолчанию"
                        thinkingPlaceholder="thinking по умолчанию"
                        modelTestId="report-model-select"
                        thinkingTestId="report-thinking-select"
                        modelSelectClassName="min-h-9 rounded-none border border-[#008F11] bg-[#0D0208] px-2 py-1 text-xs text-[#00FF41]/80"
                        thinkingSelectClassName="min-h-9 rounded-none border border-[#008F11] bg-[#0D0208] px-2 py-1 text-xs text-[#00FF41]/80"
                        onModelChange={setReportModel}
                        onThinkingChange={setReportThinkingLevel}
                      />
                    </div>
                  </details>
                )}

                {(reportMeta.warnings.length > 0 ||
                  Boolean(reportMeta.observedModel)) && (
                  <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1">
                    {reportMeta.warnings.length > 0 && (
                      <span
                        role="alert"
                        data-testid="report-warnings"
                        className="text-xs font-medium text-[#FF0033]"
                      >
                        ⚠ {reportMeta.warnings.join(' · ')}
                      </span>
                    )}
                    {reportMeta.observedModel && (
                      <span
                        data-testid="report-observed-model"
                        className="text-[11px] text-[#00FF41]/50"
                      >
                        Модель прогона: {reportMeta.observedModel}
                      </span>
                    )}
                  </div>
                )}
                {reportError && (
                  <p
                    role="alert"
                    data-testid="report-error"
                    className="mt-2 text-xs font-medium text-[#FF0033]"
                  >
                    {reportError}
                  </p>
                )}

                {reportRunning && reportEvents.length > 0 && (
                  <AutoScrollBox
                    scrollKey={reportEvents.length}
                    className="mt-2 h-[300px] overflow-auto border border-[#008F11] bg-[#000200] p-2"
                  >
                    <div data-testid="report-session">
                      <SessionView
                        events={reportEvents}
                        running
                        showFooter={false}
                      />
                    </div>
                  </AutoScrollBox>
                )}
                {reportEvents.length > 0 && (
                  <SessionStatsBar
                    events={reportEvents}
                    className="mt-2 border-t border-[#008F11]/40 pt-2 text-[10px]"
                  />
                )}
              </section>
            )}
            <IssueFilesList
              files={issueFiles.filter((file) => file.iteration_id === null)}
              onDelete={handleDeleteFile}
              deletingId={deletingFileId}
            />
          </header>

          {/* Inline questions: visible directly on the task page, no modal */}
          {unansweredQuestions.length > 0 && (
            <div className="mt-3 space-y-3">
              {unansweredQuestions.map((question) => (
                <InlineQuestion
                  key={question.id}
                  question={question}
                  submitting={questionSubmitting}
                  error={questionError}
                  onSubmit={(payload) =>
                    void handleQuestionResponse(question, payload)
                  }
                  onCancel={() =>
                    void handleQuestionResponse(question, { cancelled: true })
                  }
                />
              ))}
            </div>
          )}

          <div>
          </div>
        </>
      )}
      </div>

          {state.status === 'ready' && state.issue.status === 'draft' && (
            <section className="rounded-none border border-[#008F11] p-4">
              <h3 className="glow mb-1 text-lg font-semibold text-[#00FF41]">
                Черновик
              </h3>
              <p className="mb-4 text-sm text-[#00FF41]/60">
                Задача сохранена как черновик. Запустите её, чтобы начать
                скачивание репозиториев и выполнение пайплайна.
              </p>
              {startDraftError && (
                <p role="alert" className="mb-3 text-sm font-medium text-[#FF0033]">
                  {startDraftError}
                </p>
              )}
              <div className="flex flex-wrap gap-3">
                <button
                  type="button"
                  disabled={startingDraft}
                  onClick={() => void handleStartDraft()}
                  className="min-h-12 rounded-none border border-[#00FF41] bg-[#003B00] px-5 py-2 text-sm font-medium text-[#00FF41] shadow-[0_0_10px_rgba(0,255,65,0.35)] hover:bg-[#00FF41] hover:text-[#0D0208] disabled:opacity-50"
                >
                  {startingDraft ? 'Запускаем…' : 'Запустить'}
                </button>
                <button
                  type="button"
                  disabled={startingDraft}
                  data-testid="open-iteration-modal"
                  onClick={() => setShowIterationModal(true)}
                  className="min-h-12 rounded-none border border-[#00B4FF] px-5 py-2 text-sm font-medium text-[#00B4FF] hover:bg-[#00B4FF] hover:text-[#0D0208] disabled:opacity-50"
                >
                  Редактировать
                </button>
              </div>
            </section>
          )}

          {/* Кнопка новой итерации / черновика: только для НЕ-draft задач.
              У черновика своя кнопка «Редактировать» в блоке выше. */}
          {canStart && state.status === 'ready' && state.issue.status !== 'draft' && (
            <button
              type="button"
              data-testid="open-iteration-modal"
              onClick={() => {
                // Если есть черновик — подгружаем его контекст в редактор.
                if (hasDraftIteration && state.status === 'ready') {
                  const draft = state.iterations.find((it) => it.status === 'draft');
                  if (draft) setContext(draft.context ?? '');
                }
                setShowIterationModal(true);
              }}
              className="min-h-12 w-full rounded-none border border-[#00FF41] bg-[#003B00] px-5 py-2 text-sm font-medium text-[#00FF41] shadow-[0_0_10px_rgba(0,255,65,0.35)] hover:bg-[#00FF41] hover:text-[#0D0208] md:w-auto"
            >
              {hasDraftIteration ? 'Редактировать черновик' : 'Новая итерация'}
            </button>
          )}

          {/* Модалка итерации — общая для черновика и обычных задач. */}
          {showIterationModal && (
            <div
              data-testid="iteration-modal-backdrop"
              className="fixed inset-0 z-50 flex items-start justify-center bg-[#0D0208]/90 backdrop-blur-sm overflow-y-auto p-4"
              onClick={(e) => { if (e.target === e.currentTarget) setShowIterationModal(false); }}
              onKeyDown={(e) => { if (e.key === 'Escape') setShowIterationModal(false); }}
            >
              <div className="w-full max-w-3xl mx-4 my-auto">
          <section
            data-testid="new-iteration-island"
            className="rounded-none border border-[#008F11] bg-[#0D0208] p-4 shadow-[0_0_30px_rgba(0,255,65,0.2)]"
          >
            <div className="flex items-center justify-between mb-1">
              <h3 className="glow text-lg font-semibold text-[#00FF41]">
                {hasDraftIteration ? 'Редактировать черновик' : 'Новая итерация'}
              </h3>
              <button
                type="button"
                onClick={() => setShowIterationModal(false)}
                className="text-[#00FF41]/60 hover:text-[#00FF41] text-lg leading-none px-2"
                aria-label="Закрыть"
              >
                ✕
              </button>
            </div>
            <p className="mb-4 text-sm text-[#00FF41]/60">
              {hasDraftIteration
                ? 'Отредактируй контекст черновика и сохрани изменения.'
                : 'Добавь новый контекст и запусти ещё одну попытку решения задачи.'}
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

              <PipelineStepsSection
                selectedSteps={selectedSteps}
                stepModels={stepModels}
                stepThinkingLevels={stepThinkingLevels}
                models={models}
                modelsLoading={modelsLoading}
                workerCount={workerCount}
                onWorkerCountChange={setWorkerCount}
                mrRepoOptions={
                  state.status === 'ready'
                    ? state.issue.repositories.map((repository) => ({
                        id: repository.id,
                        label: repoShortName(repository.repository_url),
                      }))
                    : []
                }
                prRepoIds={prRepoIds}
                prDisabled={!prAvailable}
                disabled={!canStart}
                stepOptions={STEP_OPTIONS}
                onToggleStep={toggleStep}
                onStepModelChange={updateStepModel}
                onStepThinkingChange={updateStepThinkingLevel}
                onTogglePrRepo={togglePrRepo}
              />

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
                  className="min-h-12 w-full rounded-none border border-[#00FF41] bg-[#003B00] px-5 py-2 text-sm font-medium text-[#00FF41] shadow-[0_0_10px_rgba(0,255,65,0.35)] hover:bg-[#00FF41] hover:text-[#0D0208] disabled:opacity-50 md:w-auto transition-base"
                >
                  {submitting
                    ? 'Создание итерации…'
                    : submitButtonLabel}
                </button>
              </div>
            </form>
          </section>
              </div>
            </div>
          )}

          {state.status === 'ready' &&
            workspaceProgress &&
            !workspaceProgress.dismissed && (
            <div
              data-testid="workspace-progress"
              data-fading={workspaceProgress.fading ? 'true' : 'false'}
              onAnimationEnd={() => dismissProgress()}
              className={`mb-4 border border-[#008F11] bg-[#002B00]/40 px-3 py-2${
                workspaceProgress.fading ? ' workspace-progress--fade' : ''
              }`}
            >
              <h4 className="mb-2 text-xs uppercase tracking-wider text-[#00FF41]/60">
                Подготовка проектов
              </h4>
              <ul className="space-y-1">
                {workspaceProgress.steps.map((step) => (
                  <li
                    key={step.key}
                    data-testid="workspace-step"
                    data-step={step.step}
                    data-status={step.status}
                    className="flex flex-wrap items-center gap-2 text-xs animate-fade-in-up"
                    style={{ color: WORKSPACE_STEP_COLORS[step.status] }}
                  >
                    <span aria-hidden="true">
                      {workspaceStepMark(step.status)}
                    </span>
                    <span>{workspaceStepLabel(step.step, step.repo)}</span>
                    {step.message && (
                      <span
                        style={{
                          color:
                            step.status === 'warning'
                              ? '#FFB000'
                              : '#FF0033',
                        }}
                      >
                        {step.message}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
              {devopsEvents.length > 0 && (
                <AutoScrollBox
                  scrollKey={devopsEvents.length}
                  className="mt-2 h-[300px] overflow-auto border border-[#008F11] bg-[#000200] p-2"
                >
                  <div data-testid="devops-session">
                    <SessionView
                      events={devopsEvents}
                      running
                      showFooter={false}
                    />
                  </div>
                </AutoScrollBox>
              )}
            </div>
          )}

          {state.status === 'ready' && (
          <div ref={iterationsRef} className="space-y-3">
            {repeatError && (
              <p
                role="alert"
                className="mb-3 text-xs font-medium text-[#FF0033]"
              >
                {repeatError}
              </p>
            )}
            {fetchReviewError && (
              <p
                role="alert"
                data-testid="fetch-review-error"
                className="mb-3 text-xs font-medium text-[#FF0033]"
              >
                {fetchReviewError}
              </p>
            )}
            {fetchReviewMessage && (
              <p
                role="status"
                data-testid="fetch-review-message"
                className="mb-3 text-xs font-medium text-[#00FF41]"
              >
                {fetchReviewMessage}
              </p>
            )}

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
                    className={`cursor-pointer rounded-none border border-[#008F11] p-4 text-sm transition-base${isSelected ? ' ring-1 ring-[#00FF41] bg-[#003B00]/40' : ''}`}
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
                          className="min-h-8 shrink-0 border border-[#FF0033] bg-[#2A0008] px-3 py-1 text-xs font-medium text-[#FF0033] hover:bg-[#FF0033] hover:text-[#0D0208] disabled:opacity-50 transition-base"
                        >
                          {aborting ? 'Прерываем…' : 'Прервать'}
                        </button>
                      )}
                      <button
                        type="button"
                        data-testid="repeat-iteration"
                        disabled={
                          repeatingId === iteration.id ||
                          isIterationActive(iteration.status)
                        }
                        onClick={(event) => {
                          event.stopPropagation();
                          void handleRepeat(iteration);
                        }}
                        className="min-h-8 shrink-0 border border-[#008F11] bg-[#002B00] px-3 py-1 text-xs font-medium text-[#00FF41] hover:bg-[#00FF41] hover:text-[#0D0208] disabled:opacity-50 transition-base"
                      >
                        {repeatingId === iteration.id
                          ? 'Повторяем…'
                          : '↻ Повторить'}
                      </button>
                      {iteration.steps.includes('pr') &&
                        iteration.status !== 'running' &&
                        iteration.status !== 'pending' &&
                        iteration.status !== 'preparing' && (
                          <button
                            type="button"
                            data-testid="fetch-review"
                            disabled={
                              fetchingReviewId === iteration.id ||
                              isIterationActive(iteration.status)
                            }
                            onClick={(event) => {
                              event.stopPropagation();
                              void handleFetchReview(iteration);
                            }}
                            className="min-h-8 shrink-0 border border-[#00B4FF] bg-[#001018] px-3 py-1 text-xs font-medium text-[#00B4FF] hover:bg-[#00B4FF] hover:text-[#0D0208] disabled:opacity-50 transition-base"
                          >
                            {fetchingReviewId === iteration.id
                              ? 'Загружаем…'
                              : '📋 Результаты ревью'}
                          </button>
                        )}
                      {iteration.status === 'draft' && (
                        <button
                          type="button"
                          data-testid="queue-iteration"
                          disabled={queueingId === iteration.id}
                          onClick={(event) => {
                            event.stopPropagation();
                            void handleQueue(iteration);
                          }}
                          className="min-h-8 shrink-0 border border-[#00FF41] bg-[#002B00] px-3 py-1 text-xs font-medium text-[#00FF41] hover:bg-[#00FF41] hover:text-[#0D0208] disabled:opacity-50 transition-base"
                        >
                          {queueingId === iteration.id
                            ? 'В очереди…'
                            : '▶ В очередь'}
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

                    <IssueFilesList
                      files={issueFiles.filter(
                        (file) => file.iteration_id === iteration.id,
                      )}
                      onDelete={handleDeleteFile}
                      deletingId={deletingFileId}
                    />

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
                                    ? ' animate-pulse-subtle border-[#00FF41] text-[#00FF41]'
                                    : ' border-[#008F11]'
                                }`}
                                style={
                                  isActive
                                    ? undefined
                                    : { color: stepStatusColor[status] }
                                }
                              >
                                <span className="transition-base">{step}</span>
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
                        {iterationErrors[iteration.id] && (
                          <p
                            role="alert"
                            data-testid="iteration-error"
                            className="mb-3 border border-[#FF0033] bg-[#2A0008] px-3 py-2 text-xs font-medium text-[#FF0033]"
                          >
                            ❌ Ошибка подготовки:{' '}
                            {iterationErrors[iteration.id]}
                          </p>
                        )}
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
                                // room/stages-resolve шлёт stats-события каждого
                                // агента на общий шаг; футер должен показать
                                // агрегат `run.stats` (тотал шага), а не stats
                                // последнего координатора — пустые events
                                // заставляют resolveFooter взять prop.
                                const isRoomResolve =
                                  roomIteration && run.step === 'resolve';
                                const footer = resolveFooter(
                                  isRoomResolve ? [] : events,
                                  run.stats ?? null,
                                );
                                return (
                                  <li
                                    key={run.id}
                                    data-testid="step-run-log"
                                    data-step-run-id={run.id}
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
                                        className="ml-auto shrink-0 border border-[#008F11] px-2 py-0.5 text-[10px] uppercase tracking-wider text-[#00FF41]/80 hover:border-[#00FF41] hover:text-[#00FF41] transition-base"
                                      >
                                        Развернуть
                                      </button>
                                    </div>

                                    {report?.pr_error && (
                                      <p
                                        role="alert"
                                        data-testid="step-pr-error"
                                        className="mt-2 border border-[#FF0033] bg-[#2A0008] px-2 py-1 text-xs font-medium text-[#FF0033]"
                                      >
                                        ⚠ MR/ветка не созданы: {report.pr_error}
                                      </p>
                                    )}

                                    {isActiveStatus(runStatus) ? (
                                      <>

                                        {roomIteration &&
                                        run.step === 'resolve' ? (
                                          <RoomAgentTabs
                                            iterationId={run.iteration_id}
                                            refreshKey={refreshTick}
                                          />
                                        ) : (
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
                                        )}
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
                                      {run.stats?.cost != null && (
                                        <span data-testid="step-cost">
                                          · {formatCost(run.stats.cost)}
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
                                          <span
                                            data-testid="session-token-out"
                                            className="inline-flex items-baseline gap-0.5"
                                          >
                                            <TokenDownIcon />
                                            {formatTokens(footer.output)}
                                          </span>{' '}
                                          <span
                                            data-testid="session-token-cache"
                                            className="inline-flex items-baseline gap-0.5"
                                          >
                                            <CacheIcon />
                                            {formatTokens(footer.cached)}
                                          </span>{' '}
                                          <span className="session-stats-sep">
                                            ·
                                          </span>{' '}
                                          {footer.toolCalls ?? 0} вызовов
                                          {(footer.tokensPerSecond !== null ||
                                            footer.avgTokensPerSecond !==
                                              null) && (
                                            <>
                                              {' '}
                                              <span className="session-stats-sep">
                                                ·
                                              </span>{' '}
                                              <span data-testid="step-speed">
                                                {footer.tokensPerSecond !==
                                                  null &&
                                                  `${formatInstantSpeed(
                                                    footer.tokensPerSecond,
                                                  )} t/s`}
                                                {footer.tokensPerSecond !==
                                                  null &&
                                                  footer.avgTokensPerSecond !==
                                                    null &&
                                                  ' · '}
                                                {footer.avgTokensPerSecond !==
                                                  null &&
                                                  `avg ${formatAvgSpeed(
                                                    footer.avgTokensPerSecond,
                                                  )} t/s`}
                                              </span>
                                            </>
                                          )}
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
          </div>
          )}

      </div>

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
              <span className="text-[#00FF41]">Отчёт</span>
              {artifactMeta?.source === 'iteration-snapshot' && (
                <span
                  data-testid="artifact-source-badge"
                  className="border border-[#008F11] px-2 py-0.5 text-[11px] text-[#00FF41]"
                >
                  Показана предыдущая версия
                  {artifactMeta.mtime ? ` от ${artifactMeta.mtime}` : ''} —
                  новый отчёт ещё не готов.
                </span>
              )}
              <a
                data-testid="result-modal-download"
                href={`/issue-resolver/api/v1/issues/${state.issue.id}/result/download`}
                download={RESULT_HTML_FILENAME}
                aria-disabled={resultReady ? undefined : true}
                tabIndex={resultReady ? undefined : -1}
                onClick={(event) => {
                  if (!resultReady) event.preventDefault();
                }}
                className={`inline-flex items-center rounded-none border border-[#008F11] px-2 py-0.5 text-[11px] font-medium transition-base ${
                  resultReady
                    ? 'text-[#00FF41]/80 hover:border-[#00FF41] hover:text-[#00FF41]'
                    : 'cursor-not-allowed text-[#00FF41]/40 opacity-40'
                }`}
              >
                Скачать HTML
              </a>
              <a
                data-testid="result-modal-download-md"
                href={`/issue-resolver/api/v1/issues/${state.issue.id}/result/md/download`}
                download={RESULT_MD_FILENAME}
                aria-disabled={resultReady ? undefined : true}
                tabIndex={resultReady ? undefined : -1}
                onClick={(event) => {
                  if (!resultReady) event.preventDefault();
                }}
                className={`inline-flex items-center rounded-none border border-[#008F11] px-2 py-0.5 text-[11px] font-medium transition-base ${
                  resultReady
                    ? 'text-[#00FF41]/80 hover:border-[#00FF41] hover:text-[#00FF41]'
                    : 'cursor-not-allowed text-[#00FF41]/40 opacity-40'
                }`}
              >
                Скачать .md
              </a>
              <button
                type="button"
                data-testid="result-modal-close"
                aria-label="Закрыть"
                onClick={() => setResultOpen(false)}
                className="ml-auto shrink-0 border border-[#008F11] px-3 py-1 text-sm text-[#00FF41] hover:border-[#00FF41] hover:bg-[#003B00] transition-base"
              >
                ✕
              </button>
            </header>
            <div className="min-h-0 flex-1 overflow-auto py-4 px-2 sm:px-4">
              {artifactMeta?.status === 404 ? (
                <div
                  data-testid="result-missing"
                  className="border border-[#008F11] p-4 text-sm text-[#00FF41]"
                >
                  Отчёт ещё не сгенерирован. Нажмите «🔄 Обновить», чтобы
                  запустить report-агента.
                </div>
              ) : artifactMeta && !artifactMeta.contentType.includes('text/html') ? (
                <div
                  data-testid="result-not-html"
                  className="border border-[#008F11] p-4 text-sm text-[#00FF41]"
                >
                  HTML-версия отчёта недоступна — доступен только markdown.
                  Скачайте «Скачать .md».
                </div>
              ) : (
                <iframe
                  data-testid="result-html"
                  src={`/issue-resolver/api/v1/issues/${state.issue.id}/result`}
                  title="Отчёт"
                  sandbox="allow-scripts allow-popups"
                  referrerPolicy="no-referrer"
                  className="h-full w-full border border-[#008F11] bg-white"
                />
              )}
            </div>
          </div>
        </div>
      )}

      {jiraPreviewOpen && state.status === 'ready' && (
        <div
          data-testid="jira-preview-modal"
          role="dialog"
          aria-modal="true"
          onClick={() => setJiraPreviewOpen(false)}
          className="fixed inset-0 z-50 flex flex-col bg-[#0D0208]/95 py-4 px-2 sm:px-4"
        >
          <div
            className="flex min-h-0 w-full flex-1 flex-col border border-[#00B4FF] bg-[#0D0208]"
            onClick={(event) => event.stopPropagation()}
          >
            <header className="flex flex-wrap items-center gap-3 border-b border-[#008F11] py-4 px-2 sm:px-4">
              <h3 className="text-lg font-semibold text-[#00B4FF]">
                Jira: {state.issue.jira_issue_url && extractIssueKeyFromUrl(state.issue.jira_issue_url)}
              </h3>
              <button
                type="button"
                className="ml-auto min-h-9 border border-[#008F11] px-3 py-1 text-xs text-[#008F11] hover:bg-[#008F11]/20 hover:text-[#00FF41]"
                onClick={() => setJiraPreviewOpen(false)}
              >
                Закрыть
              </button>
            </header>
            <div className="flex-1 overflow-y-auto px-2 py-4 sm:px-6">
              {jiraPreviewLoading ? (
                <p className="text-sm text-[#00FF41]/60">
                  Загрузка…
                </p>
              ) : jiraPreviewText !== null ? (
                <div data-testid="jira-preview-markdown">
                  <AgentMarkdown>{jiraPreviewText}</AgentMarkdown>
                </div>
              ) : (
                <p className="text-sm text-[#FF0033]">
                  Не удалось загрузить данные Jira
                </p>
              )}
            </div>
          </div>
        </div>
      )}

      {state.status === 'ready' && (
        <ArtifactsModal
          issueId={state.issue.id}
          files={resultFiles}
          open={artifactsOpen}
          onClose={() => setArtifactsOpen(false)}
          archiveUrl={resultFilesArchiveUrl(state.issue.id)}
        />
      )}

      {modalTarget && (
        <div
          data-testid="step-log-modal"
          role="dialog"
          aria-modal="true"
          onClick={closeModal}
          className="fixed inset-0 z-50 flex flex-col bg-[#0D0208]/95 py-4 px-2 sm:px-4"
        >
          <div
            className="flex min-h-0 w-full flex-1 flex-col border border-[#008F11] bg-[#0D0208]"
            onClick={(event) => event.stopPropagation()}
          >
            <header className="flex flex-wrap items-center gap-3 border-b border-[#008F11] py-4 px-2 sm:px-4">
              <span className="text-[#00FF41]">
                {modalTarget.title}
              </span>
              {modalTarget.attempt > 1 && (
                <span className="text-[#00FF41]/60">
                  попытка {modalTarget.attempt}
                </span>
              )}
              <span
                className="text-xs uppercase tracking-wider"
                style={{ color: stepStatusColor[modalTarget.status] }}
              >
                {modalTarget.status}
              </span>
              <button
                type="button"
                data-testid="step-log-modal-close"
                aria-label="Закрыть"
                onClick={closeModal}
                className="ml-auto shrink-0 border border-[#008F11] px-3 py-1 text-sm text-[#00FF41] hover:border-[#00FF41] hover:bg-[#003B00] transition-base"
              >
                ✕
              </button>
            </header>

            <div
              ref={modalScrollRef}
              onScroll={handleModalScroll}
              data-testid="step-log-scroll"
              className="min-h-0 flex-1 space-y-4 overflow-auto py-4 px-2 sm:px-4"
            >

              {modalTarget.events.length > 0 ? (
                <section>
                  <h4 className="mb-1 text-[10px] uppercase tracking-wider text-[#00FF41]/50">
                    session
                  </h4>
                  <div data-testid="modal-session">
                    <SessionView
                      events={modalTarget.events}
                      stats={modalTarget.stats}
                      showFooter={false}
                      hideInfo={true}
                      running={modalTarget.active}
                      startedAt={modalTarget.startedAt}
                      onRecallQueued={recallQueued}
                    />
                  </div>
                </section>
              ) : (
                modalTarget.stdout.trim() !== '' && (
                  <section>
                    <h4 className="mb-1 text-[10px] uppercase tracking-wider text-[#00FF41]/50">
                      stdout
                    </h4>
                    <div
                      data-testid="modal-stdout"
                      className="border border-[#008F11] bg-[#000200] p-2"
                    >
                      <AgentMarkdown>{modalTarget.stdout}</AgentMarkdown>
                    </div>
                  </section>
                )
              )}
              {modalTarget.stderr.trim() !== '' && (
                <section>
                  <h4 className="mb-1 text-[10px] uppercase tracking-wider text-[#00FF41]/50">
                    stderr
                  </h4>
                  <pre
                    data-testid="modal-stderr"
                    className="overflow-x-auto whitespace-pre-wrap break-words border border-[#008F11] bg-[#000200] p-2 font-mono text-xs text-[#FF0033]"
                  >
                    {modalTarget.stderr}
                  </pre>
                </section>
              )}
              {modalTarget.report !== null &&
                modalTarget.report.trim() !== '' && (
                  <section>
                    <h4 className="mb-1 text-[10px] uppercase tracking-wider text-[#00FF41]/50">
                      report
                    </h4>
                    <div
                      data-testid="modal-report"
                      className="border border-[#008F11] bg-[#000200] p-2"
                    >
                      <StepReportView raw={modalTarget.report} />
                    </div>
                  </section>
                )}
            </div>

            {(modalTarget.active || modalTarget.status === 'needs_input') && (
              <div className="border-t border-[#008F11] py-3 px-2 sm:px-4">
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
                        {controlSnapshot?.models?.map((model) => (
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
                        {controlSnapshot?.thinkingLevels?.map((level) => (
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
                      className="min-h-8 border border-[#FFB000] px-2 py-0.5 text-[#FFB000] hover:bg-[#FFB000] hover:text-[#0D0208] disabled:opacity-50 transition-base"
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
                      className="min-h-8 border border-[#008F11] px-2 py-0.5 text-[#00FF41]/80 hover:border-[#00FF41] hover:text-[#00FF41] disabled:opacity-50 transition-base"
                    >
                      очистить очередь
                    </button>
                    <button
                      type="button"
                      data-testid="abort-iteration-modal"
                      disabled={aborting}
                      onClick={() => {
                        if (activeIterationId) {
                          void handleAbort(modalTarget.sessionId);
                        }
                      }}
                      className="min-h-8 border border-[#FF0033] bg-[#2A0008] px-2 py-0.5 text-xs text-[#FF0033] hover:bg-[#FF0033] hover:text-[#0D0208] disabled:opacity-50 transition-base"
                    >
                      {aborting ? 'Прерываем…' : 'Прервать'}
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
                      className="min-h-9 shrink-0 border border-[#00FF41] bg-[#003B00] px-3 py-1 text-xs font-medium text-[#00FF41] disabled:opacity-50 transition-base"
                    >
                      Сжать
                    </button>
                    <button
                      type="button"
                      onClick={() => setCompactOpen(false)}
                      className="min-h-9 shrink-0 border border-[#008F11] px-3 py-1 text-xs text-[#00FF41]/80 hover:border-[#00FF41] transition-base"
                    >
                      Отмена
                    </button>
                  </div>
                )}

                <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                  <form
                    className="flex min-w-0 flex-1 flex-wrap items-center gap-2"
                    onSubmit={(event) => {
                      event.preventDefault();
                      if (activeIterationId) {
                        void handleMessageSubmit(modalTarget.sessionId, message);
                      }
                    }}
                  >
                    <input
                      type="text"
                      aria-label="Сообщение"
                      className={`${inputClass} min-w-0 flex-1 order-1 sm:order-3`}
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
                    {controlSnapshot && (
                      <select
                        data-testid="send-mode"
                        aria-label="Режим отправки"
                        className={`${inputClass} w-auto py-1 order-2 sm:order-1`}
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
                    {(() => {
                      let queueEvent: SessionEvent | undefined;
                      for (let i = modalTarget.events.length - 1; i >= 0; i -= 1) {
                        if (modalTarget.events[i].type === 'queue') {
                          queueEvent = modalTarget.events[i];
                          break;
                        }
                      }
                      if (!queueEvent || queueEvent.type !== 'queue') return null;
                      const steering: string[] = queueEvent.steering ?? [];
                      const followUp: string[] = queueEvent.followUp ?? [];
                      if (steering.length === 0 && followUp.length === 0) return null;
                      return (
                        <span
                          data-testid="queue-recall-inline"
                          className="order-2 sm:order-2 flex flex-wrap gap-1"
                        >
                          {steering.map((text: string, i: number) => (
                            <button
                              key={`steer-${i}`}
                              type="button"
                              data-testid={`queue-recall-steer-${i}`}
                              onClick={() => recallQueued(text)}
                              disabled={messageSending}
                              className="min-h-7 border border-[#FFB000] px-1.5 text-[10px] text-[#FFB000] hover:bg-[#FFB000]/20 disabled:opacity-50 transition-base"
                              title={text}
                            >
                              ↩steer
                            </button>
                          ))}
                          {followUp.map((text: string, i: number) => (
                            <button
                              key={`follow-${i}`}
                              type="button"
                              data-testid={`queue-recall-follow-${i}`}
                              onClick={() => recallQueued(text)}
                              disabled={messageSending}
                              className="min-h-7 border border-[#00B4FF] px-1.5 text-[10px] text-[#00B4FF] hover:bg-[#00B4FF]/20 disabled:opacity-50 transition-base"
                              title={text}
                            >
                              ↩follow
                            </button>
                          ))}
                        </span>
                      );
                    })()}
                    <button
                      type="submit"
                      disabled={!message.trim() || messageSending}
                      className="min-h-9 shrink-0 rounded-none border border-[#00FF41] bg-[#003B00] px-3 py-1 text-xs font-medium text-[#00FF41] disabled:opacity-50 transition-base order-3 sm:order-4"
                    >
                      {messageSending ? 'Отправка…' : 'Отправить'}
                    </button>
                  </form>
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
                        className={`block w-full px-2 py-1 text-left hover:bg-[#003B00]${index === activePaletteIndex ? ' bg-[#003B00]' : ''} transition-base`}
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
              events={modalTarget.events}
              stats={modalTarget.stats}
              className="shrink-0 border-t border-[#008F11] px-2 py-2 sm:px-4"
            />
          </div>
        </div>
      )}

    </div>
  );
}

/** Inline-вопрос агента: отображается прямо на странице задачи, не в модалке.
 * Тип `method` определяет контрол: select → radio, confirm → Да/Нет,
 * input → строка, editor → textarea. */
function InlineQuestion({
  question,
  submitting,
  error,
  onSubmit,
  onCancel,
}: {
  question: QuestionEvent;
  submitting: boolean;
  error: string | null;
  onSubmit: (payload: { value?: string; confirmed?: boolean }) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(
    question.prefill ?? question.options?.[0] ?? '',
  );
  const isConfirm = question.method === 'confirm';
  const submitLabel = question.method === 'editor' ? 'Отправить' : 'Ответить';

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
      data-testid="inline-question"
      className="border border-[#FFB000] bg-[#1A1000] p-3"
    >
      <header className="mb-2 flex items-center justify-between">
        <span className="text-xs font-semibold text-[#FFB000]">
          Агент спрашивает
        </span>
        <button
          type="button"
          data-testid="question-close"
          aria-label="Закрыть"
          disabled={submitting}
          onClick={onCancel}
          className="text-[#FFB000]/50 hover:text-[#FFB000] disabled:opacity-50 transition-base"
        >
          ✕
        </button>
      </header>

      <p className="break-words text-sm text-[#FFB000]">{question.title}</p>
      {question.message && (
        <p className="mt-1 whitespace-pre-wrap break-words text-xs text-[#FFB000]/70">
          {question.message}
        </p>
      )}

      {question.method === 'select' && (
        <fieldset
          className="mt-3 space-y-2"
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
          className={`${inputClass} mt-3`}
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
          className={`${inputClass} mt-3`}
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
        <p role="alert" className="mt-2 text-xs font-medium text-[#FF0033]">
          {error}
        </p>
      )}

      <div className="mt-3 flex flex-wrap items-center justify-end gap-2">
        {isConfirm && (
          <>
            <button
              type="button"
              disabled={submitting}
              onClick={() => onSubmit({ confirmed: false })}
              className="min-h-9 rounded-none border border-[#FF0033] px-4 py-1 text-sm font-medium text-[#FF0033] hover:bg-[#FF0033] hover:text-[#0D0208] disabled:opacity-50 transition-base"
            >
              Нет
            </button>
            <button
              type="button"
              disabled={submitting}
              autoFocus
              onClick={() => onSubmit({ confirmed: true })}
              className="min-h-9 rounded-none border border-[#00FF41] bg-[#003B00] px-4 py-1 text-sm font-medium text-[#00FF41] hover:bg-[#00FF41] hover:text-[#0D0208] disabled:opacity-50 transition-base"
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
            className="min-h-9 rounded-none border border-[#00FF41] bg-[#003B00] px-4 py-1 text-sm font-medium text-[#00FF41] hover:bg-[#00FF41] hover:text-[#0D0208] disabled:opacity-50 transition-base"
          >
            {submitting ? 'Отправка…' : submitLabel}
          </button>
        )}

        <button
          type="button"
          data-testid="question-cancel"
          disabled={submitting}
          onClick={onCancel}
          className="min-h-9 rounded-none border border-[#008F11] px-4 py-1 text-sm font-medium text-[#00FF41]/80 hover:border-[#00FF41] hover:text-[#00FF41] disabled:opacity-50 transition-base"
        >
          Отмена
        </button>
      </div>
    </div>
  );
}