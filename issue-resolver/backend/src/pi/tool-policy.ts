
import { PipelineStep } from '@issue-resolver/shared';

export const ROOM_TOOL_PATTERNS: string[] = ['room_*'];

export function soloRunExcludeTools(): string[] {
  return [...ROOM_TOOL_PATTERNS];
}

export function readOnlyStep(step: PipelineStep): boolean {
  return step === PipelineStep.review;
}
