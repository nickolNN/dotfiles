import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  ContainerSpec,
  DesiredResult,
  ExecutionPlan,
  Iteration,
  PipelineStep,
  RoomWorkItem,
  RunInstructionsStatus,
  SessionEvent,
  SessionStats,
  SSEEvent,
  StepExecutionResult,
  StepOutput,
  StepReport,
  StepRun,
  StepModels,
  StepRunStatus,
  StepThinkingLevels,
  TaskStatus,
  ThinkingLevel,
  WorkspaceProgressReporter,
} from '@issue-resolver/shared';
import {
  extractRepoNameFromUrl,
  MAX_SELF_RETRIES,
  maxExecutorsFor,
  nextStepDecision,
  parseStepReport,
  planExecutionMode,
  SELF_RETRY_STEPS,
  stepRunStatusFromResult,
} from '@issue-resolver/shared';
import type { ContainerController } from '../docker/controller';
import type {
  DevServerStartResult,
  GitPrepareResult,
  GitService,
  RepoChangeDigest,
} from '../git/service';
import type { PiRunner } from '../pi/runner';
import type { RoomAgentInfo, StepSessionRegistry } from '../pi/session-registry';
import {
  detectGitHost,
  formatPrPublishErrors,
  type MrClient,
  type PrPublishError,
} from '../pr/mr';
import type { SseHub } from '../sse/hub';
import {
  containerNameFor,
  DEFAULT_WORKSPACE_ROOT,
  workspaceContainerDirFor,
  workspaceHostDirFor,
} from '../workspace/paths';
import { buildStepPrompt, type PrTarget } from './prompts';
import type { DevOpsAgent } from './devops';
import { runRoomResolve, runStagedResolve } from './room';
import {
  resolveAgentStallTimeoutMs,
  resolveAgentTimeoutMs,
  withAgentStallGuard,
  withAgentTimeout,
} from './timeout';

/** Канонический порядок исполнения шагов пайплайна. */
const PIPELINE_STEP_ORDER: readonly PipelineStep[] = [
  'refine',
  'resolve',
  'review',
  'test',
  'pr',
];

/**
 * Нормализует список шагов итерации: канонический порядок + дедуп.
 * Движок исполняет шаги строго в этом порядке, каким бы ни был порядок во
 * входном массиве (`iteration.steps`/`issue.pipelineSteps`) — порядок во
 * фронте не должен влиять на семантику прогона.
 */
export const canonicalStepOrder = (steps: PipelineStep[]): PipelineStep[] => {
  const unique = new Set(steps);
  return PIPELINE_STEP_ORDER.filter((step) => unique.has(step));
};

/**
 * Хранилище прогонов/отчётов шагов. Структурно совместимо с функциями
 * `db/step-runs.repo` (там они требуют первым аргументом `Db`), но движок от
 * БД не зависит — это порт, который наполняет вызывающий слой.
 */
export interface StepRunStore {
  createStepRun(input: {
    issueId: string;
    iterationId: string | null;
    step: PipelineStep;
    attempt: number;
    context: string;
  }): Promise<StepRun>;
  updateStepRun(
    id: string,
    patch: { status?: StepRunStatus; feedback?: string | null },
  ): Promise<StepRun>;
  /**
   * Дозапись одного события сессии в прогон до появления `step_outputs`
   * (вопрос агента и ответ на него должны пережить перезагрузку страницы).
   */
  appendStepRunEvent(id: string, event: SessionEvent): Promise<void>;
  createStepOutput(input: {
    stepRunId: string;
    report: string;
    screenshotsDir?: string;
    stdout?: string;
    stderr?: string;
    events?: SessionEvent[];
    stats?: SessionStats | null;
  }): Promise<StepOutput>;
}

export interface WorkflowDeps {
  container: ContainerController;
  git: GitService;
  pi: PiRunner;
  sse: SseHub;
  store: StepRunStore;
  mr: MrClient;
  /** Реестр живых pi-сессий для steer/abort. */
  control: StepSessionRegistry;
  /** Локальный режим без Docker: pi работает в host-папке задачи. */
  local?: boolean;
  /** Корень host-папок задач; по умолчанию `/workspaces`. */
  workspaceRoot?: string;
  /**
   * Хук смены статуса задачи при интерактивном вопросе агента: `question` —
   * агент ждёт ответа пользователя, `running` — ответ получен, работа идёт.
   * Движок от БД не зависит, поэтому статус задачи меняет вызывающий слой.
   */
  onQuestionStatus?: (status: 'question' | 'running') => void;
  /**
   * Post-iteration report agent spawn. Called when an iteration reaches a
   * terminal state (completed/failed) — NOT on retry loops. The engine
   * passes the iteration outcome and the callback decides whether to spawn.
   */
  onIterationTerminal?: (outcome: IterationTerminalOutcome) => void;
}

/**
 * Сигнал движка о терминальном завершении итерации (не retry).
 * Содержит всё, что нужно report-агенту для сборки отчёта.
 */
export interface IterationTerminalOutcome {
  issueId: string;
  /** id терминалившейся итерации — источник единой модели отчёта. */
  iterationId: string;
  issueTitle: string;
  iterationNumber: number;
  iterationStatus: 'completed' | 'failed';
  iterationCount: number;
  /** Путь рабочей папки на host-машине. */
  workspaceHostDir: string;
  /** Путь рабочей папки, видимый агенту. */
  workspaceContainerPath: string;
  containerName: string;
  repoPaths: string[];
  thinkingLevel?: ThinkingLevel;
  /** Шаги конвейера этой итерации — чтобы post-iteration report не спавнился, когда report уже в пайплайне. */
  pipelineSteps: PipelineStep[];
}

export interface RunIterationInput {
  issue: {
    id: string;
    title: string;
    pipelineSteps: PipelineStep[];
    /** Желаемый результат задачи: 'md' (report.md), 'html' (report.html) или 'pr'. */
    desiredResult?: DesiredResult;
  };
  iteration: Iteration;
  repositories: {
    repository_url: string;
    base_branch: string;
    /** Создавать ли MR/PR для этого репозитория (per-repo). */
    create_mr?: boolean;
    /** false — репозиторий клонируется, но install/анализ запуска пропускаются. */
    bootstrap_enabled?: boolean;
  }[];
  /** Общая модель-фолбек для всех шагов (обратная совместимость). */
  model?: string;
  /** Пер-шаговые модели: `step_models[step]` переопределяет `model`. */
  step_models?: StepModels;
  /** Общий уровень размышления-фолбек для всех шагов. */
  thinking_level?: ThinkingLevel;
  /** Пер-шаговые уровни размышления; приоритет над `thinking_level`. */
  step_thinking_levels?: StepThinkingLevels;
  /** Токен для MR/PR (в проде — из secrets). */
  mrToken?: string;
  /**
   * Готовые рабочие копии репозиториев (clone + install уже выполнены
   * `prepareWorkspace` один раз при инициализации задачи). Если не задано —
   * движок считает, что репозиториев нет.
   */
  preparedRepoWorkspaces?: GitPrepareResult['repoWorkspaces'];
  /** Описание задачи для промпта. */
  description?: string;
  /** Текст задачи из Jira для промпта (или null). */
  jiraText?: string | null;
  /** Итог предыдущей итерации для промпта (или undefined на итерации №1). */
  previousOutcome?: string | null;
  /** Пути загруженных файлов (относительно корня рабочей папки задачи). */
  attachmentPaths?: string[];
  /**
   * Порт dev-сервера, который система подняла для этой задачи (из
   * `issues.dev_server_port`). Попадает в промпты: шаг `test` проверяет
   * приложение по этому URL, остальные знают, что сервер уже живой.
   */
  devServerPort?: number | null;
  /**
   * Переопределение таймаута одного pi-агента (мс) для этого прогона.
   * По умолчанию — env/30 мин; короткие значения используются в тестах.
   */
  agentTimeoutMs?: number;
  /**
   * Per-run silence window for one pi agent (ms); tests use short values.
   * Defaults to env/15 min.
   */
  agentStallTimeoutMs?: number;
}

export interface RunIterationResult {
  iterationStatus: TaskStatus;
  needsInput: boolean;
}

const IMAGE = 'dotfiles-agent';
const MAX_ATTEMPTS = 3;

/** Имя файла-отчёта, который шаг конвейера пишет в рабочую папку задачи. */
const STEP_REPORT_FILE = '.issue-step-result.json';

/** Каталог скриншотов шага в рабочей папке (его заполняет шаг `test`). */
const SCREENSHOTS_DIR = 'screenshots';

/**
 * Каталог скриншотов, если шаг его создал: UI показывает ссылку из
 * `screenshots_dir`. Нет каталога — undefined, колонка остаётся null.
 */
async function screenshotsDirOf(
  workspaceHostDir: string,
): Promise<string | undefined> {
  try {
    await stat(join(workspaceHostDir, SCREENSHOTS_DIR));
    return SCREENSHOTS_DIR;
  } catch {
    return undefined;
  }
}

const nowIso = (): string => new Date().toISOString();

/** Подмножество WorkflowDeps, нужное разовой подготовке рабочей папки. */
export interface RunInstructionsPort {
  /** Текущий статус инструкций репозитория (undefined — строки нет). */
  getStatus(repoUrl: string): RunInstructionsStatus | undefined;
  /** Сохранённый Markdown-инструкции репозитория (null — нет/пусто). */
  getInstructions(repoUrl: string): string | null;
  /** Успех анализа: сохранить Markdown-инструкцию и статус `generated`. */
  saveGenerated(repoUrl: string, instructions: string): void;
  /** Сбой/устаревание: статус `failed`, инструкция очищается. */
  saveFailed(repoUrl: string): void;
}

/** Фабрика анализатора для конкретной рабочей папки задачи. */
export type DevOpsFactory = (params: {
  /** Имя контейнера задачи. */
  containerName: string;
  /** Host-путь рабочей папки задачи (чтение результата). */
  hostWorkspaceDir: string;
  /** Путь рабочей папки, видимый агенту (container-путь или host в local). */
  containerWorkspaceDir: string;
  /** ID задачи — создаёт комнату `issue-<issueId>` для интерактивной сессии. */
  issueId: string;
  /** ID итерации — адрес сессии в реестре. */
  iterationId?: string;
  /** stepRunId для регистрации живой сессии (фронт привязывается по нему). */
  stepRunId?: string;
  /** Реестр живых сессий для steer/abort. */
  registry?: import('../pi/session-registry').StepSessionRegistry;
  /**
   * Тег-инструкции проекта (Markdown). Агент читает их до начала работы и
   * пишет `WORKSPACE_INSTRUCTIONS.md` в корень рабочей папки.
   */
  tagInstructions?: string | null;
  /** Модель агента-анализатора (по умолчанию — дефолт pi). */
  model?: string;
  /** Уровень размышления pi (`--thinking`) для агента-анализатора. */
  thinkingLevel?: ThinkingLevel;
  /** Таймаут анализа (мс); undefined — без потолка (фейковый дефолт/тесты). */
  timeoutMs?: number;
  /** Stream stdout от DevOps-агента в SSE. */
  onStdout?: (chunk: string) => void;
  /** Stream stderr от DevOps-агента в SSE. */
  onStderr?: (chunk: string) => void;
  /** Имена всех репозиториев в workspace (через запятую). */
  reposNames?: string | null;
  /** Имена репозиториев, отмеченных для запуска dev-сервера (через запятую). */
  reposRequireDevServer?: string | null;
  /** Per-репозиторий инструкции по запуску (Markdown-секция с ###). */
  reposInstructions?: string | null;
}) => DevOpsAgent;

/** Зависимости разовой подготовки рабочей папки (подмножество WorkflowDeps). */
export interface PrepareWorkspaceDeps {
  container: ContainerController;
  git: GitService;
  /** Корень host-папок задач; по умолчанию `/workspaces`. */
  workspaceRoot?: string;
  /** Локальный режим без Docker: анализ идёт в host-папке задачи. */
  local?: boolean;
  /** Фабрика анализатора; без неё анализ не запускается. */
  devops?: DevOpsFactory;
  /** Порт чтения/записи `run_instructions*`; без него анализ не запускается. */
  runInstructions?: RunInstructionsPort;
  /** Модель анализирующего pi-агента. */
  devopsModel?: string;
  /** Уровень размышления pi (`--thinking`) для агента-анализатора. */
  devopsThinkingLevel?: ThinkingLevel;
  /**
   * Таймаут одного прогона анализа (мс). Не задан — фабрика анализатора берёт
   * свой дефолт; без потолка зависший `pi` держит задачу в `preparing`.
   */
  devopsTimeoutMs?: number;
  /**
   * Порт dev-сервера задачи (из port-allocator). Пробрасывается в промпт
   * DevOps-агента как `{{DEV_SERVER_PORT}}`. Задан — legacy-автозапуск
   * dev-сервера из `RUN_INSTRUCTIONS.md` пропускается (управляемый сервер
   * поднимает `prepareIssueWorkspace` из `DEV_SERVER.sh`).
   */
  devServerPort?: number;
  /** Проброс stdout DevOps-агента в SSE: имя репозитория + порция вывода. */
  onDevOpsStdout?: (repo: string, chunk: string) => void;
  /** Проброс stderr DevOps-агента в SSE: имя репозитория + порция вывода. */
  onDevOpsStderr?: (repo: string, chunk: string) => void;
  /** ID задачи — комната `issue-<issueId>` для интерактивной сессии DevOps-агента. */
  issueId?: string;
  /** ID итерации — адрес сессии в реестре. */
  iterationId?: string;
  /** Реестр живых сессий для steer/abort DevOps-агента. */
  control?: import('../pi/session-registry').StepSessionRegistry;
  /**
   * Тег-инструкции — Markdown-документ о том, как запускать весь набор репозиториев
   * вместе (прокси, порты, переменные). null — инструкций нет.
   */
  tagInstructions?: string | null;
  /** Имена всех репозиториев в workspace (через запятую). */
  reposNames?: string | null;
  /** Имена репозиториев, отмеченных для запуска dev-сервера (через запятую). */
  reposRequireDevServer?: string | null;
  /** Per-репозиторий инструкции по запуску (Markdown-секция с ###). */
  reposInstructions?: string | null;
}

/**
 * Типы прогресса разовой подготовки живут в общем контракте
 * (`@issue-resolver/shared`); реэкспорт сохраняет прежние импорты из движка.
 */
export type {
  WorkspaceProgress,
  WorkspaceProgressReporter,
  WorkspaceProgressStep,
} from '@issue-resolver/shared';

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * Разовая подготовка рабочей папки задачи перед первой итерацией: создаёт/
 * spawn-ит контейнер, идемпотентно клонирует репозитории и детерминированно
 * ставит зависимости. Без репозиториев возвращает [] (контейнер и папка
 * задачи всё равно создаются).
 *
 * При переданном `onProgress` каждый этап/репозиторий сообщает о себе
 * (`workspace_progress`); при ошибке этапа — событие `status: 'error'` с
 * причиной, после чего ошибка пробрасывается вызывающему слою.
 */
export async function prepareWorkspace(
  deps: PrepareWorkspaceDeps,
  issue: { id: string },
  repositories: RunIterationInput['repositories'],
  onProgress?: WorkspaceProgressReporter,
): Promise<GitPrepareResult['repoWorkspaces']> {
  const workspaceRoot = deps.workspaceRoot ?? DEFAULT_WORKSPACE_ROOT;
  const workspaceHostDir = workspaceHostDirFor(workspaceRoot, issue.id);
  const repoUrls = repositories.map((repo) => repo.repository_url);
  const baseBranches = repositories.map((repo) => repo.base_branch);

  const spec: ContainerSpec = {
    issueId: issue.id,
    containerName: containerNameFor(issue.id),
    image: IMAGE,
    workspaceHostPath: workspaceHostDir,
    repoUrls,
    // Общая на все контейнеры память модели — named volume.
    memoryVolumeName: process.env.ISSUE_RESOLVER_MEMORY_VOLUME || 'agent-memory',
  };

  onProgress?.({ step: 'creating_dirs', status: 'running' });
  try {
    await deps.container.spawn(spec);
  } catch (error) {
    onProgress?.({
      step: 'creating_dirs',
      status: 'error',
      message: errorMessage(error),
    });
    throw error;
  }
  onProgress?.({ step: 'creating_dirs', status: 'done' });

  if (repositories.length === 0) {
    // Шаги clone/install не выполняются, но фаза проверки инструкций и
    // терминальный `ready` общие для всех задач (в т.ч. без репозиториев).
    onProgress?.({ step: 'checking_instructions', status: 'running' });
    onProgress?.({ step: 'checking_instructions', status: 'done' });
    onProgress?.({ step: 'ready', status: 'done' });
    return [];
  }

  let currentRepo: string | null = null;
  const prepared = await deps.git
    .prepare({
      repoUrls,
      baseBranches,
      workspacePath: workspaceHostDir,
      onRepoProgress: (repoUrl, status) => {
        currentRepo = repoUrl;
        onProgress?.({
          step: 'cloning',
          repo: extractRepoNameFromUrl(repoUrl),
          status,
        });
      },
    })
    .catch((error) => {
      onProgress?.({
        step: 'cloning',
        ...(currentRepo
          ? { repo: extractRepoNameFromUrl(currentRepo) }
          : {}),
        status: 'error',
        message: errorMessage(error),
      });
      throw error;
    });

  // Пер-репозиторный флаг `bootstrap_enabled` (по умолчанию true): false —
  // репозиторий клонируется, но install/анализ запуска для него пропускаются.
  // Ключ — URL+ветка (уникальность строки issue_repositories), фолбек по URL.
  const bootstrapEnabledByKey = new Map(
    repositories.map((repo) => [
      `${repo.repository_url}\u0000${repo.base_branch}`,
      repo.bootstrap_enabled !== false,
    ]),
  );
  const bootstrapEnabledByUrl = new Map(
    repositories.map((repo) => [
      repo.repository_url,
      repo.bootstrap_enabled !== false,
    ]),
  );
  const isBootstrapEnabled = (workspace: {
    repoUrl: string;
    branch: string;
  }): boolean =>
    bootstrapEnabledByKey.get(
      `${workspace.repoUrl}\u0000${workspace.branch}`,
    ) ??
    bootstrapEnabledByUrl.get(workspace.repoUrl) ??
    true;

  // Анализ run_instructions ДО install: агент может починить установку и
  // записать инструкцию, по которой пойдёт `installDependencies`. Репозитории
  // со статусом `generated` повторно не анализируются.
  const generatedRepos: string[] = [];
  const runInstructions = deps.runInstructions;
  onProgress?.({ step: 'checking_instructions', status: 'running' });
  if (deps.devops && runInstructions) {
    const containerWorkspaceDir = deps.local
      ? workspaceHostDir
      : workspaceContainerDirFor(issue.id);
    for (const workspace of prepared.repoWorkspaces) {
      const repoName = extractRepoNameFromUrl(workspace.repoUrl);
      if (!isBootstrapEnabled(workspace)) {
        // Репозиторий только клонируется: анализ запуска пропущен.
        onProgress?.({
          step: 'devops',
          repo: repoName,
          status: 'done',
          message: 'пропущен',
        });
        continue;
      }
      if (runInstructions.getStatus(workspace.repoUrl) === 'generated') {
        // Инструкция уже есть — install пойдёт по ней, анализ не нужен.
        generatedRepos.push(workspace.repoUrl);
        onProgress?.({ step: 'checking_instructions', repo: repoName, status: 'done' });
        continue;
      }
      onProgress?.({ step: 'checking_instructions', repo: repoName, status: 'running' });
      onProgress?.({ step: 'devops', repo: repoName, status: 'running' });
      const devopsId = `${issue.id}/devops`;
      const devops = deps.devops({
        containerName: spec.containerName,
        hostWorkspaceDir: workspaceHostDir,
        containerWorkspaceDir,
        issueId: issue.id,
        iterationId: deps.iterationId,
        stepRunId: devopsId,
        registry: deps.control,
        tagInstructions: deps.tagInstructions,
        reposNames: deps.reposNames,
        reposRequireDevServer: deps.reposRequireDevServer,
        reposInstructions: deps.reposInstructions,
        model: deps.devopsModel,
        thinkingLevel: deps.devopsThinkingLevel,
        timeoutMs: deps.devopsTimeoutMs,
        // Репозиторий известен только в цикле — заворачиваем колбэки, чтобы
        // SSE-логи DevOps-агента можно было привязать к конкретному репо.
        onStdout: (chunk) => deps.onDevOpsStdout?.(repoName, chunk),
        onStderr: (chunk) => deps.onDevOpsStderr?.(repoName, chunk),
      });
      const result = await devops.runDevOps(
        containerWorkspaceDir,
        workspace.repoUrl,
        repoName,
        deps.devServerPort,
      );
      if (result.success && result.instructions) {
        runInstructions.saveGenerated(
          workspace.repoUrl,
          result.instructions,
        );
        generatedRepos.push(workspace.repoUrl);
        // Реальное исполнение инструкций — отдельная задача; пока логируем.
        // TODO(run-instructions): здесь применить `result.instructions` вместо/
        // поверх `deps.git.installDependencies` ниже (парсинг команд install/
        // build/run из Markdown и их прогон в контейнере).
        console.log(
          `run instructions for ${repoName}:\n${result.instructions}`,
        );
        onProgress?.({
          step: 'devops',
          repo: repoName,
          status: 'done',
          message: 'Инструкции сохранены',
        });
      } else {
        runInstructions.saveFailed(workspace.repoUrl);
        onProgress?.({
          step: 'devops',
          repo: repoName,
          status: 'error',
          message: result.error ?? 'не удалось сгенерировать инструкции',
        });
      }
    }
  }
  onProgress?.({ step: 'checking_instructions', status: 'done' });

  for (const workspace of prepared.repoWorkspaces) {
    const repoName = extractRepoNameFromUrl(workspace.repoUrl);
    if (!isBootstrapEnabled(workspace)) {
      // Установка зависимостей для этого репозитория отключена.
      onProgress?.({
        step: 'installing',
        repo: repoName,
        status: 'done',
        message: 'пропущен',
      });
      continue;
    }
    onProgress?.({ step: 'installing', repo: repoName, status: 'running' });
    try {
      await deps.git.installDependencies([workspace.path]);
    } catch (error) {
      // Install упал даже по инструкции анализатора — инструкции устарели.
      for (const repoUrl of generatedRepos) {
        runInstructions?.saveFailed(repoUrl);
      }
      onProgress?.({
        step: 'installing',
        repo: repoName,
        status: 'error',
        message: errorMessage(error),
      });
      throw error;
    }
    onProgress?.({ step: 'installing', repo: repoName, status: 'done' });

    // Управляемый dev-сервер: `prepareIssueWorkspace` поднимает DEV_SERVER.sh
    // на порту из port-allocator после возврата `prepareWorkspace`. Здесь
    // legacy-автозапуск из RUN_INSTRUCTIONS.md пропускаем, чтобы не плодить
    // второй сервер; без выделенного порта поведение прежнее.
    if (deps.devServerPort !== undefined) {
      continue;
    }

    // Dev-сервер поднимаем опционально: после успешного install берём
    // сохранённую инструкцию репозитория и по выводу команды определяем порт.
    // Сбой — `warning`, а не `error`: подготовка уже состоялась.
    onProgress?.({ step: 'dev_server', repo: repoName, status: 'running' });
    const instructionsText =
      runInstructions?.getInstructions(workspace.repoUrl) ?? null;
    let devStart: DevServerStartResult;
    try {
      devStart = await deps.git.startDevServer(
        workspace.path,
        instructionsText,
      );
    } catch (error) {
      devStart = { port: null, message: errorMessage(error) };
    }
    if (devStart.port === null) {
      onProgress?.({
        step: 'dev_server',
        repo: repoName,
        status: 'warning',
        message: devStart.message ?? 'не удалось определить порт',
      });
    } else {
      onProgress?.({
        step: 'dev_server',
        repo: repoName,
        status: 'done',
        message: `localhost:${devStart.port}`,
        devPort: devStart.port,
      });
    }
  }

  onProgress?.({ step: 'ready', status: 'done' });

  return prepared.repoWorkspaces;
}

async function stepReportCandidates(workspaceHostDir: string): Promise<string[]> {
  const rootFile = join(workspaceHostDir, STEP_REPORT_FILE);
  const repoFiles = await depthOneStepReportFiles(workspaceHostDir);
  return [rootFile, ...repoFiles];
}

/** `<workspace>/<repo>/.issue-step-result.json` — where a `cd <repo>` step drops it. */
async function depthOneStepReportFiles(
  workspaceHostDir: string,
): Promise<string[]> {
  try {
    const entries = await readdir(workspaceHostDir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(workspaceHostDir, entry.name, STEP_REPORT_FILE));
  } catch {
    return [];
  }
}

interface StepReportSource {
  report: StepReport;
  path: string;
}

/** Report file mtimes taken before a step starts, keyed by path. */
type StepReportMtimes = Map<string, number>;

async function stepReportMtimes(
  workspaceHostDir: string,
): Promise<StepReportMtimes> {
  const mtimes = await Promise.all(
    (await stepReportCandidates(workspaceHostDir)).map(async (path) => {
      try {
        return [path, (await stat(path)).mtimeMs] as const;
      } catch {
        return null;
      }
    }),
  );
  return new Map(mtimes.filter((entry) => entry !== null));
}

/**
 * Reads the report the current step wrote: only files touched after the `before`
 * snapshot. All steps share one report path, so an untouched file still carries
 * the previous step's verdict — accepting it judges this step by someone else's
 * work. Workspace root wins, then the newest rewritten repo copy.
 */
async function readStepReportFile(
  workspaceHostDir: string,
  before: StepReportMtimes,
): Promise<StepReportSource | null> {
  const touched = await Promise.all(
    (await stepReportCandidates(workspaceHostDir)).map(async (path) => {
      try {
        const { mtimeMs } = await stat(path);
        if (mtimeMs <= (before.get(path) ?? Number.NEGATIVE_INFINITY)) return null;
        const report = parseStepReport(await readFile(path, 'utf8'));
        return report ? { report, path, mtimeMs } : null;
      } catch {
        return null;
      }
    }),
  );

  const fresh = touched.filter((entry) => entry !== null);
  if (fresh.length === 0) return null;

  const rootFile = join(workspaceHostDir, STEP_REPORT_FILE);
  const newestFirst = fresh.sort((left, right) => right.mtimeMs - left.mtimeMs);
  const chosen =
    newestFirst.find((entry) => entry.path === rootFile) ?? newestFirst[0];
  return { report: chosen.report, path: chosen.path };
}

/**
 * Снимок рабочей копии для промптов шага. Дешёвый (два read-only git-вызова на
 * репозиторий) и снимает с агента обязанность заново открывать шаг
 * `git status`/`git diff --stat`. Сбой git не должен ронять шаг из-за
 * ориентации — поэтому best-effort с пустым дайджестом.
 */
async function changeDigestOf(
  git: GitService,
  repoPaths: string[],
): Promise<RepoChangeDigest[]> {
  if (repoPaths.length === 0) return [];
  try {
    return await git.changeDigest(repoPaths);
  } catch (error) {
    console.error('workflow: change digest failed, prompt without it', error);
    return [];
  }
}

const stepStatusEvent = (
  issueId: string,
  iterationId: string,
  stepRunId: string,
  status: StepRunStatus | 'running',
  runningStep?: { step: PipelineStep; model?: string },
): SSEEvent => ({
  type: 'step_status',
  issueId,
  iterationId,
  stepRunId,
  data: runningStep
    ? JSON.stringify({
        status,
        step: runningStep.step,
        model: runningStep.model ?? null,
      })
    : status,
  ts: nowIso(),
});

const streamEvent = (
  issueId: string,
  iterationId: string,
  stepRunId: string,
  stream: NonNullable<SSEEvent['stream']>,
  data: string,
  agentId?: string,
): SSEEvent => ({
  type: 'log',
  issueId,
  iterationId,
  stepRunId,
  ...(agentId ? { agentId } : {}),
  stream,
  data,
  ts: nowIso(),
});

/** Живой structured-эмит одного события сессии шага. */
const stepEvent = (
  issueId: string,
  iterationId: string,
  stepRunId: string,
  event: SessionEvent,
  agentId?: string,
): SSEEvent => ({
  type: 'step_event',
  issueId,
  iterationId,
  stepRunId,
  ...(agentId ? { agentId } : {}),
  stream: 'system',
  data: JSON.stringify(
    agentId ? { stepRunId, agentId, event } : { stepRunId, event },
  ),
  ts: nowIso(),
});

/**
 * Прогон одной итерации: один контейнер на итерацию, шаги по порядку,
 * цикл фидбека review/test → resolve (до MAX_ATTEMPTS), затем needs_input.
 *
 * НЕ трогает git.commitAndPush/container.remove — публикация результата (pr)
 * относится к Фазе 4 и вызывается отдельно.
 */
export async function runIteration(
  deps: WorkflowDeps,
  input: RunIterationInput,
): Promise<RunIterationResult> {
  const { issue, iteration } = input;
  const workspaceRoot = deps.workspaceRoot ?? DEFAULT_WORKSPACE_ROOT;
  const containerName = containerNameFor(issue.id);
  const workspaceHostDir = workspaceHostDirFor(workspaceRoot, issue.id);
  const workspaceContainerPath = workspaceContainerDirFor(issue.id);

  // Подготовка (spawn контейнера + clone + install) выполнена один раз до
  // старта конвейера (см. `prepareWorkspace` / run-iteration.service) и
  // передана сюда: движок лишь использует готовые рабочие копии.
  const repoWorkspaces = input.preparedRepoWorkspaces ?? [];
  const repoPaths = repoWorkspaces.map((workspace) => workspace.path);
  // Цели публикации для шага `pr`: рабочая копия + base-ветка + флаг MR.
  // Промпт `pr` получает их явно, чтобы агент не угадывал ветку по git.
  const prTargets: PrTarget[] = repoWorkspaces.map((workspace) => {
    const repo = input.repositories.find(
      (item) => item.repository_url === workspace.repoUrl,
    );
    return {
      path: workspace.path,
      baseBranch: repo?.base_branch ?? workspace.branch,
      createMr: repo?.create_mr ?? false,
    };
  });

  const rawSteps =
    iteration.steps.length > 0 ? iteration.steps : issue.pipelineSteps;
  const steps = canonicalStepOrder(rawSteps);

  let stepIndex = 0;
  // attempt общий для шагов одного прохода: resolve#2 → review#2 (см. UNIQUE
  // step_runs(iteration_id, step, attempt) и план §8 «откат с attempt+1»).
  let attempt = 1;
  // pipelineAttempt — счётчик для nextStepDecision, НЕ растёт от self-retry.
  // Self-retry бампает attempt (для уникальности step_runs), но не трогает
  // pipeline-бюджет (MAX_ATTEMPTS=3 для откатов review/test → resolve).
  let pipelineAttempt = 1;
  // Счётчик самоперезапусков текущего шага, сбрасывается при смене шага.
  let stepRetries = 0;
  // Фидбек прошлого упавшего шага (review/test) для следующего resolve.
  let feedback: string | null = null;
  // Рекомендация refine о топологии resolve: план (summary) и execution.
  // Заполняется только успешным refine-шагом; до него — null (single).
  let refinedPlan: string | null = null;
  let refinedExecution: ExecutionPlan | null = null;
  // Общий таймаут одного pi-агента: override прогона или env-дефолт (30 мин).
  const agentTimeoutMs = input.agentTimeoutMs ?? resolveAgentTimeoutMs();
  // A hang shows up as silence, not as elapsed time.
  const agentStallMs = input.agentStallTimeoutMs ?? resolveAgentStallTimeoutMs();
  // Потолок параллельности из `worker_count` задачи: единственная ручка
  // пользователя на число исполнителей, поэтому она ограничивает движок, а не
  // только текст промпта refine (0/undefined → системный потолок).
  const maxExecutors = maxExecutorsFor(iteration.worker_count);

  /** Строит IterationTerminalOutcome для post-iteration report-агента. */
  const buildTerminalOutcome = (
    outcomeStatus: 'completed' | 'failed' | 'cancelled',
  ): IterationTerminalOutcome => ({
    issueId: issue.id,
    iterationId: iteration.id,
    issueTitle: issue.title,
    iterationNumber: iteration.number,
    iterationStatus: outcomeStatus === 'cancelled' ? 'failed' : outcomeStatus,
    iterationCount: iteration.number,
    workspaceHostDir,
    workspaceContainerPath,
    containerName,
    repoPaths,
    thinkingLevel: input.thinking_level,
    pipelineSteps: steps,
  });

  while (stepIndex < steps.length) {
    const step = steps[stepIndex];

    const stepRun = await deps.store.createStepRun({
      issueId: issue.id,
      iterationId: iteration.id,
      step,
      attempt,
      context: iteration.context,
    });
    // Прогон создаётся как `pending`; фиксируем `running` в БД, а не только в
    // SSE — иначе refetch во время работы шага видит `pending`.
    await deps.store.updateStepRun(stepRun.id, { status: 'running' });
    const model = (input.step_models?.[step] ?? input.model) || undefined;
    const thinkingLevel =
      (input.step_thinking_levels?.[step] ?? input.thinking_level) || undefined;
    deps.sse.publish(
      stepStatusEvent(issue.id, iteration.id, stepRun.id, 'running', {
        step,
        model,
      }),
    );

    // Общий prompt-контекст шага: одинаков для single-resolve и работников
    // комнаты (у комнаты отличие только в buildRoom* промптах).
    // Снимок перечитывается перед КАЖДЫМ шагом: предыдущий шаг что-то изменил.
    const stateDigest = await changeDigestOf(deps.git, repoPaths);
    // Agent-visible cwd: the prompt states it, otherwise "working folder" reads
    // as the repository clone (where agents already `cd`).
    const agentWorkingDir = deps.local ? workspaceHostDir : workspaceContainerPath;
    const promptContext = {
      issueTitle: issue.title,
      description: input.description ?? '',
      jiraText: input.jiraText ?? null,
      context: iteration.context,
      reviewContext: iteration.review_context ?? '',
      feedback,
      repoPaths,
      desiredResult: issue.desiredResult,
      previousOutcome: input.previousOutcome,
      attachmentPaths: input.attachmentPaths ?? [],
      pipelineSteps: steps,
      devServerPort: input.devServerPort ?? null,
      prTargets,
      workerCount: iteration.worker_count ?? undefined,
      stateDigest,
      workingDir: agentWorkingDir,
    };
    // Watchdog counter: any stdout/stderr chunk or session event proves the
    // agent is alive. An empty stream is a hung session, not a long step.
    let stepActivity = 0;
    const runOptions = {
      model,
      thinkingLevel,
      cwd: agentWorkingDir,
      iterationId: iteration.id,
      issueId: issue.id,
      registry: deps.control,
      timeoutMs: agentTimeoutMs,
      onStdout: (chunk: string, agent?: RoomAgentInfo) => {
        stepActivity += 1;
        deps.sse.publish(
          streamEvent(
            issue.id,
            iteration.id,
            stepRun.id,
            'stdout',
            chunk,
            agent?.id,
          ),
        );
      },
      onStderr: (chunk: string, agent?: RoomAgentInfo) => {
        stepActivity += 1;
        deps.sse.publish(
          streamEvent(
            issue.id,
            iteration.id,
            stepRun.id,
            'stderr',
            chunk,
            agent?.id,
          ),
        );
      },
      onEvent: (event: SessionEvent, agent?: RoomAgentInfo) => {
        stepActivity += 1;
        deps.sse.publish(
          stepEvent(issue.id, iteration.id, stepRun.id, event, agent?.id),
        );
        // Интерактивный диалог агента (ctx.ui.*): пока ждём ответ — задача
        // `question`; ответ ушёл — снова `running`. Обновление задачи, а не
        // итерации: `question` виден в списке задач.
        if (event.type === 'question') {
          deps.onQuestionStatus?.('question');
          // Дозапись вопроса в БД: step_outputs-строки ещё нет, а после
          // перезагрузки страницы вопрос восстанавливается из
          // step_runs.events. onEvent вызывается синхронно и его результат не
          // ожидается, поэтому не await, а fire-and-forget с логом ошибки.
          void deps.store
            .appendStepRunEvent(stepRun.id, event)
            .catch((error) =>
              console.error('workflow: failed to persist question event', error),
            );
        } else if (event.type === 'question_answered') {
          deps.onQuestionStatus?.('running');
          // Симметрично вопросу: ответ тоже должен попасть в персистентный
          // step_runs.events — для полноты картины при перезагрузке.
          void deps.store
            .appendStepRunEvent(stepRun.id, event)
            .catch((error) =>
              console.error(
                'workflow: failed to persist question_answered event',
                error,
              ),
            );
        }
      },
    };

    // Snapshot the report files: an untouched file is the previous step's verdict.
    const reportsBefore = await stepReportMtimes(workspaceHostDir);

    // Детерминированная развилка топологии resolve: refine рекомендует
    // single|room|stages, движок распоряжается (см. planExecutionMode) с учётом
    // `worker_count` задачи: room с потолком < 2 исполнителей смысла не имеет.
    const topology =
      step === 'resolve'
        ? planExecutionMode(refinedExecution, maxExecutors)
        : 'single';
    const onWorkerStart = (
      item: RoomWorkItem,
      total: number,
      agent: RoomAgentInfo,
    ): void =>
      deps.sse.publish(
        streamEvent(
          issue.id,
          iteration.id,
          stepRun.id,
          'system',
          `worker ${item.index + 1}/${total}: ${item.task}`,
          agent.id,
        ),
      );

    let result: StepExecutionResult;
    try {
      const roomOptions = {
        ...runOptions,
        stepRunId: stepRun.id,
        onWorkerStart,
        hostWorkspaceDir: workspaceHostDir,
      };
      const resolveInput = {
        containerName,
        execution: refinedExecution as ExecutionPlan,
        maxExecutors,
        ...promptContext,
        refinedPlan,
      };
      let agentRun: Promise<StepExecutionResult>;
      if (topology === 'room') {
        agentRun = runRoomResolve(deps.pi, resolveInput, roomOptions);
      } else if (topology === 'stages') {
        agentRun = runStagedResolve(deps.pi, resolveInput, roomOptions);
      } else {
        agentRun = withAgentTimeout(
          deps.pi.run(
            containerName,
            buildStepPrompt({ step, ...promptContext, refinedPlan }),
            { ...runOptions, stepRunId: stepRun.id },
          ),
          agentTimeoutMs,
          `${step} agent`,
        );
      }
      result = await withAgentStallGuard(agentRun, {
        stallMs: agentStallMs,
        label: `${step} agent`,
        activity: () => stepActivity,
      });
    } catch (error) {
      // Падение/зависание pi-агента (spawn ENOENT, timeout, child error,
      // любой reject). Причину не глотаем: пишем в stderr step_output и в
      // console.error.
      const message = error instanceof Error ? error.message : String(error);
      console.error(
        `workflow: pi agent for step '${step}' failed or timed out`,
        error,
      );
      await deps.store.updateStepRun(stepRun.id, { status: 'failed' });
      await deps.store.createStepOutput({
        stepRunId: stepRun.id,
        report: JSON.stringify({
          status: 'fail',
          summary:
            step === 'resolve'
              ? 'resolve agent failed/hung'
              : `${step} agent failed/hung`,
        }),
        stdout: '',
        stderr: message,
        events: [],
        stats: null,
      });
      deps.sse.publish(
        stepStatusEvent(issue.id, iteration.id, stepRun.id, 'failed'),
      );

      // Self-retry: refine и resolve самоперезапускаются при техническом сбое
      // (агент краш, таймаут, inference error) с контекстом ошибки.
      const maxSelf = MAX_SELF_RETRIES[step] ?? 0;
      if (SELF_RETRY_STEPS.has(step) && stepRetries < maxSelf) {
        stepRetries += 1;
        attempt += 1;
        feedback = [
          `Previous ${step} attempt CRASHED: ${message}`,
          `(self-retry ${stepRetries}/${maxSelf})`,
          'Fix the crash and continue — do not redo work from scratch if partial results exist.',
        ].join('\n');
        continue;
      }

      void deps.onIterationTerminal?.(buildTerminalOutcome('failed'));
      return { iterationStatus: 'failed', needsInput: false };
    }

    // Отчёт шага — источник истины в рабочей папке задачи. В RPC-режиме
    // `result.report` всегда null, поэтому отдаём приоритет файлу
    // `.issue-step-result.json`, а `result.report` — фолбек для in-memory
    // реализаций (тесты, не-RPC раннеры).
    // Only a report this step wrote counts; a stale one is another step's verdict.
    const source = await readStepReportFile(workspaceHostDir, reportsBefore);
    const report = source?.report ?? result.report;
    const contractPath = join(workspaceHostDir, STEP_REPORT_FILE);
    if (source !== null && source.path !== contractPath) {
      const message = `step result written to ${source.path} instead of ${contractPath} (the contract path)`;
      console.error(`workflow: step '${step}' (${stepRun.id}): ${message}`);
      deps.sse.publish(
        streamEvent(issue.id, iteration.id, stepRun.id, 'system', message),
      );
    } else if (source === null && result.report === null) {
      const message = `no fresh ${STEP_REPORT_FILE} from this step — status comes from the agent exit code (${result.exitCode})`;
      console.error(`workflow: step '${step}' (${stepRun.id}): ${message}`);
      deps.sse.publish(
        streamEvent(issue.id, iteration.id, stepRun.id, 'system', message),
      );
    }

    // abort — отдельный терминальный статус шага (не failed): никакого retry
    // и следующих шагов, вся итерация переводится в cancelled.
    const status: StepRunStatus = result.aborted
      ? 'aborted'
      : stepRunStatusFromResult(result.exitCode, report);
    await deps.store.updateStepRun(stepRun.id, { status });
    const screenshotsDir = await screenshotsDirOf(workspaceHostDir);

    // Фаза 4: успешный pr-шаг публикует результат — commit/push + MR — для
    // тех репозиториев, где запрошен MR (per-repo create_mr). Публикуем ДО
    // записи output-строки, чтобы ошибка публикации вошла в отчёт и события
    // шага: иначе зелёный шаг без ветки/MR вводит пользователя в заблуждение.
    let prPublish: PrPublishOutcome | null = null;
    if (step === 'pr' && status === 'success' && repoWorkspaces.length > 0) {
      try {
        prPublish = await publishPrResult(
          deps,
          input,
          repoWorkspaces,
          report?.title || input.issue.title,
          report?.description || report?.summary || '',
          stepRun.id,
          report?.merge_requests,
        );
      } catch (error) {
        // publishPrResult не бросает на per-repo ошибках, но подстрахуемся:
        // неожиданный reject тоже должен стать видимым, а не пропасть.
        const message = error instanceof Error ? error.message : String(error);
        console.error('publishPrResult failed', error);
        prPublish = { artifacts: [], errors: [{ repositoryUrl: '', message }] };
      }
    }

    // pr-шаг успешен, но ни один подготовленный репозиторий не отмечен для
    // MR (create_mr = false у всех): публикация молча ничего не делает. Это
    // законный сценарий «результат остаётся файлами», но пользователь,
    // выбравший шаг pr, ожидает MR — поэтому шлём явное предупреждение, а не
    // оставляем зелёный шаг без ветки/MR (репорт бага: «шаг success, MR нет»).
    const prNoTargetNotice: SessionEvent | null =
      step === 'pr' &&
      status === 'success' &&
      repoWorkspaces.length > 0 &&
      !repoWorkspaces.some((workspace) =>
        input.repositories.some(
          (repo) =>
            repo.repository_url === workspace.repoUrl &&
            (repo.create_mr ?? false),
        ),
      )
        ? {
            type: 'notice',
            level: 'warning',
            message:
              'pr-шаг: ни один репозиторий не отмечен для MR (create_mr = false у всех) — ветки и MR не создавались, результат остался файлами в рабочей папке.',
          }
        : null;

    const prErrors = prPublish?.errors ?? [];
    const prErrorMessage = formatPrPublishErrors(prErrors);
    const outputEvents: SessionEvent[] = [
      ...(result.events ?? []),
      ...(prNoTargetNotice ? [prNoTargetNotice] : []),
      ...prErrors.map(
        (error): SessionEvent => ({
          type: 'notice',
          level: 'error',
          message: `Публикация MR/ветки не удалась — ${error.message}`,
        }),
      ),
    ];
    // `pr_error` кладём поверх отчёта шага: фронт рисует по нему баннер даже
    // после перезагрузки (report берётся из персистентной output-строки).
    const persistedReport: StepReport | null =
      prErrors.length > 0
        ? {
            ...(report ?? { status: 'pass' as const, summary: '' }),
            pr_error: prErrorMessage,
          }
        : report;

    await deps.store.createStepOutput({
      stepRunId: stepRun.id,
      report: persistedReport ? JSON.stringify(persistedReport) : '',
      ...(screenshotsDir ? { screenshotsDir } : {}),
      stdout: result.stdout,
      stderr: result.stderr,
      events: outputEvents,
      stats: result.stats ?? null,
    });
    deps.sse.publish(stepStatusEvent(issue.id, iteration.id, stepRun.id, status));
    if (prNoTargetNotice) {
      deps.sse.publish(
        stepEvent(issue.id, iteration.id, stepRun.id, prNoTargetNotice),
      );
    }

    // Публикация провалилась — шаг реально отработал, но результат не
    // опубликован. Красим чип в failed (персистентно) и шлём причину в SSE,
    // чтобы пользователь сразу видел проблему. Итерация при этом остаётся
    // completed: `status` для nextStepDecision — success, как и раньше.
    if (prErrors.length > 0) {
      await deps.store.updateStepRun(stepRun.id, { status: 'failed' });
      deps.sse.publish(
        stepStatusEvent(issue.id, iteration.id, stepRun.id, 'failed'),
      );
      for (const error of prErrors) {
        deps.sse.publish(
          stepEvent(issue.id, iteration.id, stepRun.id, {
            type: 'notice',
            level: 'error',
            message: `Публикация MR/ветки не удалась — ${error.message}`,
          }),
        );
      }
    }

    // Успешный refine — единственный источник рекомендации о топологии
    // resolve: план для промпта и execution для развилки single/room.
    if (step === 'refine' && status === 'success') {
      refinedPlan = report?.summary || null;
      refinedExecution = report?.execution ?? null;
    }

    if (status === 'aborted') {
      void deps.onIterationTerminal?.(buildTerminalOutcome('cancelled'));
      return { iterationStatus: 'cancelled', needsInput: false };
    }

    if (status === 'needs_input') {
      return { iterationStatus: 'failed', needsInput: true };
    }

    // Self-retry для refine/resolve при логическом падении (шаг завершился,
    // но со статусом failed). Контекст: report + stderr предыдущей попытки.
    if (status === 'failed' && SELF_RETRY_STEPS.has(step)) {
      const maxSelf = MAX_SELF_RETRIES[step] ?? 0;
      if (stepRetries < maxSelf) {
        stepRetries += 1;
        attempt += 1;
        const parts = [`Previous ${step} attempt FAILED.`];
        if (report?.summary) parts.push(`Report: ${report.summary}`);
        if (result.stderr) {
          parts.push(`Stderr (last 2000 chars): ${result.stderr.slice(-2000)}`);
        }
        parts.push(
          `(self-retry ${stepRetries}/${maxSelf})`,
          'Fix the issues and continue — use any partial results from the previous attempt.',
        );
        feedback = parts.join('\n');
        continue;
      }
    }

    const decision = nextStepDecision({
      steps,
      currentStep: step,
      result: status === 'success' ? 'success' : 'failed',
      attempt: pipelineAttempt,
      maxAttempts: MAX_ATTEMPTS,
    });

    switch (decision.kind) {
      case 'advance':
        if (decision.iterationCompleted) {
          void deps.onIterationTerminal?.(buildTerminalOutcome('completed'));
          return { iterationStatus: 'completed', needsInput: false };
        }
        stepIndex += 1;
        stepRetries = 0;
        break;
      case 'retry_resolve':
        feedback = report?.summary ?? null;
        attempt = decision.attempt;
        pipelineAttempt = decision.attempt;
        stepIndex = steps.indexOf('resolve');
        stepRetries = 0;
        break;
      case 'needs_input':
        return { iterationStatus: 'failed', needsInput: true };
      case 'iteration_failed':
        void deps.onIterationTerminal?.(buildTerminalOutcome('failed'));
        return { iterationStatus: 'failed', needsInput: false };
    }
  }

  // Пустой конвейер: запускать нечего — итерация тривиально завершена.
  void deps.onIterationTerminal?.(buildTerminalOutcome('completed'));
  return { iterationStatus: 'completed', needsInput: false };
}

/** Артефакт результата MR для снапшота итерации (result.json). */
export interface MrResultArtifact {
  repositoryUrl: string;
  mrUrl: string;
  title: string;
  description: string;
}

/**
 * Имя feature-ветки для публикации результата задачи.
 *
 * Защищённые base-ветки (`master`/`main`) отвергают прямой push
 * (pre-receive hook declined), поэтому результат всегда публикуется в
 * отдельную ветку, а MR открывается из неё в base. UUID в суффиксе
 * гарантирует уникальность между задачами; в пределах одной задачи
 * (все итерации) ветка одна и та же — новый push обновляет
 * существующий MR, а не создаёт дубликат.
 */
export function featureBranchName(
  issueTitle: string,
  issueId: string,
): string {
  // Jira-ключ из заголовка (например "KOS-55424: Logout lands on login")
  const jiraMatch = /([A-Z]+-\d+)/.exec(issueTitle);
  const jiraKey = jiraMatch ? jiraMatch[1].toLowerCase() : null;

  // Slug из заголовка без Jira-ключа и спецсимволов
  const slug = issueTitle
    .replace(/([A-Z]+-\d+):?\s*/, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 50)
    .replace(/-+$/, '');

  const prefix = jiraKey
    ? `feature/${jiraKey}-${slug}`
    : `feature/${slug || 'changes'}`;

  // Уникальный короткий суффикс (последние 6 символов issueId) —
  // стабилен для всех итераций одной задачи, уникален между задачами.
  return `${prefix}-${issueId.slice(-6)}`;
}

/** Итог публикации: созданные MR и ошибки репозиториев, где она сорвалась. */
export interface PrPublishOutcome {
  artifacts: MrResultArtifact[];
  errors: PrPublishError[];
}

/**
 * Успешный pr-шаг: для каждого репозитория commit/push, затем создание MR.
 * Возвращает созданные MR и ошибки публикации (commit/push/MR) — ошибку НЕ
 * глотаем и НЕ роняем итерацию ей. На первой ошибке публикация прекращается
 * (частично созданные MR сохраняются в `artifacts`).
 * Best-effort пишет `result.json` в корень рабочей папки задачи.
 * Вызывается только при `step === 'pr' && status === 'success'`.
 */
async function publishPrResult(
  deps: WorkflowDeps,
  input: RunIterationInput,
  repoWorkspaces: GitPrepareResult['repoWorkspaces'],
  title: string,
  description: string,
  stepRunId: string,
  reportMrEntries?: readonly {
    repository_url: string;
    title: string;
    description: string;
  }[],
): Promise<PrPublishOutcome> {
  const baseBranchByUrl = new Map(
    input.repositories.map((repo) => [repo.repository_url, repo.base_branch]),
  );
  const createMrByUrl = new Map(
    input.repositories.map((repo) => [
      repo.repository_url,
      repo.create_mr ?? false,
    ]),
  );

  const artifacts: MrResultArtifact[] = [];
  const errors: PrPublishError[] = [];

  // Per-repo title/description из отчёта агента pr: если агент написал
  // отдельное описание для конкретного репозитория — используем его;
  // иначе — общие title/description (обратная совместимость).
  const perRepoMap = new Map<string, { title: string; description: string }>();
  if (reportMrEntries) {
    for (const entry of reportMrEntries) {
      if (entry.repository_url && entry.title) {
        perRepoMap.set(entry.repository_url, entry);
      }
    }
  }

  // Нет репозиториев — нечего коммитить/пушить и не для чего создавать MR.
  if (repoWorkspaces.length === 0) {
    return { artifacts, errors };
  }

  for (const workspace of repoWorkspaces) {
    // MR только для репозиториев, где он запрошен (per-repo create_mr).
    if (!createMrByUrl.get(workspace.repoUrl)) {
      continue;
    }
    // Per-repo title/description из отчёта агента: если агент написал
    // отдельный текст для этого репо — берём его, иначе общий.
    const repoOverride = perRepoMap.get(workspace.repoUrl);
    const repoTitle = repoOverride?.title || title;
    const repoDescription = repoOverride?.description || description;
    // Фаза нужна для понятного сообщения об ошибке: commit/push и создание MR
    // падают по разным причинам (push rejected vs сеть/токен/конфликт веток).
    let phase = 'commit/push';
    try {
      // Публикуем в feature-ветку, а не в base (`workspace.branch`): base
      // защищена от прямого push. `commitAndPush` делает `checkout -B`, т.е.
      // создаёт ветку от текущего HEAD; она же — head создаваемого MR.
      // `squashBase` сквошит все коммиты в один — MR всегда = 1 commit.
      const baseBranch =
        baseBranchByUrl.get(workspace.repoUrl) ?? workspace.branch;
      const featureBranch = featureBranchName(
        input.issue.title,
        input.issue.id,
      );
      const commit = await deps.git.commitAndPush({
        repoPath: workspace.path,
        branchName: featureBranch,
        commitMessage: `feat: ${input.issue.title}`,
        squashBase: `origin/${baseBranch}`,
      });
      deps.sse.publish(
        streamEvent(
          input.issue.id,
          input.iteration.id,
          stepRunId,
          'system',
          `committed ${commit.branchName}`,
        ),
      );

      phase = 'MR';
      const source = detectGitHost(workspace.repoUrl);

      // Сначала проверяем, нет ли уже открытого MR из этой ветки в base.
      // Если есть — push его обновит, новый создавать не нужно.
      const existing = await deps.mr.findOpenMr({
        repositoryUrl: workspace.repoUrl,
        baseBranch:
          baseBranchByUrl.get(workspace.repoUrl) ?? workspace.branch,
        headBranch: featureBranch,
        token: input.mrToken ?? '',
        source,
      });

      let mrResult: { mrUrl: string; id: string };
      if (existing) {
        mrResult = existing;
        // Пуш обновляет ДИФФ, но не текст. А payload этого диффа — вся задача:
        // ветка стабильна по issueId, а `commitAndPush` делает `reset --soft
        // origin/<base>`, сквошируя все итерации в один коммит. Значит и
        // description должен описывать задачу целиком, а не ту итерацию, на
        // которой MR создавался, — иначе он остаётся текстом первой итерации
        // при растущем содержимом. Best-effort: сбой обновления текста не
        // валит публикацию и не блокирует остальные репозитории (код уже
        // запушен, MR открыт — это успех публикации).
        try {
          await deps.mr.updateMr({
            repositoryUrl: workspace.repoUrl,
            mrId: existing.id,
            title: repoTitle,
            description: repoDescription,
            token: input.mrToken ?? '',
            source,
          });
          deps.sse.publish(
            streamEvent(
              input.issue.id,
              input.iteration.id,
              stepRunId,
              'mr',
              `заголовок и описание MR обновлены — ${existing.mrUrl}`,
            ),
          );
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          deps.sse.publish(
            streamEvent(
              input.issue.id,
              input.iteration.id,
              stepRunId,
              'mr',
              `MR обновлён кодом, но текст обновить не удалось: ${message}`,
            ),
          );
        }
        deps.sse.publish(
          streamEvent(
            input.issue.id,
            input.iteration.id,
            stepRunId,
            'system',
            `MR уже существует: ${existing.mrUrl} (новый push обновляет его)`,
          ),
        );
      } else {
        mrResult = await deps.mr.createMr({
          repositoryUrl: workspace.repoUrl,
          baseBranch:
            baseBranchByUrl.get(workspace.repoUrl) ?? workspace.branch,
          headBranch: featureBranch,
          title: repoTitle,
          description: repoDescription,
          token: input.mrToken ?? '',
          source,
        });
      }

      artifacts.push({
        repositoryUrl: workspace.repoUrl,
        mrUrl: mrResult.mrUrl,
        title: repoTitle,
        description: repoDescription,
      });
      deps.sse.publish(
        streamEvent(
          input.issue.id,
          input.iteration.id,
          stepRunId,
          'mr',
          mrResult.mrUrl,
        ),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // 409 DuplicatePullRequestException разрешается внутри MR-клиента:
      // `createMr` сам находит существующий PR и возвращает его canonical
      // web-URL. Движок web-URL не конструирует: прошлая такая склейка
      // (`/scm/<p>/<repo>` → `/projects/<p>/repos/<repo>`) съедала
      // project-ключ, и в result.json сохранялась ссылка, по которой
      // комментарии ревью нельзя получить.
      errors.push({
        repositoryUrl: workspace.repoUrl,
        message: `${workspace.repoUrl} — ${phase}: ${message}`,
      });
      // Одна ошибка почти всегда означает общую проблему (токен/сеть),
      // поэтому остальные репозитории не публикуем: частичный результат
      // честно виден в artifacts/errors.
      break;
    }
  }

  // Best-effort: результат pr-шага как обычный артефакт для снапшота итерации.
  if (artifacts.length > 0) {
    try {
      const dir = workspaceHostDirFor(
        deps.workspaceRoot ?? DEFAULT_WORKSPACE_ROOT,
        input.issue.id,
      );
      await mkdir(dir, { recursive: true });
      await writeFile(
        join(dir, 'result.json'),
        JSON.stringify(
          {
            merge_requests: artifacts.map((a) => ({
              repository_url: a.repositoryUrl,
              url: a.mrUrl,
              title: a.title,
              message: a.description,
            })),
          },
          null,
          2,
        ),
      );
    } catch {
      // Отсутствие файла не должно ронять итерацию.
    }
  }

  return { artifacts, errors };
}
