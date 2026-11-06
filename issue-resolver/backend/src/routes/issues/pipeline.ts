import { PipelineStep } from '@issue-resolver/shared';

const DEFAULT_STEPS: readonly PipelineStep[] = [
  PipelineStep.refine,
  PipelineStep.resolve,
];

export function resolvePipelineSteps(
  input: PipelineStep[] | undefined,
  createMr: boolean,
): PipelineStep[] {
  const steps = input && input.length > 0 ? input : DEFAULT_STEPS;
  return combineSteps([...new Set(steps)], createMr);
}

export function combineIterationSteps(
  input: PipelineStep[],
  createMr: boolean,
): PipelineStep[] {
  return combineSteps([...new Set(input)], createMr);
}

function combineSteps(
  input: PipelineStep[],
  createMr: boolean,
): PipelineStep[] {
  let steps = input;
  if (createMr && !steps.includes(PipelineStep.pr)) {
    steps = [...steps, PipelineStep.pr];
  }
  return steps;
}
