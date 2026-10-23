import type {
  DesiredResult,
  Iteration,
  PipelineStep,
  SSEEvent,
  SessionEvent,
  StepModels,
  StepRunStatus,
  StepRunWithLog,
  StepThinkingLevels,
  TaskStatus,
  ThinkingLevel,
} from '@issue-resolver/shared';
import {
  extractIssueKeyFromUrl,
  extractRepoNameFromUrl,
  stepRunStatusFromResult,
} from '@issue-resolver/shared';
import { and, asc, desc, eq } from 'drizzle-orm';
import { spawn } from 'node:child_process';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
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
import { getTag, updateTagRunInstructions } from '../db/tags.repo';
import { issueRepositories, issues, iterations } from '../db/schema';
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
  DevOpsFactory,
  RunInstructionsPort,
  RunIterationResult,
  StepRunStore,
} from '../workflow/engine';
import { prepareWorkspace, runIteration } from '../workflow/engine';
import type { IterationTerminalOutcome } from '../workflow/engine';
import type { WorkspaceProgress } from '../workflow/engine';
import { buildStepPrompt } from '../workflow/prompts';
import {
  ALL_RESULT_ARTIFACTS,
  DEFAULT_WORKSPACE_ROOT,
  iterationResultDirFor,
  workspaceContainerDirFor,
  workspaceHostDirFor,
} from '../workspace/paths';

/** Имя скрипта dev-сервера, который создаёт devops в корне репозитория. */
const DEV_SERVER_SCRIPT = 'DEV_SERVER.sh';

/** Инфраструктурные файлы задачи в корне репозитория (пишет DevOps-агент). */
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
 * создаёт devops и уже содержит выделенный порт. Нет файла/сбой spawn →
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
  devopsModel?: string;
  /** Уровень размышления pi (`--thinking`) для агента-анализатора. */
  devopsThinkingLevel?: ThinkingLevel;
  /**
   * Таймаут одного прогона агента-анализатора (мс). Не задан — дефолт pi/раннера.
   */
  devopsTimeoutMs?: number;
  /** Переопределение фабрики анализатора (тесты/особый wiring). */
  devopsFactory?: DevOpsFactory;
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
    /** Макс. параллельных исполнителей resolve (0 — без ограничений). */
    worker_count?: number;
  };
  repositories: {
    repository_url: string;
    base_branch: string;
    /** Создавать ли MR/PR для этого репозитория (per-repo). */
    create_mr?: boolean;
    /** false — репозиторий клонируется, но install/анализ запуска пропускаются. */
    bootstrap_enabled?: boolean;
  }[];
  /** Готовые репо-воркспейсы (пути + ветки) после clone/devops/install. */
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
 * Документ результата итерации из host-папки задачи. Для контекста агента
 * всегда используется report.md. Отсутствие/ошибка чтения — null.
 */
async function readResultDocument(
  workspaceRoot: string,
  issueId: string,
  _desiredResult?: DesiredResult,
): Promise<string | null> {
  const path = join(workspaceHostDirFor(workspaceRoot, issueId), 'report.md');
  try {
    return await readFile(path, 'utf8');
  } catch {
    return null;
  }
}

/**
 * Снапшот результата успешно завершённой итерации: копирует ВСЕ артефакты
 * (report.md и report.html, если они есть) в
 * `<workspaceRoot>/<issueId>/.iteration-results/<iterationId>`.
 * Best-effort: нет исходного файла — нет снапшота, без падения.
 */
async function snapshotIterationResult(
  workspaceRoot: string,
  issueId: string,
  iterationId: string,
): Promise<void> {
  const targetDir = iterationResultDirFor(workspaceRoot, issueId, iterationId);
  for (const artifact of ALL_RESULT_ARTIFACTS) {
    const source = join(
      workspaceHostDirFor(workspaceRoot, issueId),
      artifact.filename,
    );
    try {
      await mkdir(targetDir, { recursive: true });
      await copyFile(source, join(targetDir, artifact.filename));
    } catch {
      // best-effort снапшот: нет файла/папки → пропускаем, итерацию не роняем.
    }
  }
}

/**
 * Переснимает снапшот последней завершённой итерации (`GET /result` читает
 * именно его). Нужен после report-агента: движок снимает снапшот сразу по
 * завершении итерации, а report пишет `report.md`/`report.html` fire-and-forget
 * и дописывает их позже — без переснятия `/result` отдавал бы устаревший
 * (или отсутствующий) HTML-отчёт, из-за чего модалка отчёта открывалась пустой.
 */
export async function refreshLatestResultSnapshot(
  db: Db,
  workspaceRoot: string | undefined,
  issueId: string,
): Promise<void> {
  const latest = db
    .select({ id: iterations.id })
    .from(iterations)
    .where(
      and(
        eq(iterations.issue_id, issueId),
        eq(iterations.status, 'completed'),
      ),
    )
    .orderBy(desc(iterations.number))
    .get();
  if (!latest) return;
  await snapshotIterationResult(
    workspaceRoot ?? DEFAULT_WORKSPACE_ROOT,
    issueId,
    latest.id,
  );
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

/** Пометка о документе результата, когда файл не найден. */
function documentPlaceholder(): string {
  return '(result document not found)';
}

/** Композиция блока previousOutcome для промпта (см. prompts.buildStepPrompt). */
function composePreviousOutcome(
  previousNumber: number,
  report: PreviousResolveSummary | null,
  document: string | null,
): string {
  const status = report?.status ?? 'unknown';
  const summary = report?.summary.trim() || '(no summary)';
  const documentNote =
    document !== null
      ? document.slice(0, MAX_PREVIOUS_OUTCOME_CHARS)
      : documentPlaceholder();

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
  );

  return composePreviousOutcome(
    currentNumber - 1,
    report,
    document,
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
  devopsFactory?: DevOpsFactory;
  /** Модель агента-анализатора (разовая подготовка рабочей папки). */
  devopsModel?: string;
  /** Уровень размышления pi (`--thinking`) для агента-анализатора. */
  devopsThinkingLevel?: ThinkingLevel;
  /** Таймаут анализа (мс); без него зависший `pi` держит задачу в `preparing`. */
  devopsTimeoutMs?: number;
  /** Корень host-папок задач; по умолчанию `/workspaces`. */
  workspaceRoot?: string;
  /** Реестр живых pi-сессий для steer/abort DevOps-агента. */
  control?: StepSessionRegistry;
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

  // Управляемый dev-сервер: порт выделяем заранее, чтобы devops вписал
  // его в DEV_SERVER.sh. Сервер поднимаем для первого репозитория с
  // `bootstrap_enabled` (по умолчанию true) и только в real-режиме, когда
  // анализатор действительно создаст скрипт (без фабрики — legacy-путь).
  const devRepo = deps.devopsFactory
    ? repos.find((repo) => repo.bootstrap_enabled !== false)
    : undefined;
  const devServerPort = devRepo
    ? await allocateDevPort(input.issueId)
    : undefined;

  // Тег-инструкции: если задача создана из тега — загружаем Markdown-инструкцию
  // по запуску ВСЕГО набора репозиториев (прокси, порты, переменные).
  // Оттуда же берём имена репозиториев, флаги dev-сервера и per-репо инструкции.
  const issueRow = db
    .select({ tag_id: issues.tag_id })
    .from(issues)
    .where(eq(issues.id, input.issueId))
    .get();
  const tag = issueRow?.tag_id ? getTag(db, issueRow.tag_id) : undefined;
  const tagInstructions: string | null = tag?.run_instructions ?? null;

  const reposNames =
    tag
      ? tag.repositories
          .map((tr) => extractRepoNameFromUrl(tr.repository.url))
          .join(', ')
      : input.repositories
          .map((r) => extractRepoNameFromUrl(r.repository_url))
          .join(', ');

  const reposRequireDevServer =
    tag
      ? tag.repositories
          .filter((tr) => tr.bootstrap_enabled)
          .map((tr) => extractRepoNameFromUrl(tr.repository.url))
          .join(', ')
      : input.repositories
          .filter((r) => r.bootstrap_enabled !== false)
          .map((r) => extractRepoNameFromUrl(r.repository_url))
          .join(', ');

  const reposInstructions = tag
    ? tag.repositories
        .map((tr) => {
          const name = extractRepoNameFromUrl(tr.repository.url);
          const instr = tr.repository.runInstructions?.trim();
          return `### ${name}\n${instr || '(no instructions)'}`;
        })
        .join('\n\n')
    : null;

  // Подготовка рабочей папки: анализатор `run_instructions` подключается только
  // при явном `deps.devopsFactory` (real-режим); фейковый дефолт анализа не
  // делает — юнит-тесты не тратят прогоны pi на анализ.
  const prepareDeps = {
    container: deps.container,
    git: deps.git,
    workspaceRoot: deps.workspaceRoot,
    local: deps.local,
    devopsModel: deps.devopsModel,
    devopsThinkingLevel: deps.devopsThinkingLevel,
    devopsTimeoutMs: deps.devopsTimeoutMs,
    devServerPort,
    issueId: input.issueId,
    iterationId: input.iterationId,
    control: deps.control,
    tagInstructions,
    reposNames: reposNames || null,
    reposRequireDevServer: reposRequireDevServer || null,
    reposInstructions,
    ...(deps.devopsFactory
      ? { devops: deps.devopsFactory }
      : {}),
    runInstructions: dbRunInstructionsStore(db),
    // Живой вывод агента-анализатора уходит через обычные `log` события
    // с stepRunId = '{issueId}/devops', чтобы фронт показывал их в SessionView.
    onDevOpsStdout: (_repo: string, chunk: string): void =>
      deps.sse.publish({
        type: 'log',
        issueId: input.issueId,
        iterationId: input.iterationId,
        stepRunId: `${input.issueId}/devops`,
        stream: 'stdout',
        data: chunk,
        ts: new Date().toISOString(),
      }),
    onDevOpsStderr: (_repo: string, chunk: string): void =>
      deps.sse.publish({
        type: 'log',
        issueId: input.issueId,
        iterationId: input.iterationId,
        stepRunId: `${input.issueId}/devops`,
        stream: 'stderr',
        data: chunk,
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

    // Инфраструктурные файлы DevOps-агента не должны попадать в MR.
    repos.forEach((repo) =>
      excludeInfraFiles(workspaceDir, extractRepoNameFromUrl(repo.repository_url)),
    );

    // Управляемый dev-сервер: devops создал DEV_SERVER.sh с выделенным
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

    // Сохраняем WORKSPACE_INSTRUCTIONS.md обратно в тег, если задача из тега
    // и агент написал кросс-репо инструкции.
    if (issueRow?.tag_id) {
      const workspaceInstructionsPath = join(workspaceDir, 'WORKSPACE_INSTRUCTIONS.md');
      if (existsSync(workspaceInstructionsPath)) {
        const wsInstructions = readFileSync(workspaceInstructionsPath, 'utf-8');
        if (wsInstructions.trim()) {
          updateTagRunInstructions(db, issueRow.tag_id, {
            instructions: wsInstructions,
            status: 'generated',
          });
        }
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
 * Читает result.json из корня рабочей папки задачи и upsert-ит MR/PR-ссылки
 * в колонку issues.merge_requests. Best-effort: нет файла / битый JSON = noop.
 */
async function upsertMergeRequestsFromResultJson(
  db: Db,
  workspaceRoot: string,
  issueId: string,
): Promise<void> {
  const resultPath = join(
    workspaceHostDirFor(workspaceRoot, issueId),
    'result.json',
  );
  let text: string;
  try {
    text = readFileSync(resultPath, 'utf8');
  } catch {
    return; // no result.json yet — nothing to upsert
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return; // broken JSON — skip
  }
  const list = (parsed as { merge_requests?: unknown } | null)?.merge_requests;
  if (!Array.isArray(list) || list.length === 0) return;

  interface MrEntry {
    repository_url: string;
    url: string;
    title?: string;
    message?: string;
  }
  const newMrs: MrEntry[] = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const mr = item as Record<string, unknown>;
    const url = typeof mr.url === 'string' ? mr.url.trim() : '';
    if (!url) continue;
    newMrs.push({
      repository_url: typeof mr.repository_url === 'string' ? mr.repository_url : '',
      url,
      ...(typeof mr.title === 'string' ? { title: mr.title } : {}),
      ...(typeof mr.message === 'string' ? { message: mr.message } : {}),
    });
  }
  if (newMrs.length === 0) return;

  // Upsert: сливаем с уже хранящимися, дедуплицируем по url.
  const currentRow = db
    .select({ merge_requests: issues.merge_requests })
    .from(issues)
    .where(eq(issues.id, issueId))
    .get();
  const existing: MrEntry[] = currentRow?.merge_requests ?? [];
  const byUrl = new Map<string, MrEntry>();
  for (const mr of existing) byUrl.set(mr.url ?? '', mr);
  for (const mr of newMrs) byUrl.set(mr.url ?? '', mr);

  db.update(issues)
    .set({ merge_requests: [...byUrl.values()], updated_at: new Date().toISOString() })
    .where(eq(issues.id, issueId))
    .run();
}

/** Артефакты отчёта, которые report-агент пишет в корень рабочей папки. */
const REPORT_ARTIFACTS = ['report.md', 'report.html'] as const;

export interface ReportArchiveResult {
  /** Куда перемещены прошлые артефакты; `null` — архивировать было нечего. */
  dir: string | null;
  /** Имена перемещённых файлов. */
  files: string[];
}

/**
 * Архивирует текущие `report.md`/`report.html` в
 * `<workspace>/<issueId>/reports/<ISO-ts-Z>/` перед новым прогоном
 * report-агента: агент не должен «дописывать» прошлый отчёт — в корне его
 * больше нет, поэтому файлы пишутся заново. История при этом сохраняется.
 *
 * Пустой результат (нечего архивировать) — не ошибка. Сбой fs пробрасывается:
 * вызывающий сам решает, запускать ли агента (в корне мог остаться старый
 * отчёт) и как сообщить причину.
 */
export function archiveReportArtifacts(
  workspaceRoot: string | undefined,
  issueId: string,
): ReportArchiveResult {
  const wsRoot = workspaceRoot ?? DEFAULT_WORKSPACE_ROOT;
  const issueDir = workspaceHostDirFor(wsRoot, issueId);
  const files = REPORT_ARTIFACTS.filter((name) =>
    existsSync(join(issueDir, name)),
  );
  if (files.length === 0) return { dir: null, files: [] };

  const stamp = new Date().toISOString();
  let dir = join(issueDir, 'reports', stamp);
  // Два прогона в одну миллисекунду — редкий, но реальный случай.
  for (let n = 1; existsSync(dir); n += 1) {
    dir = join(issueDir, 'reports', `${stamp}-${n}`);
  }
  mkdirSync(dir, { recursive: true });
  for (const name of files) {
    renameSync(join(issueDir, name), join(dir, name));
  }
  return { dir, files };
}

/** Строка для лога: пути артефактов отчёта и их размеры (или `absent`). */
function describeReportArtifacts(issueDir: string): string {
  return REPORT_ARTIFACTS.map((name) => {
    const path = join(issueDir, name);
    try {
      return `${path} (${statSync(path).size}B)`;
    } catch {
      return `${path} (absent)`;
    }
  }).join(', ');
}

/**
 * Узкие паттерны «похоже на id модели/провайдера» — НЕ зависят от `input.model`.
 * Нужны, чтобы поймать id ЧУЖОЙ модели, перекочевавший из прошлого отчёта
 * (якорение): точный слой знает только модель текущего прогона. Намеренно
 * узкие — голые имена из списка засчитываются только рядом с разделителем
 * (`/`, `` ` ``, `:`), а `model:` — только как поле с id-подобным значением,
 * иначе легальный текст («signal store model», «модель данных», «model view»)
 * даёт ложняк.
 */
const MODEL_ID_PATTERNS: RegExp[] = [
  /provider\d*\//i,
  /\*\*Model:\*\*/i,
  /\bmodel:\s*`?[a-z0-9._-]+\/[a-z0-9._-]+/i,
  /(?<=[`/:])(?:deepseek|claude|gpt|qwen|llama)[-.\w]*/i,
  /\b(?:deepseek|claude|gpt|qwen|llama)[-.\w]*(?=[`/:])/i,
];

/**
 * Механический детект утечки id модели/провайдера в артефакты отчёта.
 * Два слоя: (1) точный id текущего прогона (и его хвост после `/`, если он
 * достаточно длинный, чтобы не ловить «auto»); (2) узкий паттерн-поиск,
 * независимый от модели прогона — ловит чужой id из прочитанного прошлого
 * отчёта. На файл — максимум один warning (точный слой приоритетнее).
 * Возвращает список строк-предупреждений: `model id leaked into <file>`
 * (текущая модель) / `model-like id leaked into <file>` (похоже на модель).
 */
function detectModelLeak(issueDir: string, model?: string): string[] {
  const needles = new Set<string>();
  if (model) {
    needles.add(model);
    const bare = model.includes('/')
      ? model.slice(model.lastIndexOf('/') + 1)
      : '';
    if (bare.length >= 6) needles.add(bare);
  }

  const warnings: string[] = [];
  for (const name of REPORT_ARTIFACTS) {
    let text: string;
    try {
      text = readFileSync(join(issueDir, name), 'utf8');
    } catch {
      continue;
    }
    const exact = [...needles].find((needle) => text.includes(needle));
    if (exact) {
      warnings.push(`model id leaked into ${name}`);
      continue;
    }
    if (MODEL_ID_PATTERNS.some((pattern) => pattern.test(text))) {
      warnings.push(`model-like id leaked into ${name}`);
    }
  }
  return warnings;
}

/**
 * Предыдущий отчёт: `reports/**` или `.iteration-results/**` с хвостом ровно
 * `report.md`/`report.html`. Легальные источники из тех же папок
 * (`report-<n>.md`, `.<step>.md`) под шаблон не попадают.
 */
const PREVIOUS_REPORT_PATH =
  /(?:[^\s"'`\\]*\/)?(?:reports|\.iteration-results)\/[^\s"'`\\]+\/report\.(?:md|html)/;

/**
 * Якорение на прошлом отчёте: путь из `tool_use`-события (`read` и
 * `bash cat/head/sed/…` — аргументы целиком), первый найденный на прогон.
 * Это ВИДИМОСТЬ, не запрет: агент мог законно перечитать старый отчёт.
 */
function anchoredPreviousReportPath(event: SessionEvent): string | null {
  if (event.type !== 'tool_use') return null;
  const match = PREVIOUS_REPORT_PATH.exec(JSON.stringify(event.args ?? ''));
  return match ? match[0] : null;
}

/** Минимальный набор deps для issue-уровневого прогона report-агента. */
export type ReportRunDeps = Pick<
  IterationRunDeps,
  'pi' | 'sse' | 'control' | 'workspaceRoot'
>;

/**
 * Задачи, для которых прямо сейчас идёт report-прогон. Пока флаг есть, корень
 * задачи заархивирован, поэтому `/report/status` отдаёт `running`, а UI
 * показывает живой SessionView вместо «✓ Сгенерирован». `/result` при этом НЕ
 * 404: он отдаёт прошлый HTML из `.iteration-results/<latest>/` с пометкой
 * `x-artifact-source: iteration-snapshot` — предыдущую версию полезнее показать
 * под честной подписью, чем пустоту. Флаг живёт только в этом процессе
 * (in-process only): рестарт backend его обнуляет, так что прогон, оборванный
 * рестартом, не остаётся «вечно активным».
 */
const activeReportRuns = new Set<string>();

/**
 * Исход последнего report-прогона (process-local): нужен `/report/status`,
 * чтобы отличить `failed` (агент упал, корень пуст) от `idle` (прогона не было).
 * Кросс-рестарт сбрасывается в `idle` — статус не персистится.
 */
const lastReportOutcome = new Map<string, 'failed'>();

export function isReportRunActive(issueId: string): boolean {
  return activeReportRuns.has(issueId);
}

/** `failed`, если последний прогон упал и с тех пор не было успешного. */
export function lastReportFailed(issueId: string): boolean {
  return lastReportOutcome.get(issueId) === 'failed';
}

/**
 * Предупреждения о содержимом последнего отчёта: утечка id модели/провайдера
 * в `report.md`/`report.html`. Слой 1 (точный id прогона) хранится здесь —
 * process-local, гаснет на рестарте. Слой 2 читается из файлов на лету
 * (`reportWarningsFor`), поэтому переживает рестарт. Отдаются в `/report/status`
 * (поле `warnings`) и заголовком `x-artifact-warning` на артефактных роутах,
 * чтобы UI показал бейдж. Сам файл агента не переписываем: prevention —
 * промпт, detection — сервер, visibility — UI.
 */
const reportWarnings = new Map<string, string[]>();

/**
 * Модель, которую pi-сессия отчёта реально назвала (`stats.model`) — не та,
 * что запрошена: при пустом `step_models.report` модель выбирает сам pi.
 * Process-local: после рестарта отсутствует, и UI обязан показать «нет
 * телеметрии», а не подставлять запрошенную/дефолтную догадку.
 */
const observedReportModel = new Map<string, string>();

/** Наблюдённая модель последнего прогона отчёта (или undefined). */
export function observedModelFor(issueId: string): string | undefined {
  return observedReportModel.get(issueId);
}

export function reportWarningsFor(issueId: string, hostDir?: string): string[] {
  // Слой 1 (точный id) — process-local; слой 2 — производная от файлов,
  // переживает рестарт. Иглой точного слоя служит НАБЛЮДЁННАЯ модель
  // (post-hoc, если сессия её назвала) — тогда ловится реальный id, а не
  // запрошенный по догадке. Оба слоя дают максимум один warning на файл
  // (слой 1 приоритетнее), поэтому производные записи по уже помеченному
  // файлу отбрасываем.
  const live = reportWarnings.get(issueId) ?? [];
  if (!hostDir) return live;
  const flagged = new Set(live.map((warning) => warningFile(warning)));
  const derived = detectModelLeak(
    hostDir,
    observedReportModel.get(issueId),
  ).filter((warning) => !flagged.has(warningFile(warning)));
  return [...live, ...derived];
}

/** Имя файла из строки-предупреждения (`… leaked into <file>`). */
function warningFile(warning: string): string | null {
  const match = /leaked into (.+)$/.exec(warning);
  return match ? match[1] : null;
}

/**
 * Единая effective-модель report-прогона для ОБОИХ входов — терминальной
 * итерации и ручного `POST /report`: `step_models.report` задачи, иначе
 * модель итерации (`iterations.model`). В движковом пути передаётся та
 * итерация, что терминалилась (значение совпадает с прежним `input.model`);
 * ручной путь догоняется и берёт последнюю завершённую итерацию. Иначе
 * «🔄 Обновить» собирал бы отчёт на системном дефолте pi, а терминальный —
 * на модели итерации: два артефакта с одним именем и разной provenance,
 * и ни один лог бы этого не сказал (в SSE у обоих было `model: null`).
 */
export function reportModelFor(
  db: Db,
  issueId: string,
  iterationId?: string,
): string | undefined {
  const issue = db
    .select({ step_models: issues.step_models })
    .from(issues)
    .where(eq(issues.id, issueId))
    .get();
  const explicit = issue?.step_models?.report;
  if (explicit) return explicit;

  const iteration = iterationId
    ? db
        .select({ model: iterations.model })
        .from(iterations)
        .where(eq(iterations.id, iterationId))
        .get()
    : db
        .select({ model: iterations.model })
        .from(iterations)
        .where(
          and(
            eq(iterations.issue_id, issueId),
            eq(iterations.status, 'completed'),
          ),
        )
        .orderBy(desc(iterations.number))
        .get();
  return iteration?.model ?? undefined;
}

/**
 * Уровень мышления для report-агента. Приоритет:
 * `step_thinking_levels.report` задачи, иначе `thinking_level` итерации.
 * Аналог reportModelFor — отдельная функция для thinking.
 */
export function reportThinkingLevelFor(
  db: Db,
  issueId: string,
): ThinkingLevel | undefined {
  const issue = db
    .select({ step_thinking_levels: issues.step_thinking_levels })
    .from(issues)
    .where(eq(issues.id, issueId))
    .get();
  return issue?.step_thinking_levels?.report;
}

export interface RunReportAgentInput {
  issueId: string;
  containerName: string;
  hostDir: string;
  prompt: string;
  model?: string;
  thinkingLevel?: ThinkingLevel;
  /** Кто запустил прогон: терминальная итерация или ручной POST /report. */
  trigger?: 'post-iteration' | 'manual';
  /** Для ручного запуска — Origin HTTP-запроса (атрибуция в логе). */
  origin?: string | null;
}

/**
 * `step_status` для issue-уровневого report-прогона: та же форма, что у шагов
 * пайплайна (running — JSON `{status, step, model}`, терминал — строка
 * статуса), но без `iterationId` — отчёт живёт на уровне задачи.
 */
function reportStepStatusEvent(
  issueId: string,
  reportRunId: string,
  status: StepRunStatus | 'running',
  model?: string,
): SSEEvent {
  return {
    type: 'step_status',
    issueId,
    stepRunId: reportRunId,
    data:
      status === 'running'
        ? JSON.stringify({ status, step: 'report', model: model ?? null })
        : status,
    ts: new Date().toISOString(),
  };
}

/**
 * Запускает report-агента с единым SSE-контрактом: `step_status` running →
 * терминальный success/failed по stepRunId `{issueId}/report` плюс live
 * log/step_event. Ошибки агента не пробрасываются: они публикуются как
 * `failed` и пишутся в серверный лог, чтобы fire-and-forget прогон не тонул
 * молча. Старт/итог/длительность видны в `/tmp/ir-backend.log`.
 */
export async function runReportAgent(
  deps: ReportRunDeps,
  input: RunReportAgentInput,
): Promise<void> {
  const reportRunId = `${input.issueId}/report`;

  // Архивация — ОДНА точка на оба входа (post-iteration и ручной POST):
  // агент не должен «дописывать» прошлый отчёт, в корне его больше нет.
  // Сбой → терминальный `failed` + лог, агента НЕ спавним (старый файл
  // остаётся в корне — это видимое, но честное состояние).
  let archive: ReportArchiveResult;
  try {
    archive = archiveReportArtifacts(deps.workspaceRoot, input.issueId);
  } catch (error) {
    console.error('report artifacts archive failed', {
      issueId: input.issueId,
      error,
    });
    lastReportOutcome.set(input.issueId, 'failed');
    deps.sse.publish(
      reportStepStatusEvent(input.issueId, reportRunId, 'failed'),
    );
    return;
  }

  const startedAt = Date.now();
  console.log(
    `report agent started: issue=${input.issueId} trigger=${input.trigger ?? 'unknown'}${input.origin ? ` origin=${input.origin}` : ''} archived=${archive.dir ?? 'none'} files=[${archive.files.join(', ')}] at=${new Date(startedAt).toISOString()}`,
  );
  deps.sse.publish(
    reportStepStatusEvent(input.issueId, reportRunId, 'running', input.model),
  );
  activeReportRuns.add(input.issueId);

  let status: StepRunStatus = 'failed';
  let failure: unknown;
  let observedModel: string | undefined;
  let anchoredPath: string | null = null;
  try {
    const result = await deps.pi.run(input.containerName, input.prompt, {
      // Report пишет в host-папку задачи: контейнер итерации к этому моменту
      // уже не нужен, а артефакты должны осесть в переживающей папке.
      cwd: input.hostDir,
      model: input.model,
      thinkingLevel: input.thinkingLevel,
      stepRunId: reportRunId,
      issueId: input.issueId,
      registry: deps.control,
      onStdout: (chunk: string) =>
        deps.sse.publish({
          type: 'log',
          issueId: input.issueId,
          stepRunId: reportRunId,
          stream: 'stdout',
          data: chunk,
          ts: new Date().toISOString(),
        }),
      onStderr: (chunk: string) =>
        deps.sse.publish({
          type: 'log',
          issueId: input.issueId,
          stepRunId: reportRunId,
          stream: 'stderr',
          data: chunk,
          ts: new Date().toISOString(),
        }),
      // Структурированные события сессии (thinking/tool_use/…) — в SSE
      // обычным step_event, чтобы SessionView отчёта показывал не только
      // сырой stdout.
      onEvent: (event) => {
        // Видимость якорения: агент читает ПРОШЛЫЙ отчёт (архив/снапшот).
        // Только сигнал, не блокировка; максимум один путь на прогон.
        if (anchoredPath === null) {
          anchoredPath = anchoredPreviousReportPath(event);
        }
        deps.sse.publish({
          type: 'step_event',
          issueId: input.issueId,
          stepRunId: reportRunId,
          stream: 'system',
          data: JSON.stringify({ stepRunId: reportRunId, event }),
          ts: new Date().toISOString(),
        });
      },
    });
    // Что сессия назвала фактически — единственная честная игла для детекта.
    observedModel = result.stats?.model ?? undefined;
    const derived = result.aborted
      ? 'failed'
      : stepRunStatusFromResult(result.exitCode, result.report);
    // Для отчёта осмысленны только success/failed (`needs_input`/`skipped`
    // у него не бывает): всё, кроме явного успеха, — падение прогона.
    status = derived === 'success' ? 'success' : 'failed';
    if (status === 'failed') failure = `exit status: ${derived}`;
  } catch (error) {
    failure = error;
    status = 'failed';
  } finally {
    // Снятие флага — строго в `finally`: любой throw выше (в т.ч. из
    // `sse.publish`) не имеет права оставить «вечный активный» прогон, иначе
    // `/report/status` навсегда `running`, а UI крутит «⏳» навсегда.
    activeReportRuns.delete(input.issueId);
    if (observedModel) observedReportModel.set(input.issueId, observedModel);
    else observedReportModel.delete(input.issueId);
    if (status === 'success') {
      lastReportOutcome.delete(input.issueId);
      // Игла — наблюдённая модель (если сессия её назвала), иначе запрошенная.
      const warnings = [
        ...detectModelLeak(input.hostDir, observedModel ?? input.model),
        // Якорение — своя строка (отдельно от модели), но тег warn'а общий,
        // чтобы грепалось вместе с моделью. Сигнал из tool_use, не из файла:
        // process-local, после рестарта с диска не пересчитывается.
        ...(anchoredPath
          ? [`anchored on previous report: ${anchoredPath}`]
          : []),
      ];
      if (warnings.length > 0) {
        reportWarnings.set(input.issueId, warnings);
        console.warn('model id leaked into report artifacts', {
          issueId: input.issueId,
          warnings,
        });
      } else {
        reportWarnings.delete(input.issueId);
      }
    } else {
      lastReportOutcome.set(input.issueId, 'failed');
    }
  }

  deps.sse.publish(reportStepStatusEvent(input.issueId, reportRunId, status));
  const durationMs = Date.now() - startedAt;
  if (status === 'success') {
    console.log(
      `report agent finished: issue=${input.issueId} trigger=${input.trigger ?? 'unknown'} durationMs=${durationMs} artifacts: ${describeReportArtifacts(input.hostDir)}`,
    );
  } else {
    console.error('report agent failed', {
      issueId: input.issueId,
      durationMs,
      error: failure,
    });
  }
}

/**
 * Создаёт и запускает report-агента для сборки `report.md` и `report.html`
 * по итогам завершённых итераций. Fire-and-forget: ошибки не роняют итерацию.
 */
async function spawnReportAgent(
  db: Db,
  deps: IterationRunDeps,
  outcome: IterationTerminalOutcome,
): Promise<void> {
  const wsRoot = deps.workspaceRoot ?? DEFAULT_WORKSPACE_ROOT;
  const hostDir = workspaceHostDirFor(wsRoot, outcome.issueId);

  const prompt = buildStepPrompt({
    step: 'report',
    issueTitle: outcome.issueTitle,
    description: '',
    jiraText: null,
    context: `Iteration #${outcome.iterationNumber} completed with status: ${outcome.iterationStatus}.`,
    feedback: null,
    repoPaths: outcome.repoPaths,
    iterationCount: outcome.iterationCount,
  });

  await runReportAgent(deps, {
    issueId: outcome.issueId,
    containerName: outcome.containerName,
    hostDir,
    prompt,
    model: reportModelFor(db, outcome.issueId, outcome.iterationId),
    thinkingLevel:
      reportThinkingLevelFor(db, outcome.issueId) ??
      outcome.thinkingLevel,
    trigger: 'post-iteration',
  });
  try {
    // Отчёт дописан — обновляем снапшот, который читает GET /result.
    await refreshLatestResultSnapshot(db, deps.workspaceRoot, outcome.issueId);
  } catch (error) {
    console.error('refresh report snapshot failed', error);
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
    worker_count: input.iteration.worker_count,
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
  // Терминальный итог для report-агента: движок зовёт колбэк из середины
  // прогона, но спавнить агента надо ПОСЛЕ снапшота итерации (см. ниже) —
  // иначе архивация корня лишает снапшот предыдущего отчёта.
  let reportOutcome: IterationTerminalOutcome | null = null;
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
        // Post-iteration report agent: spawn on terminal completion/failure.
        // Не спавним здесь — запоминаем итог и запускаем после снапшота.
        onIterationTerminal: (outcome) => {
          reportOutcome = outcome;
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
    // Best-effort: даже при сбое итерации, result.json мог остаться от
    // предыдущей — поднимаем MR-ссылки в данные задачи.
    void upsertMergeRequestsFromResultJson(
      db,
      deps.workspaceRoot ?? DEFAULT_WORKSPACE_ROOT,
      input.issue.id,
    ).catch((error) => console.error('upsertMergeRequests failed', error));
    return { iterationStatus: 'failed', needsInput: false };
  }

  // Снапшот результата по итерациям: только для успешно завершённых итераций,
  // best-effort (сам факт снапшота не влияет на статус).
  if (result.iterationStatus === 'completed') {
    await snapshotIterationResult(
      deps.workspaceRoot ?? DEFAULT_WORKSPACE_ROOT,
      input.issue.id,
      input.iteration.id,
    );
  }

  // Report-агент запускаем после снапшота: его архивация `report.*` из корня
  // не должна обеднять снапшот итерации. Архив сохраняет историю, а новый
  // отчёт потом перезапишет снапшот через refreshLatestResultSnapshot.
  if (reportOutcome) {
    void spawnReportAgent(db, deps, reportOutcome);
  }

  const finishedAt = new Date().toISOString();
  db.update(iterations)
    .set({ status: result.iterationStatus, updated_at: finishedAt })
    .where(eq(iterations.id, input.iteration.id))
    .run();

  // Если в очереди есть pending-итерация, задача остаётся pending, а не
  // переходит в completed/failed — иначе startNextPendingIteration ниже
  // не сможет её подхватить (issue.completed запрещает новые итерации).
  const hasNextPending = db
    .select({ id: iterations.id })
    .from(iterations)
    .where(
      and(
        eq(iterations.issue_id, input.issue.id),
        eq(iterations.status, 'pending'),
      ),
    )
    .get();

  const issueStatus = hasNextPending ? 'pending' : result.iterationStatus;
  db.update(issues)
    .set({ status: issueStatus, updated_at: finishedAt })
    .where(eq(issues.id, input.issue.id))
    .run();

  // Best-effort: записать MR-ссылки из result.json в БД задачи
  void upsertMergeRequestsFromResultJson(
    db,
    deps.workspaceRoot ?? DEFAULT_WORKSPACE_ROOT,
    input.issue.id,
  ).catch((error) => console.error('upsertMergeRequests failed', error));

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

  // Запускаем следующую pending-итерацию для этого issue, если есть.
  // Делаем это асинхронно, не блокируя завершение текущей.
  void startNextPendingIteration(db, deps, input.issue.id).catch((error) =>
    console.error(
      `[queue] startNextPendingIteration failed for issue ${input.issue.id}`,
      error,
    ),
  );

  return result;
}

/**
 * Запускает следующую pending-итерацию для issue, если она есть.
 * Вызывается после завершения текущей итерации — так образуется очередь:
 * пользователь может создать несколько итераций, пока выполняется текущая,
 * и они будут выполняться последовательно.
 */
async function startNextPendingIteration(
  db: Db,
  deps: IterationRunDeps,
  issueId: string,
): Promise<void> {
  // Находим первую (по номеру) pending-итерацию.
  const next = db
    .select()
    .from(iterations)
    .where(
      and(eq(iterations.issue_id, issueId), eq(iterations.status, 'pending')),
    )
    .orderBy(asc(iterations.number))
    .get();

  if (!next) return; // Очередь пуста.

  const issue = db
    .select()
    .from(issues)
    .where(eq(issues.id, issueId))
    .get();
  if (!issue) return;

  const repositories = db
    .select()
    .from(issueRepositories)
    .where(eq(issueRepositories.issue_id, issueId))
    .all()
    .map((repository) => ({
      repository_url: repository.repository_url,
      base_branch: repository.branch_name,
      create_mr: !!repository.create_mr,
      bootstrap_enabled: repository.bootstrap_enabled ?? true,
    }));

  const prepareDeps = {
    container: deps.container,
    git: deps.git,
    sse: deps.sse,
    local: deps.local,
    control: deps.control,
    ...(deps.devopsFactory
      ? { devopsFactory: deps.devopsFactory }
      : {}),
    devopsModel: deps.devopsModel,
    devopsThinkingLevel: deps.devopsThinkingLevel,
    devopsTimeoutMs: deps.devopsTimeoutMs,
    workspaceRoot: deps.workspaceRoot,
  };

  console.error(
    `[queue] starting pending iteration ${next.id} (#${next.number}) for issue ${issueId}`,
  );

  void (async () => {
    try {
      const ws = await prepareIssueWorkspace(db, prepareDeps, {
        issueId: issue.id,
        iterationId: next.id,
        repositories,
      });
      void runIssueIteration(db, deps, {
        issue: {
          id: issue.id,
          title: issue.title,
          pipelineSteps: issue.pipeline_steps,
          description: issue.description ?? '',
          desiredResult: issue.desired_result ?? 'md',
          jiraIssueUrl: issue.jira_issue_url,
        },
        iteration: {
          id: next.id,
          issueId: issue.id,
          number: next.number,
          context: next.context,
          steps: next.steps,
          reviewContext: next.review_context ?? '',
          isReviewNeed: !!next.is_review_need,
          worker_count: next.worker_count ?? undefined,
        },
        repositories,
        repoWorkspaces: ws,
        model: next.model ?? undefined,
        step_models: next.step_models ?? undefined,
        thinking_level: next.thinking_level ?? undefined,
        step_thinking_levels: next.step_thinking_levels ?? undefined,
      }).catch((error) => console.error('run failed', error));
    } catch (error) {
      console.error('preparation failed, issue set to failed', error);
    }
  })();
}