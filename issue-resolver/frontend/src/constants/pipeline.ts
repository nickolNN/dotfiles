import { PipelineStep } from '@issue-resolver/shared';

export const PIPELINE_ORDER: readonly PipelineStep[] = [
  PipelineStep.refine,
  PipelineStep.resolve,
  PipelineStep.review,
  PipelineStep.test,
  PipelineStep.pr,
];