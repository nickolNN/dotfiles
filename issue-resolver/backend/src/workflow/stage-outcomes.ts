import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseStepReport, type NormalizedStage } from '@issue-resolver/shared';

export interface StageOutcome {
  stage: NormalizedStage;
  outcome: string;
}

export interface StagedResume {
  completed: StageOutcome[];
  resumeIndex: number;
}

export function readStageOutcome(
  hostWorkspaceDir: string,
  stageIndex: number,
): string | null {
  try {
    const report = parseStepReport(
      readFileSync(
        join(hostWorkspaceDir, `.issue-stage-${stageIndex}.json`),
        'utf-8',
      ),
    );
    const summary = report?.summary?.trim();
    return summary ? summary : null;
  } catch {
    return null;
  }
}

export function readStageOutcomes(
  hostWorkspaceDir: string | undefined,
  stages: NormalizedStage[],
): StagedResume {
  if (!hostWorkspaceDir) return { completed: [], resumeIndex: 1 };
  const completed: StageOutcome[] = [];
  for (const stage of stages) {
    const outcome = readStageOutcome(hostWorkspaceDir, stage.index);
    if (outcome === null) {
      return { completed, resumeIndex: stage.index };
    }
    completed.push({ stage, outcome });
  }
  return { completed, resumeIndex: stages.length + 1 };
}