import type { ThinkingLevel } from '../status';

export const PipelineStep = Object.freeze({
  refine: 'refine',
  resolve: 'resolve',
  review: 'review',
  test: 'test',
  pr: 'pr',
  report: 'report',
  devops: 'devops',
} as const);
export type PipelineStep =
  (typeof PipelineStep)[keyof typeof PipelineStep];

export type StepModels = Partial<Record<PipelineStep, string>>;

export type StepThinkingLevels = Partial<Record<PipelineStep, ThinkingLevel>>;