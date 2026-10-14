// Общий контракт Issue Resolver. Не трогать без согласования с координатором.

export type TaskStatus =
  | 'pending'
  | 'running'
  /** Идёт разовая подготовка рабочей папки: clone репозиториев + install. */
  | 'preparing'
  | 'completed'
  | 'failed'
  | 'cancelled'
  /** Агент задал пользователю вопрос и ждёт ответа. */
  | 'question';

export type PipelineStep = 'refine' | 'resolve' | 'review' | 'test' | 'pr';

/**
 * Желаемый результат задачи: 'md' — Markdown-документ (`report.md`); 'html' —
 * самодостаточный `report.html`; 'pr' — публикация изменений (шаг pr, требует
 * репозиторий). По умолчанию 'md'.
 */
export type DesiredResult = 'md' | 'html';

/** Пер-шаговые модели: ключ — шаг пайплайна, значение — id модели pi. */
export type StepModels = Partial<Record<PipelineStep, string>>;

/**
 * Уровень размышления pi (reasoning effort): словарь CLI-флага `--thinking` и
 * RPC-команды `set_thinking_level`. Не задан — поведение pi по умолчанию.
 */
export type ThinkingLevel =
  | 'off'
  | 'minimal'
  | 'low'
  | 'medium'
  | 'high'
  | 'xhigh'
  | 'max';

/** Пер-шаговые уровни размышления: ключ — шаг, значение — уровень. */
export type StepThinkingLevels = Partial<Record<PipelineStep, ThinkingLevel>>;

export type StepRunStatus =
  | 'pending'
  | 'running'
  | 'success'
  | 'failed'
  | 'needs_input'
  | 'skipped'
  | 'aborted';

export interface IssueRepository {
  id: string;
  repository_url: string;
  branch_name: string;
  /** Создавать ли MR/PR для этого репозитория по итогам pr-шага. */
  create_mr: boolean;
  /**
   * Ставить ли зависимости и анализировать запуск для этого репозитория.
   * false — репозиторий только клонируется, install/анализ пропускаются.
   */
  bootstrap_enabled: boolean;
  created_at: string; // ISO 8601
  updated_at: string; // ISO 8601
}

/**
 * Файл, загруженный с задачей или итерацией. `rel_path` — путь относительно
 * корня рабочей папки задачи (= cwd агента), напр. `attachments/foo.pdf` или
 * `attachments/iteration-2/foo.pdf`. `iteration_id` — null для общезадачных
 * файлов (без привязки к итерации).
 */
export interface IssueFile {
  id: string;
  issue_id: string;
  iteration_id: string | null;
  name: string;
  rel_path: string;
  size: number;
  mime_type: string | null;
  created_at: string; // ISO 8601
}

/** Файл, порождённый агентом в рабочей папке завершённой итерации. */
export interface WorkspaceFile {
  name: string; // basename файла
  rel_path: string; // путь от корня рабочей папки (posix, '/' разделитель)
  size: number; // байты
  mime_type: string | null; // content-type
}

export interface Issue {
  id: string;
  title: string;
  jira_issue_url: string | null;
  /** Источник задачи: 'jira' для Jira, null для локальной. */
  source?: string | null;
  /** Порт запущенного dev-сервера (null если не запущен). */
  dev_server_port?: number | null;
  /** Описание задачи (additional_context). */
  description?: string;
  /** Желаемый результат задачи (по умолчанию 'html'). */
  desired_result?: DesiredResult;
  repositories: IssueRepository[];
  pipeline_steps: PipelineStep[];
  /** Пер-шаговые модели задачи (фолбек ниже — общий model). */
  step_models?: StepModels;
  /** Общий уровень размышления-фолбек для всех шагов. */
  thinking_level?: ThinkingLevel | null;
  /** Пер-шаговые уровни размышления; приоритет над `thinking_level`. */
  step_thinking_levels?: StepThinkingLevels;
  status: TaskStatus;
  created_at: string;
  updated_at: string;
  /** true — issue есть в БД, но его workspace-папка удалена (осиротевшая задача). */
  workspace_missing?: boolean;
}

export interface Iteration {
  id: string;
  issue_id: string;
  number: number;
  context: string;
  /** Контекст для Reviewer (может быть пустым). */
  review_context: string;
  /** Нужен ли запуск Reviewer. */
  is_review_need: boolean;
  steps: PipelineStep[];
  status: TaskStatus;
  /** Общая модель-фолбек для всех шагов (обратная совместимость). */
  model?: string | null;
  /** Пер-шаговые модели: `step_models[step]` переопределяет `model`. */
  step_models?: StepModels;
  /** Общий уровень размышления-фолбек для всех шагов. */
  thinking_level?: ThinkingLevel | null;
  /** Пер-шаговые уровни размышления; приоритет над `thinking_level`. */
  step_thinking_levels?: StepThinkingLevels;
  created_at: string;
  updated_at: string;
}

export interface RepositoryInput {
  repository_url: string;
  base_branch: string;
  /** Создавать ли MR/PR для этого репозитория (по умолчанию false). */
  create_mr?: boolean;
  /** Пропустить установку зависимостей и анализ запуска (по умолчанию true). */
  bootstrap_enabled?: boolean;
}

/**
 * Пункт `repositories` при создании задачи: явный URL (`RepositoryInput`)
 * либо ссылка на сохранённый репозиторий (`repo_id`). Если заданы оба —
 * приоритет у `repo_id`, а `base_branch` при отсутствии берётся из
 * `defaultBranch` репозитория.
 */
export interface SavedRepositoryInput {
  repo_id: string;
  /** Необязателен при заданном `repo_id`: иначе берётся URL репозитория. */
  repository_url?: string;
  /** Необязателен при заданном `repo_id`: иначе `defaultBranch`. */
  base_branch?: string;
  create_mr?: boolean;
  /** Пропустить установку зависимостей и анализ запуска (по умолчанию true). */
  bootstrap_enabled?: boolean;
}

export type CreateIssueRepositoryInput =
  | RepositoryInput
  | SavedRepositoryInput;

export interface CreateIssueRequest {
  title?: string;
  jira_issue_url?: string;
  /** Репозитории необязательны: можно создать задачу без них ([]). */
  repositories?: CreateIssueRepositoryInput[];
  /** Желаемый результат задачи: 'html' или 'pr' (требует репозиторий). */
  desired_result?: DesiredResult;
  additional_context?: string;
  review_context?: string;
  is_review_need?: boolean;
  pipeline_steps?: PipelineStep[];
  /** Общая модель-фолбек для всех шагов (обратная совместимость). */
  model?: string;
  /** Модель на конкретный шаг; имеет приоритет над `model`. */
  step_models?: StepModels;
  /** Модель агента-анализатора (разовая подготовка рабочей папки). */
  bootstrapper_model?: string;
  /** Общий уровень размышления-фолбек для всех шагов. */
  thinking_level?: ThinkingLevel;
  /** Уровень размышления на конкретный шаг; приоритет над `thinking_level`. */
  step_thinking_levels?: StepThinkingLevels;
}

export interface CreateIterationRequest {
  context: string;
  review_context?: string;
  is_review_need?: boolean;
  steps?: PipelineStep[];
  /** Общая модель-фолбек для всех шагов (обратная совместимость). */
  model?: string;
  /** Модель на конкретный шаг; имеет приоритет над `model`. */
  step_models?: StepModels;
  /** Общий уровень размышления-фолбек для всех шагов. */
  thinking_level?: ThinkingLevel;
  /** Уровень размышления на конкретный шаг; приоритет над `thinking_level`. */
  step_thinking_levels?: StepThinkingLevels;
}

export interface StepRun {
  id: string;
  iteration_id: string;
  step: PipelineStep;
  attempt: number;
  status: StepRunStatus;
  context: string;
  feedback: string | null;
  created_at: string;
  updated_at: string;
}

/** Токены одного ответа ассистента из стрима (`message_update.usage`). */
export interface SessionUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
}

/** Стоимость одного ответа из стрима (`message_update.usage.cost`). */
export interface SessionCost {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
}

/**
 * Скорость генерации сессии (токены/сек). `tokensPerSecond` — мгновенная
 * (Δ output / Δt по последним usage-событиям); `avgTokensPerSecond` — средняя
 * (Σ output / всё wall-clock время сессии).
 */
export interface SessionSpeed {
  tokensPerSecond: number;
  avgTokensPerSecond: number;
}

/**
 * Интерактивный вопрос расширения pi (`extension_ui_request`): select/confirm/
 * input/editor. `id` адресует ответ обратно в живую сессию.
 */
export interface SessionQuestion {
  id: string;
  method: 'select' | 'confirm' | 'input' | 'editor';
  title: string;
  message?: string;
  options?: string[];
  placeholder?: string;
  prefill?: string;
}

/** Причина запуска компакции контекста pi. */
export type CompactionReason = 'manual' | 'threshold' | 'overflow';

/** Структурированное событие pi-сессии: текст, размышление, вызов инструмента
 * или его результат, а также служебные события прозрачности (обновления
 * инструментов, компакция, ретраи, очередь, статусы расширений). */
export type SessionEvent =
  | { type: 'text'; text: string }
  | { type: 'thinking'; thinking: string }
  | {
      type: 'usage';
      usage: SessionUsage;
      cost: SessionCost | null;
      /** Скорость генерации; отсутствует до порога (elapsed < 1s или output = 0). */
      speed?: SessionSpeed;
    }
  | { type: 'stats'; stats: SessionStats }
  | ({ type: 'question' } & SessionQuestion)
  // Ответ пользователя на интерактивный вопрос: `answer` — выбранная метка
  // опции либо введённый текст (для confirm/cancel — «Да»/«Нет»/«Отменено»).
  | { type: 'question_answered'; questionId: string; answer: string }
  | { type: 'tool_use'; toolCallId: string; toolName: string; args: unknown }
  | {
      type: 'tool_result';
      toolCallId: string;
      toolName: string;
      isError: boolean;
      durationMs: number | null;
      resultText: string;
    }
  // Частичный текст вызова инструмента во время стрима.
  | { type: 'tool_update'; toolCallId: string; toolName: string; partialText: string }
  // Начало компакции контекста (manual/threshold/overflow).
  | { type: 'compaction_start'; reason: CompactionReason }
  // Конец компакции: результат, отмена, повтор и оценка токенов.
  | {
      type: 'compaction_end';
      reason: CompactionReason;
      summary: string | null;
      aborted: boolean;
      willRetry: boolean;
      errorMessage: string | null;
      tokensBefore: number | null;
      estimatedTokensAfter: number | null;
    }
  // Начало авто-ретрая или ретрая суммаризации.
  | {
      type: 'retry_start';
      kind: 'auto' | 'summarization';
      attempt: number | null;
      maxAttempts: number | null;
      delayMs: number | null;
      errorMessage: string | null;
      source: string | null;
      reason: string | null;
    }
  // Конец ретрая: успех/итоговая ошибка.
  | {
      type: 'retry_end';
      kind: 'auto' | 'summarization';
      success: boolean | null;
      attempt: number | null;
      finalError: string | null;
    }
  // Текущее содержимое очередей сообщений (steering/followUp).
  | { type: 'queue'; steering: string[]; followUp: string[] }
  // Изменение уровня размышления.
  | { type: 'thinking_level'; level: string }
  // Имя/заголовок сессии.
  | { type: 'session_info'; name: string | null }
  // Служебное уведомление расширения.
  | { type: 'notice'; level: 'info' | 'warning' | 'error'; message: string }
  // Произвольный статус расширения (key → текст или null при снятии).
  | { type: 'status'; key: string; text: string | null }
  // Виджет расширения (набор строк над/под редактором).
  | {
      type: 'widget';
      key: string;
      lines: string[] | null;
      placement: 'aboveEditor' | 'belowEditor';
    }
  // Изменение заголовка окна/сессии.
  | { type: 'title'; title: string }
  // Ошибка расширения.
  | { type: 'extension_error'; message: string }
  // Дельта вывода bash-команды.
  | { type: 'bash'; delta: string }
  // Текст, вставленный в редактор расширением.
  | { type: 'editor_text'; text: string };

/**
 * Статистика pi-сессии (`get_session_stats`): сообщения, токены, стоимость и
 * текущее использование контекстного окна. Числа деградируют до 0, когда
 * провайдер не отдал соответствующего поля; `cost` и `contextUsage` — null,
 * если данных нет.
 */
export interface SessionStats {
  sessionId?: string;
  /** Отображаемое имя модели, с которой реально шла сессия (`name`, иначе `id`). */
  model?: string;
  userMessages: number;
  assistantMessages: number;
  toolCalls: number;
  toolResults: number;
  totalMessages: number;
  tokens: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
  cost: number | null;
  contextUsage: {
    tokens: number | null;
    contextWindow: number;
    percent: number | null;
  } | null;
  /** Средняя скорость по сессии (токены/сек); отсутствует, пока неизвестна. */
  avgTokensPerSecond?: number;
}

export interface StepOutput {
  id: string;
  step_run_id: string;
  report: string;
  screenshots_dir: string | null;
  stdout: string;
  stderr: string;
  /** Структурированные события сессии шага. */
  events?: SessionEvent[];
  /** Статистика pi-сессии шага (get_session_stats) или null. */
  stats?: SessionStats | null;
  created_at: string;
  updated_at: string;
}

/** Прогон шага вместе с сырым логом (stdout/stderr) его output-строки. */
export interface StepRunWithLog extends StepRun {
  stdout: string;
  stderr: string;
  /** Структурированные события сессии (текст, thinking, tool_use, tool_result). */
  events: SessionEvent[];
  /** Статистика pi-сессии шага; null, если её нет или output-строки нет. */
  stats: SessionStats | null;
  /** null, если output-строки ещё нет. */
  report: string | null;
  screenshots_dir: string | null;
}

export type StepReportStatus = 'pass' | 'fail' | 'blocked';

/** Топология исполнения resolve, рекомендованная refine. */
export type ExecutionMode = 'single' | 'room' | 'stages';

/** Один этап последовательного исполнения плана (mode: 'stages'). */
export interface ExecutionStage {
  /** 1-based порядок исполнения. */
  index: number;
  name?: string;
  task?: string;
  /** Число параллельных воркеров этапа (>= 1). */
  executors?: number;
  /** Подзадачи, по одной на воркера. */
  decomposition?: string[];
}

/**
 * Рекомендация refine о том, КАК исполнять resolve. Refine — единственная
 * точка принятия решения о топологии прогона; движок распоряжается им
 * детерминированно (см. planExecutionMode): комната — только при явном
 * `mode: room` с осмысленным числом исполнителей, staged-план — при
 * `mode: stages` с 2+ валидными этапами, иначе — один агент.
 */
export interface ExecutionPlan {
  /** 'single' — один агент; 'room' — координатор + исполнители; 'stages' — последовательный план. */
  mode: ExecutionMode;
  /** Количество исполнителей для комнаты (>= 2). */
  executors?: number;
  /** Декомпозиция на подзадачи (по одной на исполнителя); опциональна. */
  decomposition?: string[];
  /** Этапы (только mode: 'stages'), в порядке исполнения. */
  stages?: ExecutionStage[];
  /** Обоснование выбора топологии (для человека/логирования). */
  rationale?: string;
}

/**
 * Живой агент комнаты resolve: координатор (lead) и воркеры сосуществуют в
 * одной итерации. `id` — стабильный адрес сессии агента (per-agent stepRunId):
 * `<stepRunId>` у координатора, `<stepRunId>/worker/<i>` у воркера.
 */
export interface RoomAgent {
  id: string;
  role: 'worker' | 'coordinator';
  /** 1..N в порядке декомпозиции; null у координатора. */
  index: number | null;
  /** Человекочитаемая подпись вкладки («Воркер 1», «Координатор»). */
  label: string;
  /** Номер этапа (1-based) staged-режима; null у обычной комнаты. */
  stage?: number | null;
  /** Имя этапа staged-режима; null/отсутствует иначе. */
  stageName?: string | null;
  status: 'running' | 'finished' | 'aborted' | 'failed';
  /** ISO-таймстамп регистрации агента; null для записей без тайминга. */
  startedAt: string | null;
  /**
   * Агрегированные токены/cost/context агента: usage-события его сессии,
   * поверх — последнее `stats`-событие (`get_session_stats`). null, пока
   * телеметрии нет (агент не запускался или не эмитил usage/stats).
   */
  stats: SessionStats | null;
}

export interface StepReportScenario {
  name: string;
  /** Старая форма: явный результат проверки. В форме expected/actual нет. */
  status?: 'pass' | 'fail';
  details?: string;
  /** Новая форма без status: что ожидалось и что получилось. */
  expected?: string;
  actual?: string;
}

export interface StepReportFinding {
  /**
   * Известные уровни автокомплитятся, но реальные отчёты приносят и другие
   * значения — произвольная строка допустима.
   */
  severity: 'info' | 'low' | 'minor' | 'major' | 'critical' | (string & {});
  /** Старая форма. В форме title/detail отсутствует. */
  description?: string;
  /** Новая форма без description. */
  title?: string;
  detail?: string;
}

export interface StepReport {
  status: StepReportStatus;
  summary: string;
  scenarios?: StepReportScenario[];
  findings?: StepReportFinding[];
  /**
   * Топология исполнения следующего шага (только refine). Отсутствует у
   * review/test/pr и у refine, который не делает рекомендацию.
   */
  execution?: ExecutionPlan;
  /** PR step only: MR title (Jira key + short description, ≤72 chars). */
  title?: string;
  /** PR step only: full MR description (Markdown with sections). */
  description?: string;
}

export interface StepExecutionResult {
  step: PipelineStep;
  exitCode: number;
  report: StepReport | null;
  stdout: string;
  stderr: string;
  /** Структурированные события сессии (текст, thinking, tool_use, tool_result). */
  events?: SessionEvent[];
  /** Статистика pi-сессии шага (get_session_stats) или null. */
  stats?: SessionStats | null;
  /** Пользователь прервал шаг: терминальный abort без retry. */
  aborted?: boolean;
}

export interface ContainerSpec {
  issueId: string;
  containerName: string;
  image: string;
  workspaceHostPath: string;
  repoUrls: string[];
  /** Имя общего named volume для памяти модели (agent-memory). */
  memoryVolumeName?: string;
  /** Путь монтирования памяти в контейнере (~/.pi/agent/memory). */
  memoryMountPath?: string;
}

export interface SpawnContainerResult {
  containerId: string;
  containerName: string;
  workspacePath: string;
}

/**
 * Живая статистика контейнера задачи (docker stats). `cpuPercent` — null,
 * когда дельты счётчиков ещё не набраны (или контейнер их не отдал; в
 * локальном режиме без Docker — всегда null). Остальные поля деградируют до 0.
 */
export interface ContainerStats {
  containerName: string;
  cpuPercent: number | null;
  memoryUsageBytes: number;
  memoryLimitBytes: number;
  pids: number;
}

/**
 * Тело события SSE `container_stats` (поток живой статистики контейнера):
 * та же метрика, что и `ContainerStats`, но без `containerName` — он известен
 * из URL потока.
 */
export interface ContainerStatsPayload {
  cpuPercent: number | null;
  memoryUsageBytes: number;
  memoryLimitBytes: number;
  pids: number;
}

/**
 * Шаг прогресса разовой подготовки рабочей папки (SSE `workspace_progress`).
 * `dev_server` идёт после успешного `installing`: бэкенд поднимает dev-сервер
 * репозитория и сообщает найденный порт в `WorkspaceProgress.devPort`.
 */
export type WorkspaceProgressStep =
  | 'creating_dirs'
  | 'cloning'
  | 'checking_instructions'
  | 'bootstrapping'
  | 'installing'
  | 'dev_server'
  | 'ready';

/** Данные одного события `workspace_progress`. */
export interface WorkspaceProgress {
  step: WorkspaceProgressStep;
  /** Репозиторий (`owner/repo`-подобное имя) для пошаговых шагов. */
  repo?: string;
  status: 'running' | 'done' | 'warning' | 'error';
  /** Причина ошибки/предупреждения (для `status: 'error' | 'warning'`). */
  message?: string;
  /**
   * Порт поднятого dev-сервера (только шаг `dev_server`, `status: 'done'`).
   * Фронт показывает его в шапке как «Dev: localhost:PORT».
   */
  devPort?: number;
}

/** Репортер прогресса подготовки: одно событие — один вызов. */
export type WorkspaceProgressReporter = (progress: WorkspaceProgress) => void;

/** Фаза фонового удаления задачи (SSE `issue_deleting`). */
export type IssueDeletingPhase =
  | 'stopping_processes'
  /**
   * Запись задачи удаляется из БД. Идёт ПЕРЕД контейнером и папкой: сбой БД
   * фатален (контейнер/папка не трогаются), иначе задача осталась бы
   * «зомби» — папки нет, запись есть.
   */
  | 'removing_db_record'
  | 'removing_workspace'
  | 'removing_container'
  /** Терминальная ошибка удаления; в `data` приходит `message`. */
  | 'error';

export type SSEEventType =
  | 'log'
  | 'step_status'
  | 'step_event'
  | 'iteration_status'
  /** Прогресс подготовки рабочей папки (clone/install/…): один шаг — событие. */
  | 'workspace_progress'
  /**
   * Живой stdout/stderr агента-бутстрапера во время подготовки.
   * `data` — JSON `{ repo, text, kind: 'stdout' | 'stderr' }`.
   */
  | 'bootstrap_log'
  /**
   * Прогресс фонового удаления задачи.
   * `data` — JSON `{ phase: IssueDeletingPhase, message? }`.
   */
  | 'issue_deleting'
  /** Задача удалена (запись в БД стёрта); иных данных, кроме `issueId`, нет. */
  | 'issue_deleted'
  /**
   * Живая стата контейнера задачи (Docker stream).
   * `data` — JSON `{ cpuPercent, memoryUsageBytes, memoryLimitBytes, pids }`.
   */
  | 'container_stats';

export interface SSEEvent {
  type: SSEEventType;
  issueId: string;
  /** ID итерации (отсутствует для issue-уровневых событий вроде workspace_progress). */
  iterationId?: string;
  stepRunId?: string;
  /** Адрес агента комнаты (RoomAgent.id), если эмит принадлежит конкретному агенту. */
  agentId?: string;
  stream?: 'stdout' | 'stderr' | 'rpc' | 'mr' | 'system';
  data: string;
  ts: string;
}

export interface ModelDescriptor {
  id: string;
  provider?: string;
  name?: string;
  contextWindow?: number;
  /** Уровни размышления, поддерживаемые моделью; для недумающей — ['off']. */
  thinkingLevels?: ThinkingLevel[];
}

/** Платформа хостинга репозитория. */
export type RepoPlatform = 'github' | 'gitlab' | 'bitbucket' | 'unknown';

/** Метаданные репозитория из API хостинг-платформы. */
export interface RepoInfo {
  platform: RepoPlatform;
  fullName: string; // "owner/repo"
  defaultBranch: string; // "main" / "master"
  branches: string[]; // список веток для выбора
  language: string | null;
  description: string | null;
  stars: number;
  isPrivate: boolean;
  cloneUrl: string; // https clone URL
  /** Есть ли у токена право на запись (иначе MR создать нельзя). */
  writeAccess: boolean;
}

/** Результат валидации одного URL репозитория. */
export interface RepoValidationResult {
  url: string;
  valid: boolean;
  platform: RepoPlatform;
  /** Метаданные, если репо найден. */
  info?: RepoInfo;
  /** Человекочитаемая ошибка, если репо не прошёл валидацию. */
  error?: string;
}

/** Данные Jira-задачи, полученные через API (не сохраняются в БД). */
export interface JiraIssueInfo {
  key: string;
  title: string;
  summary: string;
}

/** Результат живой валидации URL Jira-задачи через API. */
export interface JiraValidationResult {
  url: string;
  valid: boolean;
  /** Ключ задачи, извлечённый из URL; null если URL не парсится. */
  key?: string;
  /** Данные задачи Jira при успешной валидации. */
  issue?: JiraIssueInfo;
  /** Человекочитаемая ошибка, если Jira недоступна или URL невалиден. */
  error?: string;
}

/** Тело запроса POST /issue-resolver/api/v1/repos/validate */
export interface ValidateReposRequest {
  urls: string[];
}

/** Ответ POST /issue-resolver/api/v1/repos/validate */
export interface ValidateReposResponse {
  results: RepoValidationResult[];
}

/** Статус соединения сохранённого репозитория (последняя попытка валидации). */
export type RepoConnectionStatus = 'ok' | 'error' | 'unknown';

/** Статус сгенерированной инструкции по запуску репозитория. */
export type RunInstructionsStatus = 'unknown' | 'generated' | 'failed';

/**
 * Сохранённый репозиторий — самостоятельная сущность с CRUD. Метаданные
 * (`fullName`… `isPrivate`) заполняются результатом последней успешной
 * валидации; при ошибке они сбрасываются в null, а `connectionStatus` — 'error'.
 * Ветки здесь не хранятся: они меняются и запрашиваются live.
 */
export interface SavedRepo {
  id: string; // uuid
  url: string;
  platform: RepoPlatform | null;
  fullName: string | null;
  defaultBranch: string | null;
  cloneUrl: string | null;
  language: string | null;
  description: string | null;
  isPrivate: boolean | null;
  connectionStatus: RepoConnectionStatus;
  lastValidatedAt: string | null; // ISO 8601
  /** Есть ли у токена право на запись в репозиторий (последняя валидация). */
  writeAccess: boolean;
  /** Инструкция по запуску (Markdown: установка зависимостей, запуск). */
  runInstructions: string | null;
  /** Статус генерации `runInstructions` агентом-анализатором. */
  runInstructionsStatus: RunInstructionsStatus;
  createdAt: string; // ISO 8601
  updatedAt: string; // ISO 8601
}

/** Тело POST /issue-resolver/api/v1/repositories. */
export interface CreateRepoRequest {
  url: string;
}

/** Тело PUT /issue-resolver/api/v1/repositories/:id. */
export interface UpdateRepoRequest {
  url: string;
}

/** Ответ GET /issue-resolver/api/v1/repositories/:id/branches (live). */
export interface RepoBranchesResponse {
  branches: string[];
}

/** Один репозиторий в составе тега (строка таблицы tag_repositories). */
export interface TagRepository {
  id: string;
  tag_id: string;
  repository_id: string;
  bootstrap_enabled: boolean;
  created_at: string;
}

/** Тег со списком репозиториев, каждый — с полными метаданными SavedRepo. */
export interface Tag {
  id: string;
  name: string;
  description: string | null;
  run_instructions: string | null;
  run_instructions_status: RunInstructionsStatus;
  repositories: TagRepositoryWithRepo[];
  created_at: string;
  updated_at: string;
}

/** Строка tag_repository, обогащённая SavedRepo. */
export interface TagRepositoryWithRepo extends TagRepository {
  repository: SavedRepo;
}

export interface CreateTagRequest {
  name: string;
  description?: string;
  repositories: { repository_id: string; bootstrap_enabled?: boolean }[];
}

export interface UpdateTagRequest {
  name?: string;
  description?: string;
  repositories?: { repository_id: string; bootstrap_enabled?: boolean }[];
}