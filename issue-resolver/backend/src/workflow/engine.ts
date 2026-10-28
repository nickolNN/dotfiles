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
  MAX_SELF_RETRIES,
  SELF_RETRY_STEPS,
  SessionAddress,
  extractRepoNameFromUrl,
  maxExecutorsFor,
  nextStepDecision,
  parseStepReport,
  planExecutionMode,
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
import {
  iterationTarget,
  type RoomAgentInfo,
  type StepSessionRegistry,
} from '../pi/session-registry';
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
import {
  STEP_SYSTEM_APPEND,
  buildStepPrompt,
  type PrTarget,
} from './prompts';
import type { DevOpsAgent } from './devops';
import { runRoomResolve, runStagedResolve } from './room';
import { issueSessionDir, sessionDisplayName } from '../pi/session-paths';
import { soloRunExcludeTools } from '../pi/tool-policy';
import { stallRecoveries } from '../pi/stall-recovery';
import {
  resolveAgentStallTimeoutMs,
  resolveAgentTimeoutMs,
  withAgentStallGuard,
  withAgentTimeout,
} from './timeout';

const PIPELINE_STEP_ORDER: readonly PipelineStep[] = [
  'refine',
  'resolve',
  'review',
  'test',
  'pr',
];

export const canonicalStepOrder = (steps: PipelineStep[]): PipelineStep[] => {
  const unique = new Set(steps);
  return PIPELINE_STEP_ORDER.filter((step) => unique.has(step));
};

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
  control: StepSessionRegistry;
  local?: boolean;
  workspaceRoot?: string;
  onQuestionStatus?: (status: 'question' | 'running') => void;
  onIterationTerminal?: (outcome: IterationTerminalOutcome) => void;
}

export interface IterationTerminalOutcome {
  issueId: string;
  iterationId: string;
  issueTitle: string;
  iterationNumber: number;
  iterationStatus: 'completed' | 'failed';
  iterationCount: number;
  workspaceHostDir: string;
  workspaceContainerPath: string;
  containerName: string;
  repoPaths: string[];
  thinkingLevel?: ThinkingLevel;
  pipelineSteps: PipelineStep[];
}

export interface RunIterationInput {
  issue: {
    id: string;
    title: string;
    pipelineSteps: PipelineStep[];
    desiredResult?: DesiredResult;
  };
  iteration: Iteration;
  repositories: {
    repository_url: string;
    base_branch: string;
    create_mr?: boolean;
    bootstrap_enabled?: boolean;
  }[];
  model?: string;
  step_models?: StepModels;
  thinking_level?: ThinkingLevel;
  step_thinking_levels?: StepThinkingLevels;
  mrToken?: string;
  preparedRepoWorkspaces?: GitPrepareResult['repoWorkspaces'];
  description?: string;
  jiraText?: string | null;
  previousOutcome?: string | null;
  attachmentPaths?: string[];
  devServerPort?: number | null;
  agentTimeoutMs?: number;
  agentStallTimeoutMs?: number;
}

export interface RunIterationResult {
  iterationStatus: TaskStatus;
  needsInput: boolean;
}

const IMAGE = 'dotfiles-agent';
const MAX_ATTEMPTS = 3;

const STEP_REPORT_FILE = '.issue-step-result.json';

const SCREENSHOTS_DIR = 'screenshots';

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

export interface RunInstructionsPort {
  getStatus(repoUrl: string): RunInstructionsStatus | undefined;
  getInstructions(repoUrl: string): string | null;
  saveGenerated(repoUrl: string, instructions: string): void;
  saveFailed(repoUrl: string): void;
}

export type DevOpsFactory = (params: {
  containerName: string;
  hostWorkspaceDir: string;
  containerWorkspaceDir: string;
  issueId: string;
  iterationId?: string;
  stepRunId?: string;
  registry?: import('../pi/session-registry').StepSessionRegistry;
  tagInstructions?: string | null;
  model?: string;
  thinkingLevel?: ThinkingLevel;
  timeoutMs?: number;
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
  reposNames?: string | null;
  reposRequireDevServer?: string | null;
  reposInstructions?: string | null;
}) => DevOpsAgent;

export interface PrepareWorkspaceDeps {
  container: ContainerController;
  git: GitService;
  workspaceRoot?: string;
  local?: boolean;
  devops?: DevOpsFactory;
  runInstructions?: RunInstructionsPort;
  devopsModel?: string;
  devopsThinkingLevel?: ThinkingLevel;
  devopsTimeoutMs?: number;
  devServerPort?: number;
  onDevOpsStdout?: (repo: string, chunk: string) => void;
  onDevOpsStderr?: (repo: string, chunk: string) => void;
  issueId?: string;
  iterationId?: string;
  control?: import('../pi/session-registry').StepSessionRegistry;
  tagInstructions?: string | null;
  reposNames?: string | null;
  reposRequireDevServer?: string | null;
  reposInstructions?: string | null;
}

export type {
  WorkspaceProgress,
  WorkspaceProgressReporter,
  WorkspaceProgressStep,
} from '@issue-resolver/shared';

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

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
        onProgress?.({
          step: 'devops',
          repo: repoName,
          status: 'done',
          message: 'пропущен',
        });
        continue;
      }
      if (runInstructions.getStatus(workspace.repoUrl) === 'generated') {
        generatedRepos.push(workspace.repoUrl);
        onProgress?.({ step: 'checking_instructions', repo: repoName, status: 'done' });
        continue;
      }
      onProgress?.({ step: 'checking_instructions', repo: repoName, status: 'running' });
      onProgress?.({ step: 'devops', repo: repoName, status: 'running' });
      const devopsId = SessionAddress.forIssueRun(issue.id, 'devops').toString();
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

    if (deps.devServerPort !== undefined) {
      continue;
    }

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

export async function runIteration(
  deps: WorkflowDeps,
  input: RunIterationInput,
): Promise<RunIterationResult> {
  const { issue, iteration } = input;
  const workspaceRoot = deps.workspaceRoot ?? DEFAULT_WORKSPACE_ROOT;
  const containerName = containerNameFor(issue.id);
  const workspaceHostDir = workspaceHostDirFor(workspaceRoot, issue.id);
  const workspaceContainerPath = workspaceContainerDirFor(issue.id);

  const repoWorkspaces = input.preparedRepoWorkspaces ?? [];
  const repoPaths = repoWorkspaces.map((workspace) => workspace.path);
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
  let attempt = 1;
  let pipelineAttempt = 1;
  let stepRetries = 0;
  let feedback: string | null = null;
  let refinedPlan: string | null = null;
  let refinedExecution: ExecutionPlan | null = null;
  const agentTimeoutMs = input.agentTimeoutMs ?? resolveAgentTimeoutMs();
  const agentStallMs = input.agentStallTimeoutMs ?? resolveAgentStallTimeoutMs();
  const maxExecutors = maxExecutorsFor(iteration.worker_count);

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

    const stateDigest = await changeDigestOf(deps.git, repoPaths);
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
    let stepActivity = 0;
    const runOptions = {
      model,
      thinkingLevel,
      cwd: agentWorkingDir,
      iterationId: iteration.id,
      issueId: issue.id,
      registry: deps.control,
      timeoutMs: agentTimeoutMs,
      sessionDir: issueSessionDir(issue.id),
      systemAppend: STEP_SYSTEM_APPEND,
      sessionName: sessionDisplayName({
        step,
        issueId: issue.id,
        attempt: stepRun.attempt,
      }),
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
        if (event.type === 'question') {
          deps.onQuestionStatus?.('question');
          void deps.store
            .appendStepRunEvent(stepRun.id, event)
            .catch((error) =>
              console.error('workflow: failed to persist question event', error),
            );
        } else if (event.type === 'question_answered') {
          deps.onQuestionStatus?.('running');
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

    const reportsBefore = await stepReportMtimes(workspaceHostDir);

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
      const soloStepOptions =
        topology === 'room' || topology === 'stages'
          ? runOptions
          : { ...runOptions, excludeTools: soloRunExcludeTools() };
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
            {
              ...soloStepOptions,
              stepRunId: stepRun.id,
              sessionId: SessionAddress.forStepRun(stepRun.id).toString(),
            },
          ),
          agentTimeoutMs,
          `${step} agent`,
        );
      }
      result = await withAgentStallGuard(agentRun, {
        stallMs: agentStallMs,
        label: `${step} agent`,
        activity: () => stepActivity,
        recover: stallRecoveries({
          control: deps.control,
          target: iterationTarget(iteration.id),
          graceMs: agentStallMs,
        }),
        onStall: () => {
          void deps.control?.send(iterationTarget(iteration.id), {
            type: 'abort_retry',
          });
          deps.control?.abortByIteration(iteration.id);
        },
      });
    } catch (error) {
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

    const status: StepRunStatus = result.aborted
      ? 'aborted'
      : stepRunStatusFromResult(result.exitCode, report);
    await deps.store.updateStepRun(stepRun.id, { status });
    const screenshotsDir = await screenshotsDirOf(workspaceHostDir);

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
        const message = error instanceof Error ? error.message : String(error);
        console.error('publishPrResult failed', error);
        prPublish = { artifacts: [], errors: [{ repositoryUrl: '', message }] };
      }
    }

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

  void deps.onIterationTerminal?.(buildTerminalOutcome('completed'));
  return { iterationStatus: 'completed', needsInput: false };
}

export interface MrResultArtifact {
  repositoryUrl: string;
  mrUrl: string;
  title: string;
  description: string;
}

export function featureBranchName(
  issueTitle: string,
  issueId: string,
): string {
  const jiraMatch = /([A-Z]+-\d+)/.exec(issueTitle);
  const jiraKey = jiraMatch ? jiraMatch[1].toLowerCase() : null;

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

  return `${prefix}-${issueId.slice(-6)}`;
}

export interface PrPublishOutcome {
  artifacts: MrResultArtifact[];
  errors: PrPublishError[];
}

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

  const perRepoMap = new Map<string, { title: string; description: string }>();
  if (reportMrEntries) {
    for (const entry of reportMrEntries) {
      if (entry.repository_url && entry.title) {
        perRepoMap.set(entry.repository_url, entry);
      }
    }
  }

  if (repoWorkspaces.length === 0) {
    return { artifacts, errors };
  }

  for (const workspace of repoWorkspaces) {
    if (!createMrByUrl.get(workspace.repoUrl)) {
      continue;
    }
    const repoOverride = perRepoMap.get(workspace.repoUrl);
    const repoTitle = repoOverride?.title || title;
    const repoDescription = repoOverride?.description || description;
    let phase = 'commit/push';
    try {
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
      errors.push({
        repositoryUrl: workspace.repoUrl,
        message: `${workspace.repoUrl} — ${phase}: ${message}`,
      });
      break;
    }
  }

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
    }
  }

  return { artifacts, errors };
}
