import { PipelineStep } from '@issue-resolver/shared';
import { buildStepPrompt } from './prompts';
import { reportModelFor, reportThinkingLevelFor } from './report-settings';
import { runReportAgent } from './report-run';
import { refreshLatestResultSnapshot } from './result-snapshot';
import {
  DEFAULT_WORKSPACE_ROOT,
  workspaceContainerDirFor,
  workspaceHostDirFor,
} from '../workspace/paths';
import type { Db } from '../db/client';
import type { IterationRunDeps } from './service-contracts';
import type { IterationTerminalOutcome } from './iteration/contracts';

export async function spawnReportAgent(
  db: Db,
  deps: IterationRunDeps,
  outcome: IterationTerminalOutcome,
): Promise<void> {
  const wsRoot = deps.workspaceRoot ?? DEFAULT_WORKSPACE_ROOT;
  const hostDir = workspaceHostDirFor(wsRoot, outcome.issueId);

  const prompt = buildStepPrompt({
    step: PipelineStep.report,
    issueTitle: outcome.issueTitle,
    description: '',
    jiraText: null,
    context: `Iteration #${outcome.iterationNumber} completed with status: ${outcome.iterationStatus}.`,
    feedback: null,
    repoPaths: outcome.repoPaths,
    iterationCount: outcome.iterationCount,
    workingDir: deps.local ? hostDir : workspaceContainerDirFor(outcome.issueId),
  });

  await runReportAgent({ ...deps, db }, {
    issueId: outcome.issueId,
    containerName: outcome.containerName,
    hostDir,
    prompt,
    model: reportModelFor(db, outcome.issueId, outcome.iterationId),
    thinkingLevel: reportThinkingLevelFor(db, outcome.issueId) ?? outcome.thinkingLevel,
    trigger: 'post-iteration',
  });
  try {
    await refreshLatestResultSnapshot(db, deps.workspaceRoot, outcome.issueId);
  } catch (error) {
    console.error('refresh report snapshot failed', error);
  }
}
