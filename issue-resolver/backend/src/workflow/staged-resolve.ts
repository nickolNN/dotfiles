import type {
  NormalizedStage,
  SessionStats,
  StepExecutionResult,
  WorkerTask,
} from '@issue-resolver/shared';
import {
  DEFAULT_MAX_EXECUTORS,
  executionPlanProblem,
  planExecutionStages,
  sumSessionStats,
} from '@issue-resolver/shared';
import type { PiRunner } from '../pi/runner';
import type { WorkerSummary } from './prompts';
import {
  buildStageCoordinatorPrompt,
  buildStageSoloPrompt,
  buildStageWorkerPrompt,
  buildStagedFinalCoordinatorPrompt,
} from './prompts';
import { readStageOutcomes } from './stage-outcomes';
import { claimStageRun, stagePlanSignature } from './stage-run';
import {
  abortedResolveResult,
  coordinatorAgent,
  refusedResolveResult,
  runAgent,
  runWorkersParallel,
  stageOutcome,
  workerAgent,
  type WorkerJob,
} from './staged-resolve/agents';
import type { StagedResolveInput, StagedResolveOptions } from './staged-resolve/types';

export type { StagedResolveInput, StagedResolveOptions } from './staged-resolve/types';

export async function runStagedResolve(
  pi: PiRunner,
  input: StagedResolveInput,
  options: StagedResolveOptions,
): Promise<StepExecutionResult> {
  const maxExecutors = input.maxExecutors ?? DEFAULT_MAX_EXECUTORS;
  const problem = executionPlanProblem(input.execution, maxExecutors);
  if (problem) return refusedResolveResult(problem);
  const stages = planExecutionStages(input.execution, maxExecutors);
  const resumable = options.hostWorkspaceDir
    ? claimStageRun(
        options.hostWorkspaceDir,
        options.iterationId,
        stagePlanSignature(stages),
        stages.length,
      )
    : false;
  const resume = resumable
    ? readStageOutcomes(options.hostWorkspaceDir, stages)
    : { completed: [], resumeIndex: 1 };
  const outcomes: { stage: NormalizedStage; outcome: string }[] = [
    ...resume.completed,
  ];
  const allStats: SessionStats[] = [];
  const singleWave = stages.length === 1;
  let waveWorkers: WorkerSummary[] = [];

  const absorb = (result: StepExecutionResult): boolean => {
    if (result.stats) allStats.push(result.stats);
    return result.aborted === true;
  };

  for (const stage of stages) {
    if (stage.index < resume.resumeIndex) continue;
    if (stage.executors >= 2) {
      const workItems: WorkerTask[] = stage.decomposition.map(
        (task, index) => ({ index, task }),
      );
      const jobs: WorkerJob[] = workItems.map((item) => {
        const agent = workerAgent(options.stepRunId, item.index, stage);
        return {
          stepRunId: agent.id,
          agent,
          item,
          prompt: buildStageWorkerPrompt(
            input,
            stage,
            item,
            stage.executors,
            singleWave,
          ),
        };
      });

      const workers = await runWorkersParallel(
        pi,
        input,
        options,
        jobs,
        stage.executors,
      );
      for (const worker of workers) absorb(worker);
      if (workers.some((worker) => worker.aborted === true)) {
        return abortedResolveResult();
      }

      const summaries: WorkerSummary[] = workers.map((worker, index) => ({
        index: index + 1,
        summary: stageOutcome(
          worker,
          options.hostWorkspaceDir,
          `.issue-stage-${stage.index}-worker-${index + 1}`,
        ),
      }));

      if (singleWave) {
        waveWorkers = summaries;
        continue;
      }

      const agent = coordinatorAgent(options.stepRunId, stage);
      const result = await runAgent(pi, input, options, {
        stepRunId: agent.id,
        agent,
        prompt: buildStageCoordinatorPrompt(input, stage, summaries),
      });
      if (absorb(result)) return abortedResolveResult();
      outcomes.push({
        stage,
        outcome: stageOutcome(
          result,
          options.hostWorkspaceDir,
          `.issue-stage-${stage.index}`,
        ),
      });
      continue;
    }

    const agent = workerAgent(options.stepRunId, 0, stage);
    const result = await runAgent(pi, input, options, {
      stepRunId: agent.id,
      agent,
      prompt: buildStageSoloPrompt(input, stage),
    });
    if (absorb(result)) return abortedResolveResult();
    outcomes.push({
      stage,
      outcome: stageOutcome(
        result,
        options.hostWorkspaceDir,
        `.issue-stage-${stage.index}`,
      ),
    });
  }

  const agent = coordinatorAgent(options.stepRunId);
  const result = await runAgent(pi, input, options, {
    stepRunId: agent.id,
    agent,
    prompt: buildStagedFinalCoordinatorPrompt(
      input,
      singleWave
        ? { kind: 'wave', workers: waveWorkers }
        : { kind: 'stages', outcomes },
    ),
  });
  const total = sumSessionStats([...allStats, result.stats]);
  return { ...result, stats: total };
}