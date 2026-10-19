import type {
  DesiredResult,
  Iteration,
  PipelineStep,
  StepModels,
  StepRunWithLog,
  StepThinkingLevels,
  TaskStatus,
  ThinkingLevel,
} from '@issue-resolver/shared';
import {
  extractIssueKeyFromUrl,
  extractRepoNameFromUrl,
} from '@issue-resolver/shared';
import { and, eq } from 'drizzle-orm';
import { spawn } from 'node:child_process';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { copyFile, mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Db } from '../db/client';
import { allocateDevPort, releaseIssueDevPorts } from '../port-allocator';
import { listAttachableRelPaths } from '../db/issue-files.repo';
import {
  getRepositoryByUrl,
  updateRepositoryRunInstructions,
} from '../db/repositories.repo';
import { issues, iterations } from '../db/schema';
import {
  appendStepRunEvent,
  createStepOutput,
  createStepRun,
  listStepRunsWithLog,
  updateStepRun,
} from '../db/step-runs.repo';
import type { ContainerController } from '../docker/controller';
import type { GitPrepareResult, GitService } from '../git/service';
import type { PiRunner } from '../pi/runner';
import type { StepSessionRegistry } from '../pi/session-registry';
import type { MrClient } from '../pr/mr';
import type { SseHub } from '../sse/hub';
import type {
  BootstrapperFactory,
  RunInstructionsPort,
  RunIterationResult,
  StepRunStore,
} from '../workflow/engine';
import { prepareWorkspace, runIteration } from '../workflow/engine';
import type { WorkspaceProgress } from '../workflow/engine';
import {
  DEFAULT_WORKSPACE_ROOT,
  iterationResultDirFor,
  resultArtifactFor,
  workspaceContainerDirFor,
  workspaceHostDirFor,
} from '../workspace/paths';

/** Имя скрипта dev-сервера, который создаёт bootstrapper в корне репозитория. */
const DEV_SERVER_SCRIPT = 'DEV_SERVER.sh';

/** Инфраструктурные файлы задачи в корне репозитория (пишет bootstrapper). */
const INFRA_FILES = ['RUN_INSTRUCTIONS.md', DEV_SERVER_SCRIPT];

/**
 * Прячет инфраструктурные файлы задачи от git: публикация (`pr`) делает
 * `git add -A`, поэтому без exclude `RUN_INSTRUCTIONS.md`/`DEV_SERVER.sh`
 * уехали бы в MR. Пишем в локальный `.git/info/exclude` — он сам в репозиторий
 * не попадает. Идемпотентно и best-effort: сбой не роняет подготовку.
 */
function excludeInfraFiles(workspaceDir: string, repoName: string): void {
  const excludePath = join(workspaceDir, repoName, '.git', 'info', 'exclude');
  try {
    const current = existsSync(excludePath)
      ? readFileSync(excludePath, 'utf8')
      : '';
    const known = new Set(current.split('\n'));
    const missing = INFRA_FILES.filter((name) => !known.has(`/${name}`));
    if (missing.length === 0) return;
    mkdirSync(dirname(excludePath), { recursive: true });
    appendFileSync(
      excludePath,
      `${missing.map((name) => `/${name}`).join('\n')}\n`,
    );
  } catch (error) {
    console.error('failed to exclude infra files from git', error);
  }
}

/**
 * Поднимает `DEV_SERVER.sh` репозитория в фоне (detached, без stdio). Скрипт
 * создаёт bootstrapper и уже содержит выделенный порт. Нет файла/сбой spawn →
 * null (подготовка из-за этого не падает).
 */
function startRepoDevServer(
  workspaceDir: string,
  repoName: string,
): number | null {
  const repoDir = join(workspaceDir, repoName);
  const scriptPath = join(repoDir, DEV_SERVER_SCRIPT);
  if (!existsSync(scriptPath)) return null;
  try {
    const child = spawn(scriptPath, [], {
      cwd: repoDir,
      detached: true,
      stdio: 'ignore',
    });
    // Ошибка exec (нет прав/шебанга) приходит асинхронно: без обработчика
    // она уронила бы процесс. Сервер просто не поднимается.
    child.on('error', (error) => {
      console.error('failed to start DEV_SERVER.sh', error);
    });
    child.unref();
    return child.pid ?? null;
  } catch (error) {
    console.error('failed to spawn DEV_SERVER.sh', error);
    return null;
  }
}

/**
 * Гасит процесс dev-сервера: SIGTERM его группе → 500 мс → SIGKILL, если жив.
 * Ошибки kill игнорируются (процесс мог уже завершиться).
 */
async function stopDevServerProcess(pid: number): Promise<void> {
  const signal = (sig: NodeJS.Signals): void => {
    try {
      process.kill(-pid, sig);
    } catch {
      try {
        process.kill(pid, sig);
      } catch {
        // Процесс уже мёртв — это нормально.
      }
    }
  };

  signal('SIGTERM');
  await new Promise((resolve) => setTimeout(resolve, 500));
  signal('SIGKILL');
}

/** Порты, нужные сервису прогона итерации (совпадают с WorkflowDeps без store). */
export interface IterationRunDeps {
  container: ContainerController;
  git: GitService;
  pi: PiRunner;
  sse: SseHub;
  mr: MrClient;
  /** Реестр живых pi-сессий для steer/abort. */
  control: StepSessionRegistry;
  /** Локальный режим без Docker. */
  local?: boolean;
  /** Model для агента-анализатора (подготовка рабочей папки). */
  bootstrapperModel?: string;
  /**
   * Таймаут одного прогона агента-анализатора (мс). Не задан — дефолт pi/раннера.
   */
  bootstrapperTimeoutMs?: number;
  /** Переопределение фабрики анализатора (тесты/особый wiring). */
  bootstrapperFactory?: BootstrapperFactory;
  /** Корень host-папок задач; по умолчанию `/workspaces`. */
  workspaceRoot?: string;
  /** Токен для MR/PR API (создание и чтение комментариев). */
  mrToken?: string;
}

export interface RunIssueIterationInput {
  issue: {
    id: string;
    title: string;
    pipelineSteps: PipelineStep[];
    /** Описание задачи (additional_context). */
    description?: string;
    /** Желаемый результат задачи: 'md' (report.md) или 'html' (report.html). */
    desiredResult?: DesiredResult;
    jiraIssueUrl?: string | null;
  };
  iteration: {
    id: string;
    issueId: string;
    number: number;
    context: string;
    steps: PipelineStep[];
    reviewContext?: string;
    isReviewNeed?: boolean;
  };
  repositories: {
    repository_url: string;
    base_branch: string;
    /** Создавать ли MR/PR для этого репозитория (per-repo). */
    create_mr?: boolean;
    /** false — репозиторий клонируется, но install/анализ запуска пропускаются. */
    bootstrap_enabled?: boolean;
  }[];
  /** Готовые репо-воркспейсы (пути + ветки) после clone/bootstrap/install. */
  repoWorkspaces: GitPrepareResult['repoWorkspaces'];
  /** Общая модель-фолбек для всех шагов (обратная совместимость). */
  model?: string;
  /** Пер-шаговые модели: `step_models[step]` переопределяет `model`. */
  step_models?: StepModels;
  /** Общий уровень размышления-фолбек для всех шагов. */
  thinking_level?: ThinkingLevel;
  /** Пер-шаговые уровни размышления; приоритет над `thinking_level`. */
  step_thinking_levels?: StepThinkingLevels;
  mrToken?: string;
}

/** Репозиторий step-runs как порт движка (сигнатуры уже совпадают). */
function dbStepRunStore(db: Db): StepRunStore {
  return {
    createStepRun: (input) => createStepRun(db, input),
    updateStepRun: (id, patch) => updateStepRun(db, id, patch),
    appendStepRunEvent: (id, event) => appendStepRunEvent(db, id, event),
    createStepOutput: (input) => createStepOutput(db, input),
  };
}

/** Порт `run_instructions*` поверх таблицы `repositories`. */
function dbRunInstructionsStore(db: Db): RunInstructionsPort {
  return {
    getStatus: (url) => getRepositoryByUrl(db, url)?.runInstructionsStatus,
    getInstructions: (url) => getRepositoryByUrl(db, url)?.runInstructions ?? null,
    saveGenerated: (url, instructions) =>
      updateRepositoryRunInstructions(db, url, {
        instructions,
        status: 'generated',
      }),
    saveFailed: (url) =>
      updateRepositoryRunInstructions(db, url, {
        instructions: null,
        status: 'failed',
      }),
  };
}

/**
 * Текст задачи из Jira для промпта — читается из workspace-файла
 * (записан при создании задачи). Агенты НЕ обращаются к Jira API.
 * При отсутствии файла или ошибке — null.
 */
async function fetchJiraText(
  workspaceRoot: string,
  issueId: string,
  jiraIssueUrl: string | null,
): Promise<string | null> {
  if (!jiraIssueUrl) return null;
  const key = extractIssueKeyFromUrl(jiraIssueUrl);
  if (!key) return null;
  const wsDir = workspaceHostDirFor(workspaceRoot, issueId);
  const mdPath = join(wsDir, 'jira', `${key}.md`);
  try {
    return await readFile(mdPath, 'utf8');
  } catch {
    return null;
  }
}

/** Максимум символов документа результата в промпте предыдущего итога. */
const MAX_PREVIOUS_OUTCOME_CHARS = 4000;

interface PreviousResolveSummary {
  status: string;
  summary: string;
}

/** status+summary из report resolve-шага; битый/пустой JSON деградирует до null. */
function parseResolveReport(raw: string | null): PreviousResolveSummary | null {
  if (!raw) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') {
      return null;
    }
    const report = parsed as { status?: unknown; summary?: unknown };
    return {
      status: typeof report.status === 'string' ? report.status : 'unknown',
      summary: typeof report.summary === 'string' ? report.summary : '',
    };
  } catch {
    return null;
  }
}

/**
 * Документ результата итерации из host-папки задачи: report.md (md) или
 * report.html (html). Отсутствие/ошибка чтения — null.
 */
async function readResultDocument(
  workspaceRoot: string,
  issueId: string,
  desiredResult: DesiredResult | undefined,
): Promise<string | null> {
  if (desiredResult !== 'md' && desiredResult !== 'html') {
    return null;
  }
  const filename = desiredResult === 'md' ? 'report.md' : 'report.html';
  const path = join(workspaceHostDirFor(workspaceRoot, issueId), filename);
  try {
    return await readFile(path, 'utf8');
  } catch {
    return null;
  }
}

/**
 * Снапшот результата успешно завершённой итерации: копирует артефакт
 * (report.md/html или result.json) в
 * `<workspaceRoot>/<issueId>/.iteration-results/<iterationId>`.
 * Best-effort: нет исходного файла — нет снапшота, без падения.
 */
async function snapshotIterationResult(
  workspaceRoot: string,
  issueId: string,
  iterationId: string,
  desiredResult: DesiredResult | undefined,
): Promise<void> {
  const artifact = resultArtifactFor(desiredResult);
  if (!artifact) {
    return;
  }
  const source = join(
    workspaceHostDirFor(workspaceRoot, issueId),
    artifact.filename,
  );
  const targetDir = iterationResultDirFor(workspaceRoot, issueId, iterationId);
  try {
    await mkdir(targetDir, { recursive: true });
    await copyFile(source, join(targetDir, artifact.filename));
  } catch {
    // best-effort снапшот: отсутствие/ошибка копирования не роняет итерацию.
  }
}

/**
 * Итог шага в человекочитаемом отчёте: успех → `ok`, явный таймаут →
 * `timeout`, иначе `fail`. Таймаут отличаем по тексту ошибки/отчёта, потому что
 * у `StepRunStatus` нет отдельного статуса `timeout` (движок пишет `failed`).
 */
function stepOutcome(run: StepRunWithLog): 'ok' | 'fail' | 'timeout' {
  if (run.status === 'success') {
    return 'ok';
  }
  const haystack = `${run.stderr}\n${run.report ?? ''}`.toLowerCase();
  if (haystack.includes('timeout') || haystack.includes('timed out')) {
    return 'timeout';
  }
  return 'fail';
}

/**
 * Рендер markdown-отчёта итерации для `<workspaceDir>/report-<n>.md`: заголовок
 * задачи/итерации, статус и даты плюс секция на каждый step_run с выводом.
 */
export function renderIterationReport(params: {
  title: string;
  number: number;
  status: string;
  startedAt: string;
  finishedAt: string;
  runs: StepRunWithLog[];
}): string {
  const { title, number, status, startedAt, finishedAt, runs } = params;
  const lines: string[] = [
    `# Задача: ${title}`,
    `# Итерация #${number}`,
    '',
    `**Статус:** ${status}`,
    `**Начало:** ${startedAt}`,
    `**Конец:** ${finishedAt}`,
    '',
    '## Шаги',
    '',
  ];

  for (const run of runs) {
    // Секция — только у прогонов, оставивших строку вывода (step_outputs).
    if (run.report === null) {
      continue;
    }
    lines.push(
      `### ${run.step} (попытка ${run.attempt})`,
      '',
      `**Статус:** ${stepOutcome(run)}`,
      '',
      run.report,
      '',
      '---',
      '',
    );
  }

  return lines.join('\n');
}

/**
 * Best-effort запись отчёта итерации в рабочую папку задачи. Любая ошибка
 * (нет прав, диск) только логируется — отчёт не должен ронять итерацию.
 */
async function writeIterationReport(
  db: Db,
  deps: IterationRunDeps,
  input: RunIssueIterationInput,
  status: TaskStatus,
): Promise<void> {
  try {
    const workspaceRoot = deps.workspaceRoot ?? DEFAULT_WORKSPACE_ROOT;
    const workspaceHostDir = workspaceHostDirFor(workspaceRoot, input.issue.id);
    const runs = await listStepRunsWithLog(db, input.iteration.id);
    const row = db
      .select()
      .from(iterations)
      .where(eq(iterations.id, input.iteration.id))
      .get();
    const content = renderIterationReport({
      title: input.issue.title,
      number: input.iteration.number,
      status,
      startedAt: row?.created_at ?? '',
      finishedAt: row?.updated_at ?? new Date().toISOString(),
      runs,
    });
    mkdirSync(workspaceHostDir, { recursive: true });
    writeFileSync(
      join(workspaceHostDir, `report-${input.iteration.number}.md`),
      content,
      'utf8',
    );
  } catch (error) {
    console.error('failed to write iteration report', error);
  }
}

/** Пометка о документе результата, когда desired_result не задан. */
function documentPlaceholder(
  desiredResult: DesiredResult | undefined,
): string {
  if (desiredResult === 'md' || desiredResult === 'html') {
    return '(result document not found)';
  }
  return '(no result document for this desired result)';
}

/** Композиция блока previousOutcome для промпта (см. prompts.buildStepPrompt). */
function composePreviousOutcome(
  previousNumber: number,
  report: PreviousResolveSummary | null,
  document: string | null,
  desiredResult: DesiredResult | undefined,
): string {
  const status = report?.status ?? 'unknown';
  const summary = report?.summary.trim() || '(no summary)';
  const documentNote =
    document !== null
      ? document.slice(0, MAX_PREVIOUS_OUTCOME_CHARS)
      : documentPlaceholder(desiredResult);

  return [
    `Previous iteration #${previousNumber} (status ${status}): ${summary}.`,
    'Result document:',
    documentNote,
  ].join('\n');
}

/**
 * Итог предыдущей итерации для итерации `number > 1`: отчёт resolve-шага
 * (status+summary) плюс документ желаемого результата из воркспейса. Для
 * итерации №1 (или если предыдущей нет) — undefined.
 */
async function buildPreviousOutcome(
  db: Db,
  deps: IterationRunDeps,
  input: RunIssueIterationInput,
): Promise<string | undefined> {
  const currentNumber = input.iteration.number;
  if (currentNumber <= 1) {
    return undefined;
  }

  const previous = db
    .select()
    .from(iterations)
    .where(
      and(
        eq(iterations.issue_id, input.iteration.issueId),
        eq(iterations.number, currentNumber - 1),
      ),
    )
    .get();
  if (!previous) {
    return undefined;
  }

  const runs = await listStepRunsWithLog(db, previous.id);
  const resolveRun = runs.find((run) => run.step === 'resolve');
  const report = parseResolveReport(resolveRun?.report ?? null);
  const document = await readResultDocument(
    deps.workspaceRoot ?? DEFAULT_WORKSPACE_ROOT,
    input.issue.id,
    input.issue.desiredResult,
  );

  return composePreviousOutcome(
    currentNumber - 1,
    report,
    document,
    input.issue.desiredResult,
  );
}

/** Зависимости разовой подготовки рабочей папки задачи. */
export interface PrepareIssueWorkspaceDeps {
  container: ContainerController;
  git: GitService;
  sse: SseHub;
  /** Локальный режим без Docker. */
  local?: boolean;
  /** Переопределение фабрики анализатора (тесты/особый wiring). */
  bootstrapperFactory?: BootstrapperFactory;
  /** Модель агента-анализатора (разовая подготовка рабочей папки). */
  bootstrapperModel?: string;
  /** Таймаут анализа (мс); без него зависший `pi` держит задачу в `preparing`. */
  bootstrapperTimeoutMs?: number;
  /** Корень host-папок задач; по умолчанию `/workspaces`. */
  workspaceRoot?: string;
}

/**
 * Разовая подготовка рабочей папки задачи ДО итераций: clone репозиториев и
 * детерминированный install ОДИН раз. Повтор (workspace уже склонирован) не
 * переклонирует и не переинсталлирует — итерации работают с одним кодом.
 *
 * Прогресс и ошибки публикуются в SSE под переданными issueId/iterationId.
 * Неудача подготовки помечает итерацию и задачу `failed` и пробрасывается
 * вызывающему (route handler); `runIssueIteration` к этому моменту не
 * запускается.
 */
export async function prepareIssueWorkspace(
  db: Db,
  deps: PrepareIssueWorkspaceDeps,
  input: {
    issueId: string;
    iterationId: string;
    repositories: Array<{
      repository_url: string;
      base_branch: string;
      /** false — репозиторий клонируется, но install/анализ запуска пропускаются. */
      bootstrap_enabled?: boolean;
    }>;
  },
): Promise<GitPrepareResult['repoWorkspaces']> {
  const repos = input.repositories;
  const workspaceDir = workspaceHostDirFor(
    deps.workspaceRoot ?? DEFAULT_WORKSPACE_ROOT,
    input.issueId,
  );
  const clonesReady =
    repos.length > 0 &&
    repos.every((repo) =>
      existsSync(
        join(workspaceDir, extractRepoNameFromUrl(repo.repository_url), '.git'),
      ),
    );
  const needPrepare = repos.length > 0 && !clonesReady;

  // Клоны уже на месте (или репозиториев нет): пропускаем подготовку.
  if (!needPrepare) {
    const dir = deps.local
      ? workspaceHostDirFor(
          deps.workspaceRoot ?? DEFAULT_WORKSPACE_ROOT,
          input.issueId,
        )
      : workspaceContainerDirFor(input.issueId);
    repos.forEach((repo) =>
      excludeInfraFiles(workspaceDir, extractRepoNameFromUrl(repo.repository_url)),
    );
    return repos.map((repo) => ({
      repoUrl: repo.repository_url,
      path: join(dir, extractRepoNameFromUrl(repo.repository_url)),
      branch: repo.base_branch,
    }));
  }

  // Управляемый dev-сервер: порт выделяем заранее, чтобы bootstrapper вписал
  // его в DEV_SERVER.sh. Сервер поднимаем для первого репозитория с
  // `bootstrap_enabled` (по умолчанию true) и только в real-режиме, когда
  // анализатор действительно создаст скрипт (без фабрики — legacy-путь).
  const devRepo = deps.bootstrapperFactory
    ? repos.find((repo) => repo.bootstrap_enabled !== false)
    : undefined;
  const devServerPort = devRepo
    ? await allocateDevPort(input.issueId)
    : undefined;

  // Подготовка рабочей папки: анализатор `run_instructions` подключается только
  // при явном `deps.bootstrapperFactory` (real-режим); фейковый дефолт анализа не
  // делает — юнит-тесты не тратят прогоны pi на анализ.
  const prepareDeps = {
    container: deps.container,
    git: deps.git,
    workspaceRoot: deps.workspaceRoot,
    local: deps.local,
    bootstrapperModel: deps.bootstrapperModel,
    bootstrapperTimeoutMs: deps.bootstrapperTimeoutMs,
    devServerPort,
    ...(deps.bootstrapperFactory
      ? { bootstrapper: deps.bootstrapperFactory }
      : {}),
    runInstructions: dbRunInstructionsStore(db),
    // Живой вывод агента-анализатора уходит отдельным типом `bootstrap_log`,
    // чтобы фронт отличал его от логов шагов и привязывал к репозиторию.
    onBootstrapStdout: (repo: string, chunk: string): void =>
      deps.sse.publish({
        type: 'bootstrap_log',
        issueId: input.issueId,
        iterationId: input.iterationId,
        stream: 'stdout',
        data: JSON.stringify({ repo, text: chunk, kind: 'stdout' }),
        ts: new Date().toISOString(),
      }),
    onBootstrapStderr: (repo: string, chunk: string): void =>
      deps.sse.publish({
        type: 'bootstrap_log',
        issueId: input.issueId,
        iterationId: input.iterationId,
        stream: 'stderr',
        data: JSON.stringify({ repo, text: chunk, kind: 'stderr' }),
        ts: new Date().toISOString(),
      }),
  };

  // Прогресс разовой подготовки — одним SSE-событием на шаг.
  const publishWorkspaceProgress = (progress: WorkspaceProgress): void => {
    deps.sse.publish({
      type: 'workspace_progress',
      issueId: input.issueId,
      data: JSON.stringify(progress),
      ts: new Date().toISOString(),
    });
  };

  // Пока идёт clone/install, ЗАДАЧА (не итерация) — `preparing`.
  // Итерация остаётся `pending` до старта конвейера в `runIssueIteration`.
  const prepStart = new Date().toISOString();
  db.update(issues)
    .set({ status: 'preparing', updated_at: prepStart })
    .where(eq(issues.id, input.issueId))
    .run();

  try {
    const prepared = await prepareWorkspace(
      prepareDeps,
      { id: input.issueId },
      repos,
      publishWorkspaceProgress,
    );

    // Инфраструктурные файлы bootstrapper'а не должны попадать в MR.
    repos.forEach((repo) =>
      excludeInfraFiles(workspaceDir, extractRepoNameFromUrl(repo.repository_url)),
    );

    // Управляемый dev-сервер: bootstrapper создал DEV_SERVER.sh с выделенным
    // портом — поднимаем его и запоминаем PID. Нет скрипта (анализ пропущен
    // или упал) — порт освобождаем.
    if (devServerPort !== undefined && devRepo) {
      const repoName = extractRepoNameFromUrl(devRepo.repository_url);
      const pid = startRepoDevServer(workspaceDir, repoName);
      if (pid !== null) {
        db.update(issues)
          .set({ dev_server_port: devServerPort, dev_server_pid: pid })
          .where(eq(issues.id, input.issueId))
          .run();
      } else {
        releaseIssueDevPorts(input.issueId);
      }
    }

    return prepared;
  } catch (error) {
    // Порт управляемого dev-сервера при сбое подготовки не остаётся занятым.
    releaseIssueDevPorts(input.issueId);
    // Неудача подготовки (clone/install) — задача терминально `failed`.
    console.error('workspace preparation failed', error);
    const failedAt = new Date().toISOString();
    const message = error instanceof Error ? error.message : String(error);
    db.update(iterations)
      .set({ status: 'failed', updated_at: failedAt })
      .where(eq(iterations.id, input.iterationId))
      .run();
    db.update(issues)
      .set({ status: 'failed', updated_at: failedAt })
      .where(eq(issues.id, input.issueId))
      .run();
    deps.sse.publish({
      type: 'iteration_status',
      issueId: input.issueId,
      iterationId: input.iterationId,
      data: JSON.stringify({
        iterationId: input.iterationId,
        status: 'failed',
        needsInput: false,
        error: message,
      }),
      ts: failedAt,
    });
    throw error;
  }
}

/**
 * Гоняет движок конвейера и доводит результат до БД: статусы итерации/задачи
 * плюс событие iteration_status в SSE.
 */
export async function runIssueIteration(
  db: Db,
  deps: IterationRunDeps,
  input: RunIssueIterationInput,
): Promise<RunIterationResult> {
  const now = new Date().toISOString();

  const iteration: Iteration = {
    id: input.iteration.id,
    issue_id: input.iteration.issueId,
    number: input.iteration.number,
    context: input.iteration.context,
    review_context: input.iteration.reviewContext ?? '',
    is_review_need: input.iteration.isReviewNeed ?? false,
    steps: input.iteration.steps,
    status: 'running',
    created_at: now,
    updated_at: now,
  };

  // Готовые репо-воркспейсы посчитаны разовой подготовкой ДО итераций
  // (`prepareIssueWorkspace`); здесь остаётся только прогон конвейера.
  const repoWorkspaces = input.repoWorkspaces;

  // Перед новой итерацией перезапускаем управляемый dev-сервер: гасим старый
  // PID, освобождаем порт и поднимаем DEV_SERVER.sh заново на новом порту.
  // Делаем это до запуска конвейера, чтобы шаги работали с живым сервером.
  const issueRow = db
    .select()
    .from(issues)
    .where(eq(issues.id, input.issue.id))
    .get();
  if (issueRow?.dev_server_pid) {
    await stopDevServerProcess(issueRow.dev_server_pid);
    releaseIssueDevPorts(input.issue.id);
    db.update(issues)
      .set({ dev_server_port: null, dev_server_pid: null })
      .where(eq(issues.id, input.issue.id))
      .run();

    const devRepo = input.repositories.find(
      (repo) => repo.bootstrap_enabled !== false,
    );
    if (devRepo) {
      const port = await allocateDevPort(input.issue.id);
      const workspaceDir = workspaceHostDirFor(
        deps.workspaceRoot ?? DEFAULT_WORKSPACE_ROOT,
        input.issue.id,
      );
      const pid = startRepoDevServer(
        workspaceDir,
        extractRepoNameFromUrl(devRepo.repository_url),
      );
      if (pid !== null) {
        db.update(issues)
          .set({ dev_server_port: port, dev_server_pid: pid })
          .where(eq(issues.id, input.issue.id))
          .run();
      } else {
        releaseIssueDevPorts(input.issue.id);
      }
    }
  }

  // Итерация и задача переходят в running ещё до прогона конвейера.
  const runningAt = new Date().toISOString();
  db.update(iterations)
    .set({ status: 'running', updated_at: runningAt })
    .where(eq(iterations.id, input.iteration.id))
    .run();
  db.update(issues)
    .set({ status: 'running', updated_at: runningAt })
    .where(eq(issues.id, input.issue.id))
    .run();
  deps.sse.publish({
    type: 'iteration_status',
    issueId: input.issue.id,
    iterationId: input.iteration.id,
    data: JSON.stringify({
      iterationId: input.iteration.id,
      status: 'running',
      needsInput: false,
    }),
    ts: runningAt,
  });

  const jiraText = await fetchJiraText(
    deps.workspaceRoot ?? DEFAULT_WORKSPACE_ROOT,
    input.issue.id,
    input.issue.jiraIssueUrl ?? null,
  );
  const previousOutcome = await buildPreviousOutcome(db, deps, input);
  const attachmentPaths = await listAttachableRelPaths(
    db,
    input.issue.id,
    input.iteration.id,
  );
  // Порт управляемого dev-сервера (перезапущен выше) уходит в промпты шагов:
  // `test` проверяет приложение по этому URL, остальные знают, что сервер жив.
  const devServerPort =
    db
      .select({ port: issues.dev_server_port })
      .from(issues)
      .where(eq(issues.id, input.issue.id))
      .get()?.port ?? null;

  let result: RunIterationResult;
  try {
    result = await runIteration(
      {
        container: deps.container,
        git: deps.git,
        pi: deps.pi,
        sse: deps.sse,
        store: dbStepRunStore(db),
        mr: deps.mr,
        control: deps.control,
        local: deps.local,
        workspaceRoot: deps.workspaceRoot,
        // Интерактивный вопрос агента: задача видна в списке как `question`,
        // пока пользователь не ответит; ответ снова переводит её в `running`.
        onQuestionStatus: (status) => {
          const at = new Date().toISOString();
          db.update(issues)
            .set({ status, updated_at: at })
            .where(eq(issues.id, input.issue.id))
            .run();
          deps.sse.publish({
            type: 'iteration_status',
            issueId: input.issue.id,
            iterationId: input.iteration.id,
            data: JSON.stringify({
              iterationId: input.iteration.id,
              status,
              needsInput: status === 'question',
            }),
            ts: at,
          });
        },
      },
      {
        issue: input.issue,
        iteration,
        repositories: input.repositories,
        preparedRepoWorkspaces: repoWorkspaces,
        model: input.model,
        step_models: input.step_models,
        thinking_level: input.thinking_level,
        step_thinking_levels: input.step_thinking_levels,
        mrToken: input.mrToken,
        description: input.issue.description ?? '',
        jiraText,
        previousOutcome,
        attachmentPaths,
        devServerPort,
      },
    );
  } catch (error) {
    // Инфраструктурный сбой (например, git clone упал по таймауту) не должен
    // оставлять итерацию/задачу навечно в `running` — фиксируем failed.
    console.error('runIteration failed', error);
    const failedAt = new Date().toISOString();
    const message = error instanceof Error ? error.message : String(error);
    db.update(iterations)
      .set({ status: 'failed', updated_at: failedAt })
      .where(eq(iterations.id, input.iteration.id))
      .run();
    db.update(issues)
      .set({ status: 'failed', updated_at: failedAt })
      .where(eq(issues.id, input.issue.id))
      .run();
    deps.sse.publish({
      type: 'iteration_status',
      issueId: input.issue.id,
      iterationId: input.iteration.id,
      data: JSON.stringify({
        iterationId: input.iteration.id,
        status: 'failed',
        needsInput: false,
        error: message,
      }),
      ts: failedAt,
    });
    await writeIterationReport(db, deps, input, 'failed');
    return { iterationStatus: 'failed', needsInput: false };
  }

  // Снапшот результата по итерациям: только для успешно завершённых итераций,
  // best-effort (сам факт снапшота не влияет на статус).
  if (result.iterationStatus === 'completed') {
    await snapshotIterationResult(
      deps.workspaceRoot ?? DEFAULT_WORKSPACE_ROOT,
      input.issue.id,
      input.iteration.id,
      input.issue.desiredResult,
    );
  }

  const finishedAt = new Date().toISOString();
  db.update(iterations)
    .set({ status: result.iterationStatus, updated_at: finishedAt })
    .where(eq(iterations.id, input.iteration.id))
    .run();
  db.update(issues)
    .set({ status: result.iterationStatus, updated_at: finishedAt })
    .where(eq(issues.id, input.issue.id))
    .run();

  deps.sse.publish({
    type: 'iteration_status',
    issueId: input.issue.id,
    iterationId: input.iteration.id,
    data: JSON.stringify({
      iterationId: input.iteration.id,
      status: result.iterationStatus,
      needsInput: result.needsInput,
    }),
    ts: finishedAt,
  });

  await writeIterationReport(db, deps, input, result.iterationStatus);

  return result;
}