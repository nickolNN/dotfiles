import type {
  ExecutionPlan,
  NormalizedStage,
  RoomWorkItem,
  SessionEvent,
  SessionStats,
  StepExecutionResult,
} from '@issue-resolver/shared';
import {
  SessionAddress,
  clampExecutors,
  DEFAULT_MAX_ROOM_EXECUTORS,
  parseStepReport,
  planExecutionStages,
  planRoomWorkItems,
  sumSessionStats,
} from '@issue-resolver/shared';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PiRunner } from '../pi/runner';
import type { RoomAgentInfo, StepSessionRegistry } from '../pi/session-registry';
import {
  buildRoomCoordinatorPrompt,
  buildRoomWorkerPrompt,
  buildStageCoordinatorPrompt,
  buildStageSoloPrompt,
  buildStageWorkerPrompt,
  buildStagedFinalCoordinatorPrompt,
  type RoomPromptInput,
  type WorkerSummary,
} from './prompts';
import { readStageOutcomes } from './stage-outcomes';
import { resolveAgentTimeoutMs, withAgentTimeout } from './timeout';
import { issueSessionDir, sessionDisplayName } from '../pi/session-paths';
import { STEP_SYSTEM_APPEND } from './prompts';

export interface RoomResolveInput extends RoomPromptInput {
  containerName: string;
  execution: ExecutionPlan;
  maxExecutors?: number;
}

export interface RoomResolveOptions {
  hostWorkspaceDir?: string;
  model?: string;
  thinkingLevel?: string;
  cwd?: string;
  stepRunId: string;
  iterationId: string;
  issueId?: string;
  registry?: StepSessionRegistry;
  onStdout?: (chunk: string, agent: RoomAgentInfo) => void;
  onStderr?: (chunk: string, agent: RoomAgentInfo) => void;
  onEvent?: (event: SessionEvent, agent: RoomAgentInfo) => void;
  onWorkerStart?: (
    item: RoomWorkItem,
    total: number,
    agent: RoomAgentInfo,
  ) => void;
  timeoutMs?: number;
}

const workerAgent = (
  baseStepRunId: string,
  index: number,
  stage?: NormalizedStage,
): RoomAgentInfo =>
  stage
    ? {
        id: SessionAddress.forStepRun(baseStepRunId)
          .stageWorker(stage.index, index)
          .toString(),
        role: 'worker',
        index: index + 1,
        label: `Этап ${stage.index} · Исполнитель ${index + 1}`,
        stage: stage.index,
        stageName: stage.name,
      }
    : {
        id: SessionAddress.forStepRun(baseStepRunId).worker(index).toString(),
        role: 'worker',
        index: index + 1,
        label: `Исполнитель ${index + 1}`,
      };

const coordinatorAgent = (
  stepRunId: string,
  stage?: NormalizedStage,
): RoomAgentInfo =>
  stage
    ? {
        id: SessionAddress.forStepRun(stepRunId)
          .stageCoordinator(stage.index)
          .toString(),
        role: 'coordinator',
        index: null,
        label: `Этап ${stage.index} · Координатор`,
        stage: stage.index,
        stageName: stage.name,
      }
    : {
        id: stepRunId,
        role: 'coordinator',
        index: null,
        label: 'Координатор',
      };

const abortedResolveResult = (): StepExecutionResult => ({
  step: 'resolve',
  exitCode: 1,
  report: { status: 'fail', summary: 'aborted' },
  stdout: '',
  stderr: '',
  events: [],
  stats: null,
  aborted: true,
});

interface AgentRun {
  stepRunId: string;
  agent: RoomAgentInfo;
  prompt: string;
}

function runAgent(
  pi: PiRunner,
  input: RoomResolveInput,
  options: RoomResolveOptions,
  run: AgentRun,
): Promise<StepExecutionResult> {
  const timeoutMs = options.timeoutMs ?? resolveAgentTimeoutMs();
  const agentPromise = pi.run(input.containerName, run.prompt, {
    model: options.model,
    thinkingLevel: options.thinkingLevel,
    cwd: options.cwd,
    stepRunId: run.stepRunId,
    iterationId: options.iterationId,
    issueId: options.issueId,
    registry: options.registry,
    agent: run.agent,
    timeoutMs,
    ...(options.issueId
      ? {
          systemAppend: STEP_SYSTEM_APPEND,
          sessionDir: issueSessionDir(options.issueId),
          sessionName: sessionDisplayName({
            step: 'resolve',
            issueId: options.issueId,
            suffix: run.agent.label,
          }),
        }
      : {}),
    onStdout: (chunk) => options.onStdout?.(chunk, run.agent),
    onStderr: (chunk) => options.onStderr?.(chunk, run.agent),
    onEvent: (event) => options.onEvent?.(event, run.agent),
  });
  return withAgentTimeout(
    agentPromise,
    timeoutMs,
    `resolve agent ${run.agent.id}`,
  );
}

interface WorkerJob extends AgentRun {
  item: RoomWorkItem;
}

function agentSummary(
  result: StepExecutionResult,
  hostWorkspaceDir: string | undefined,
  fileName: string,
): string | null {
  const inline = result.report?.summary?.trim();
  if (inline) return inline;
  if (!hostWorkspaceDir) return null;
  try {
    const report = parseStepReport(
      readFileSync(join(hostWorkspaceDir, fileName), 'utf-8'),
    );
    const summary = report?.summary?.trim();
    return summary ? summary : null;
  } catch {
    return null;
  }
}

async function runWorkersParallel(
  pi: PiRunner,
  input: RoomResolveInput,
  options: RoomResolveOptions,
  jobs: WorkerJob[],
  total: number,
): Promise<StepExecutionResult[]> {
  return Promise.all(
    jobs.map((job) => {
      options.onWorkerStart?.(job.item, total, job.agent);
      return runAgent(pi, input, options, job);
    }),
  );
}

export async function runRoomResolve(
  pi: PiRunner,
  input: RoomResolveInput,
  options: RoomResolveOptions,
): Promise<StepExecutionResult> {
  const count = clampExecutors(
    input.execution,
    input.maxExecutors ?? DEFAULT_MAX_ROOM_EXECUTORS,
  );
  const workItems = planRoomWorkItems(input.execution, count);

  const jobs: WorkerJob[] = workItems.map((item) => {
    const agent = workerAgent(options.stepRunId, item.index);
    return {
      stepRunId: agent.id,
      agent,
      item,
      prompt: buildRoomWorkerPrompt(input, item, count),
    };
  });

  const workers = await runWorkersParallel(pi, input, options, jobs, count);

  if (workers.some((worker) => worker.aborted === true)) {
    return abortedResolveResult();
  }

  const summaries: WorkerSummary[] = workers.map((worker, index) => {
    const fileName = `.issue-worker-result-${index + 1}.json`;
    return {
      index: index + 1,
      summary:
        agentSummary(worker, options.hostWorkspaceDir, fileName) ??
        `(see ${fileName})`,
    };
  });

  const agent = coordinatorAgent(options.stepRunId);
  const result = await runAgent(pi, input, options, {
    stepRunId: agent.id,
    agent,
    prompt: buildRoomCoordinatorPrompt(input, summaries),
  });
  const total = sumSessionStats([
    ...workers.map((worker) => worker.stats),
    result.stats,
  ]);
  return { ...result, stats: total };
}

export async function runStagedResolve(
  pi: PiRunner,
  input: RoomResolveInput,
  options: RoomResolveOptions,
): Promise<StepExecutionResult> {
  const stages = planExecutionStages(
    input.execution,
    input.maxExecutors ?? DEFAULT_MAX_ROOM_EXECUTORS,
  );
  const resume = readStageOutcomes(options.hostWorkspaceDir, stages);
  const outcomes: { stage: NormalizedStage; outcome: string }[] = [
    ...resume.completed,
  ];
  const allStats: SessionStats[] = [];

  for (const stage of stages) {
    if (stage.index < resume.resumeIndex) continue;
    if (stage.executors >= 2) {
      const workItems: RoomWorkItem[] = stage.decomposition.map(
        (task, index) => ({ index, task }),
      );
      const jobs: WorkerJob[] = workItems.map((item) => {
        const agent = workerAgent(options.stepRunId, item.index, stage);
        return {
          stepRunId: agent.id,
          agent,
          item,
          prompt: buildStageWorkerPrompt(input, stage, item, stage.executors),
        };
      });

      const workers = await runWorkersParallel(
        pi,
        input,
        options,
        jobs,
        stage.executors,
      );
      workers.forEach((worker) => {
        if (worker.stats) allStats.push(worker.stats);
      });
      if (workers.some((worker) => worker.aborted === true)) {
        return abortedResolveResult();
      }

      const summaries: WorkerSummary[] = workers.map((worker, index) => {
        const fileName = `.issue-stage-${stage.index}-worker-${index + 1}.json`;
        return {
          index: index + 1,
          summary:
            agentSummary(worker, options.hostWorkspaceDir, fileName) ??
            `(see ${fileName})`,
        };
      });

      const agent = coordinatorAgent(options.stepRunId, stage);
      const result = await runAgent(pi, input, options, {
        stepRunId: agent.id,
        agent,
        prompt: buildStageCoordinatorPrompt(input, stage, summaries),
      });
      if (result.stats) allStats.push(result.stats);
      if (result.aborted === true) return abortedResolveResult();
      outcomes.push({
        stage,
        outcome:
          agentSummary(
            result,
            options.hostWorkspaceDir,
            `.issue-stage-${stage.index}.json`,
          ) ?? `(see .issue-stage-${stage.index}.json)`,
      });
      continue;
    }

    const agent = workerAgent(options.stepRunId, 0, stage);
    const result = await runAgent(pi, input, options, {
      stepRunId: agent.id,
      agent,
      prompt: buildStageSoloPrompt(input, stage),
    });
    if (result.stats) allStats.push(result.stats);
    if (result.aborted === true) return abortedResolveResult();
    outcomes.push({
      stage,
      outcome:
        agentSummary(
          result,
          options.hostWorkspaceDir,
          `.issue-stage-${stage.index}.json`,
        ) ?? `(see .issue-stage-${stage.index}.json)`,
    });
  }

  const agent = coordinatorAgent(options.stepRunId);
  const result = await runAgent(pi, input, options, {
    stepRunId: agent.id,
    agent,
    prompt: buildStagedFinalCoordinatorPrompt(input, outcomes),
  });
  const total = sumSessionStats([...allStats, result.stats]);
  return { ...result, stats: total };
}