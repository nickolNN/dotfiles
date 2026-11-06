import { join } from 'node:path';
import { readTextFileOrNull } from '../../util/files';
import type {
  NormalizedStage,
  StepExecutionResult,
  WorkerTask,
} from '@issue-resolver/shared';
import {
  PipelineStep,
  SessionAddress,
  StepAgentRole,
  StepReportStatus,
  parseStepReport,
} from '@issue-resolver/shared';
import type { PiRunner } from '../../pi/runner';
import { issueSessionDir, sessionDisplayName } from '../../pi/session-paths';
import type { StepAgentInfo } from '../../pi/session-registry';
import { STEP_SYSTEM_APPEND } from '../prompts';
import { resolveAgentTimeoutMs, withAgentTimeout } from '../timeout';
import type { StagedResolveInput, StagedResolveOptions } from './types';

export const workerAgent = (
  baseStepRunId: string,
  index: number,
  stage: NormalizedStage,
): StepAgentInfo => ({
  id: SessionAddress.forStepRun(baseStepRunId)
    .stageWorker(stage.index, index)
    .toString(),
  role: StepAgentRole.worker,
  index: index + 1,
  label: `Этап ${stage.index} · Исполнитель ${index + 1}`,
  stage: stage.index,
  stageName: stage.name,
});

export const coordinatorAgent = (
  stepRunId: string,
  stage?: NormalizedStage,
): StepAgentInfo =>
  stage
    ? {
        id: SessionAddress.forStepRun(stepRunId)
          .stageCoordinator(stage.index)
          .toString(),
        role: StepAgentRole.coordinator,
        index: null,
        label: `Этап ${stage.index} · Координатор`,
        stage: stage.index,
        stageName: stage.name,
      }
    : {
        id: stepRunId,
        role: StepAgentRole.coordinator,
        index: null,
        label: 'Координатор',
      };

export const abortedResolveResult = (): StepExecutionResult => ({
  step: PipelineStep.resolve,
  exitCode: 1,
  report: { status: StepReportStatus.fail, summary: 'aborted' },
  stdout: '',
  stderr: '',
  events: [],
  stats: null,
  aborted: true,
});

export const refusedResolveResult = (
  summary: string,
): StepExecutionResult => ({
  step: PipelineStep.resolve,
  exitCode: 1,
  report: { status: StepReportStatus.fail, summary },
  stdout: '',
  stderr: '',
  events: [],
  stats: null,
});

export interface AgentRun {
  stepRunId: string;
  agent: StepAgentInfo;
  prompt: string;
}

export interface WorkerJob extends AgentRun {
  item: WorkerTask;
}

export function runAgent(
  pi: PiRunner,
  input: StagedResolveInput,
  options: StagedResolveOptions,
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
            step: PipelineStep.resolve,
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

function agentSummary(
  result: StepExecutionResult,
  hostWorkspaceDir: string | undefined,
  fileName: string,
): string | null {
  const inline = result.report?.summary?.trim();
  if (inline) return inline;
  if (!hostWorkspaceDir) return null;
  const text = readTextFileOrNull(join(hostWorkspaceDir, fileName));
  if (text === null) return null;
  const summary = parseStepReport(text)?.summary?.trim();
  return summary ? summary : null;
}

export function stageOutcome(
  result: StepExecutionResult,
  hostWorkspaceDir: string | undefined,
  fileBase: string,
): string {
  const fileName = `${fileBase}.json`;
  return agentSummary(result, hostWorkspaceDir, fileName) ?? `(see ${fileName})`;
}

export async function runWorkersParallel(
  pi: PiRunner,
  input: StagedResolveInput,
  options: StagedResolveOptions,
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