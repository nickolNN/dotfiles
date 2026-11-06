import type {
  DesiredResult,
  NormalizedStage,
  PipelineStep,
  WorkerTask,
} from '@issue-resolver/shared';
import type { RepoChangeDigest } from '../../git/service';
import { resolveDownstreamAwareness, workerDownstreamAwareness } from './downstream';
import {
  attachmentsBlock,
  outputContract,
  previousOutcomeBlock,
  refinedPlanBlock,
  reposBlock,
  taskContext,
  withSharedFragments,
  workingFolderBlock,
  workingStateBlock,
  type PrTarget,
} from './fragments';
import { readPrompt, render } from './loader';

export interface StagePromptInput {
  issueTitle: string;
  description: string;
  jiraText: string | null;
  context: string;
  feedback: string | null;
  refinedPlan: string | null;
  repoPaths: string[];
  desiredResult?: DesiredResult;
  previousOutcome?: string | null;
  attachmentPaths?: string[];
  pipelineSteps?: PipelineStep[];
  devServerPort?: number | null;
  prTargets?: PrTarget[];
  stateDigest?: RepoChangeDigest[];
  workingDir?: string;
}

export interface WorkerSummary {
  index: number;
  summary: string;
}

function stageValues(
  input: StagePromptInput,
  extra: Record<string, string> = {},
): Record<string, string> {
  return {
    TASK_CONTEXT: taskContext(input),
    REPOS: [
      reposBlock(input.repoPaths, input.devServerPort, {
        preparedNote: true,
        prTargets: input.prTargets,
      }),
      workingFolderBlock(input.workingDir),
    ]
      .filter((block) => block.length > 0)
      .join('\n\n'),
    REFINED_PLAN: refinedPlanBlock(input.refinedPlan),
    ATTACHMENTS: attachmentsBlock(input.attachmentPaths),
    WORKING_STATE: workingStateBlock(input.stateDigest),
    PREVIOUS_OUTCOME: previousOutcomeBlock(input.previousOutcome),
    DOWNSTREAM_AWARENESS: resolveDownstreamAwareness(input.pipelineSteps).join('\n'),
    ...extra,
  };
}

function workerSummariesBlock(
  files: (index: number) => string,
  workers: WorkerSummary[],
): string {
  if (workers.length === 0) return '';
  return workers
    .map((worker) => `- worker ${worker.index} → \`${files(worker.index)}\`: ${worker.summary}`)
    .join('\n');
}

export function buildStageWorkerPrompt(
  input: StagePromptInput,
  stage: NormalizedStage,
  item: WorkerTask,
  total: number,
  singleWave = false,
): string {
  const worker = item.index + 1;
  return withSharedFragments(
    render(readPrompt('resolve-stages-worker.md'), {
      ...stageValues(input),
      STAGE_INDEX: String(stage.index),
      STAGE_NAME: stage.name,
      STAGE_TASK: stage.task,
      WORKER_INDEX: String(worker),
      TOTAL_WORKERS: String(total),
      WORKER_TASK: item.task,
      DECISION_NOTE: singleWave
        ? 'The final lead alone makes the pass/fail decision — never you, and there is no stage coordinator for this wave.'
        : 'The stage coordinator and the final lead alone make pass/fail decisions — never you.',
      STAGE_CONTEXT: singleWave
        ? 'This is the only stage: the other workers of this wave run at the same moment, each in its own area, and the final lead integrates your reports.'
        : 'Your stage builds on the stages before it: read their outcome files (`.issue-stage-<i>.json`) before changing code they touch.',
      INTEGRATOR: singleWave ? 'the final lead' : 'the stage coordinator',
      DOWNSTREAM_AWARENESS: workerDownstreamAwareness(input.pipelineSteps).join('\n'),
    }),
  );
}

export function buildStageCoordinatorPrompt(
  input: StagePromptInput,
  stage: NormalizedStage,
  workers: WorkerSummary[],
): string {
  const summaries = workerSummariesBlock(
    (index) => `.issue-stage-${stage.index}-worker-${index}.json`,
    workers,
  );
  return withSharedFragments(
    render(readPrompt('resolve-stages-lead.md'), {
      ...stageValues(input),
      STAGE_INDEX: String(stage.index),
      STAGE_NAME: stage.name,
      STAGE_TASK: stage.task,
      WORKER_SUMMARIES:
        summaries ||
        'There are no worker agents for this stage: perform the stage task YOURSELF\nand produce the stage result directly.',
    }),
  );
}

export function buildStageSoloPrompt(
  input: StagePromptInput,
  stage: NormalizedStage,
): string {
  return withSharedFragments(
    render(readPrompt('resolve-stages-solo.md'), {
      ...stageValues(input),
      STAGE_INDEX: String(stage.index),
      STAGE_NAME: stage.name,
      STAGE_TASK: stage.task,
    }),
  );
}

export type ResolveIntegration =
  | { kind: 'stages'; outcomes: { stage: NormalizedStage; outcome: string }[] }
  | { kind: 'wave'; workers: WorkerSummary[] };

export function buildStagedFinalCoordinatorPrompt(
  input: StagePromptInput,
  integration: ResolveIntegration,
): string {
  const section =
    integration.kind === 'wave'
      ? [
          '## Wave workers',
          '',
          'This stage had no separate coordinator: the workers below ARE the stage.',
          'Integrate their reports directly, then verify the result end to end.',
          '',
          workerSummariesBlock(
            (index) => `.issue-stage-1-worker-${index}.json`,
            integration.workers,
          ),
        ].join('\n')
      : [
          '## Stage outcomes',
          '',
          integration.outcomes
            .map(
              ({ stage, outcome }) =>
                `- stage ${stage.index} (${stage.name}) → \`.issue-stage-${stage.index}.json\`: ${outcome}`,
            )
            .join('\n') ||
            'No stage reports: perform the resolve task YOURSELF and produce the step result directly.',
        ].join('\n');
  return withSharedFragments(
    `${render(
      readPrompt('resolve-stages-final.md'),
      stageValues(input, { OUTCOMES: section }),
    )}\n\n${outputContract(input.workingDir)}`,
  );
}