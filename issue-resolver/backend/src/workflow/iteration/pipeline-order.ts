import { PipelineStep } from '@issue-resolver/shared';

const PIPELINE_STEP_ORDER: readonly PipelineStep[] = [
  PipelineStep.refine,
  PipelineStep.resolve,
  PipelineStep.review,
  PipelineStep.test,
  PipelineStep.pr,
];

export const canonicalStepOrder = (steps: PipelineStep[]): PipelineStep[] => {
  const unique = new Set(steps);
  return PIPELINE_STEP_ORDER.filter((step) => unique.has(step));
};