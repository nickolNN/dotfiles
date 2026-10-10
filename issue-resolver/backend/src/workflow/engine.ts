import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  ContainerSpec,
  DesiredResult,
  ExecutionPlan,
  Iteration,
  PipelineStep,
  RoomWorkItem,
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
} from '@issue-resolver/shared';
import {
  nextStepDecision,
  parseStepReport,
  planExecutionMode,
  stepRunStatusFromResult,
} from '@issue-resolver/shared';
import type { ContainerController } from '../docker/controller';
import type { GitPrepareResult, GitService } from '../git/service';
import type { PiRunner } from '../pi/runner';
import type { RoomAgentInfo, StepSessionRegistry } from '../pi/session-registry';
import { detectGitHost, type MrClient } from '../pr/mr';
import type { SseHub } from '../sse/hub';
import {
  containerNameFor,
  DEFAULT_WORKSPACE_ROOT,
  workspaceContainerDirFor,
  workspaceHostDirFor,
} from '../workspace/paths';
import { buildStepPrompt } from './prompts';
import { runRoomResolve, runStagedResolve } from './room';

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
    iterationId: string;
    step: PipelineStep;
    attempt: number;
    context: string;
  }): Promise<StepRun>;
  updateStepRun(
    id: string,
    patch: { status?: StepRunStatus; feedback?: string | null },
  ): Promise<StepRun>;
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
  /** Описание задачи для промпта. */
  description?: string;
  /** Текст задачи из Jira для промпта (или null). */
  jiraText?: string | null;
  /** Итог предыдущей итерации для промпта (или undefined на итерации №1). */
  previousOutcome?: string | null;
  /** Пути загруженных файлов (относительно корня рабочей папки задачи). */
  attachmentPaths?: string[];
}

export interface RunIterationResult {
  iterationStatus: TaskStatus;
  needsInput: boolean;
}

const IMAGE = 'dotfiles-agent';
const MAX_ATTEMPTS = 3;

/** Имя файла-отчёта, который шаг конвейера пишет в рабочую папку задачи. */
const STEP_REPORT_FILE = '.issue-step-result.json';

const nowIso = (): string => new Date().toISOString();

/**
 * Читает `.issue-step-result.json` из рабочей папки задачи. Отсутствие файла,
 * ошибки чтения и невалидный JSON → null (не роняем прогон).
 */
async function readStepReportFile(
  workspaceHostDir: string,
): Promise<StepReport | null> {
  try {
    const text = await readFile(join(workspaceHostDir, STEP_REPORT_FILE), 'utf8');
    return parseStepReport(text);
  } catch {
    return null;
  }
}

const stepStatusEvent = (
  issueId: string,
  iterationId: string,
  stepRunId: string,
  status: StepRunStatus | 'running',
): SSEEvent => ({
  type: 'step_status',
  issueId,
  iterationId,
  stepRunId,
  data: status,
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
  const { issue, iteration, repositories } = input;
  const repoUrls = repositories.map((repo) => repo.repository_url);
  const baseBranches = repositories.map((repo) => repo.base_branch);
  const workspaceRoot = deps.workspaceRoot ?? DEFAULT_WORKSPACE_ROOT;
  const containerName = containerNameFor(issue.id);
  const workspaceHostDir = workspaceHostDirFor(workspaceRoot, issue.id);
  const workspaceContainerPath = workspaceContainerDirFor(issue.id);

  const spec: ContainerSpec = {
    issueId: issue.id,
    containerName,
    image: IMAGE,
    workspaceHostPath: workspaceHostDir,
    repoUrls,
    // Общая на все контейнеры память модели — named volume.
    memoryVolumeName: process.env.ISSUE_RESOLVER_MEMORY_VOLUME || 'agent-memory',
  };
  await deps.container.spawn(spec);
  // Без репозиториев git-подготовка не нужна: агент работает в пустой
  // рабочей папке задачи (её создаёт контейнер/workspace как обычно).
  let repoWorkspaces: GitPrepareResult['repoWorkspaces'] = [];
  if (repositories.length > 0) {
    const prepared = await deps.git.prepare({
      repoUrls,
      baseBranches,
      workspacePath: workspaceHostDir,
    });
    repoWorkspaces = prepared.repoWorkspaces;
  }
  const repoPaths = repoWorkspaces.map((workspace) => workspace.path);

  const rawSteps =
    iteration.steps.length > 0 ? iteration.steps : issue.pipelineSteps;
  const steps = canonicalStepOrder(rawSteps);

  let stepIndex = 0;
  // attempt общий для шагов одного прохода: resolve#2 → review#2 (см. UNIQUE
  // step_runs(iteration_id, step, attempt) и план §8 «откат с attempt+1»).
  let attempt = 1;
  // Фидбек прошлого упавшего шага (review/test) для следующего resolve.
  let feedback: string | null = null;
  // Рекомендация refine о топологии resolve: план (summary) и execution.
  // Заполняется только успешным refine-шагом; до него — null (single).
  let refinedPlan: string | null = null;
  let refinedExecution: ExecutionPlan | null = null;

  while (stepIndex < steps.length) {
    const step = steps[stepIndex];

    const stepRun = await deps.store.createStepRun({
      iterationId: iteration.id,
      step,
      attempt,
      context: iteration.context,
    });
    // Прогон создаётся как `pending`; фиксируем `running` в БД, а не только в
    // SSE — иначе refetch во время работы шага видит `pending`.
    await deps.store.updateStepRun(stepRun.id, { status: 'running' });
    deps.sse.publish(
      stepStatusEvent(issue.id, iteration.id, stepRun.id, 'running'),
    );

    // Общий prompt-контекст шага: одинаков для single-resolve и работников
    // комнаты (у комнаты отличие только в buildRoom* промптах).
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
    };
    const model = (input.step_models?.[step] ?? input.model) || undefined;
    const thinkingLevel =
      (input.step_thinking_levels?.[step] ?? input.thinking_level) || undefined;
    const runOptions = {
      model,
      thinkingLevel,
      cwd: deps.local ? workspaceHostDir : workspaceContainerPath,
      iterationId: iteration.id,
      issueId: issue.id,
      registry: deps.control,
      onStdout: (chunk: string, agent?: RoomAgentInfo) =>
        deps.sse.publish(
          streamEvent(
            issue.id,
            iteration.id,
            stepRun.id,
            'stdout',
            chunk,
            agent?.id,
          ),
        ),
      onStderr: (chunk: string, agent?: RoomAgentInfo) =>
        deps.sse.publish(
          streamEvent(
            issue.id,
            iteration.id,
            stepRun.id,
            'stderr',
            chunk,
            agent?.id,
          ),
        ),
      onEvent: (event: SessionEvent, agent?: RoomAgentInfo) =>
        deps.sse.publish(
          stepEvent(issue.id, iteration.id, stepRun.id, event, agent?.id),
        ),
    };

    // Детерминированная развилка топологии resolve: refine рекомендует
    // single|room|stages, движок распоряжается (см. planExecutionMode).
    const topology =
      step === 'resolve' ? planExecutionMode(refinedExecution) : 'single';
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
    if (topology === 'room') {
      result = await runRoomResolve(
        deps.pi,
        {
          containerName,
          execution: refinedExecution as ExecutionPlan,
          ...promptContext,
          refinedPlan,
        },
        { ...runOptions, stepRunId: stepRun.id, onWorkerStart },
      );
    } else if (topology === 'stages') {
      result = await runStagedResolve(
        deps.pi,
        {
          containerName,
          execution: refinedExecution as ExecutionPlan,
          ...promptContext,
          refinedPlan,
        },
        { ...runOptions, stepRunId: stepRun.id, onWorkerStart },
      );
    } else {
      result = await deps.pi.run(
        containerName,
        buildStepPrompt({ step, ...promptContext, refinedPlan }),
        { ...runOptions, stepRunId: stepRun.id },
      );
    }

    // Отчёт шага — источник истины в рабочей папке задачи. В RPC-режиме
    // `result.report` всегда null, поэтому отдаём приоритет файлу
    // `.issue-step-result.json`, а `result.report` — фолбек для in-memory
    // реализаций (тесты, не-RPC раннеры).
    const fileReport = await readStepReportFile(workspaceHostDir);
    const report = fileReport ?? result.report;

    // abort — отдельный терминальный статус шага (не failed): никакого retry
    // и следующих шагов, вся итерация переводится в cancelled.
    const status: StepRunStatus = result.aborted
      ? 'aborted'
      : stepRunStatusFromResult(result.exitCode, report);
    await deps.store.updateStepRun(stepRun.id, { status });
    await deps.store.createStepOutput({
      stepRunId: stepRun.id,
      report: report ? JSON.stringify(report) : '',
      stdout: result.stdout,
      stderr: result.stderr,
      events: result.events ?? [],
      stats: result.stats ?? null,
    });
    deps.sse.publish(stepStatusEvent(issue.id, iteration.id, stepRun.id, status));

    // Успешный refine — единственный источник рекомендации о топологии
    // resolve: план для промпта и execution для развилки single/room.
    if (step === 'refine' && status === 'success') {
      refinedPlan = report?.summary || null;
      refinedExecution = report?.execution ?? null;
    }

    if (status === 'aborted') {
      return { iterationStatus: 'cancelled', needsInput: false };
    }

    // Фаза 4: успешный pr-шаг публикует результат — commit/push + MR — для
    // тех репозиториев, где запрошен MR (per-repo create_mr). Для остальных
    // результат остаётся файлами в рабочей папке задачи.
    if (step === 'pr' && status === 'success' && repoWorkspaces.length > 0) {
      await publishPrResult(
        deps,
        input,
        repoWorkspaces,
        report?.summary ?? '',
        stepRun.id,
      );
    }

    if (status === 'needs_input') {
      return { iterationStatus: 'failed', needsInput: true };
    }

    const decision = nextStepDecision({
      steps,
      currentStep: step,
      result: status === 'success' ? 'success' : 'failed',
      attempt,
      maxAttempts: MAX_ATTEMPTS,
    });

    switch (decision.kind) {
      case 'advance':
        if (decision.iterationCompleted) {
          return { iterationStatus: 'completed', needsInput: false };
        }
        stepIndex += 1;
        break;
      case 'retry_resolve':
        feedback = report?.summary ?? null;
        attempt = decision.attempt;
        stepIndex = steps.indexOf('resolve');
        break;
      case 'needs_input':
        return { iterationStatus: 'failed', needsInput: true };
      case 'iteration_failed':
        return { iterationStatus: 'failed', needsInput: false };
    }
  }

  // Пустой конвейер: запускать нечего — итерация тривиально завершена.
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
 * Успешный pr-шаг: для каждого репозитория commit/push, затем создание MR.
 * Возвращает артефакты созданных MR (пустой массив — ничего не создано) и
 * best-effort пишет `result.json` в корень рабочей папки задачи.
 * Вызывается только при `step === 'pr' && status === 'success'`.
 */
async function publishPrResult(
  deps: WorkflowDeps,
  input: RunIterationInput,
  repoWorkspaces: GitPrepareResult['repoWorkspaces'],
  description: string,
  stepRunId: string,
): Promise<MrResultArtifact[]> {
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

  // Нет репозиториев — нечего коммитить/пушить и не для чего создавать MR.
  if (repoWorkspaces.length === 0) {
    return artifacts;
  }

  for (const workspace of repoWorkspaces) {
    // MR только для репозиториев, где он запрошен (per-repo create_mr).
    if (!createMrByUrl.get(workspace.repoUrl)) {
      continue;
    }
    const commit = await deps.git.commitAndPush({
      repoPath: workspace.path,
      branchName: workspace.branch,
      commitMessage: `feat: ${input.issue.title}`,
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

    const mr = await deps.mr.createMr({
      repositoryUrl: workspace.repoUrl,
      baseBranch: baseBranchByUrl.get(workspace.repoUrl) ?? workspace.branch,
      headBranch: workspace.branch,
      title: input.issue.title,
      description,
      token: input.mrToken ?? '',
      source: detectGitHost(workspace.repoUrl),
    });
    artifacts.push({
      repositoryUrl: workspace.repoUrl,
      mrUrl: mr.mrUrl,
      title: input.issue.title,
      description,
    });
    deps.sse.publish(
      streamEvent(
        input.issue.id,
        input.iteration.id,
        stepRunId,
        'mr',
        mr.mrUrl,
      ),
    );
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

  return artifacts;
}
