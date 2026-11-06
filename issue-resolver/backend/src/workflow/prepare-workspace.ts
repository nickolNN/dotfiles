import { WorkspaceProgressStep } from '@issue-resolver/shared';
import type { WorkspaceProgressReporter } from '@issue-resolver/shared';
import {
  WorkspaceProgressStatus,
  extractRepoNameFromUrl,
} from '@issue-resolver/shared';
import { messageOf } from '../util/errors';
import {
  DEFAULT_WORKSPACE_ROOT,
  workspaceHostDirFor,
} from '../workspace/paths';
import type { GitPrepareResult } from '../git/service';
import type { RunIterationInput } from './iteration/contracts';
import { bootstrapGate } from './prepare-workspace/bootstrap';
import { containerSpecFor, spawnContainer } from './prepare-workspace/container';
import { installAndServe } from './prepare-workspace/install';
import { prepareRunInstructions } from './prepare-workspace/instructions';
import type { PrepareContext, PrepareWorkspaceDeps } from './prepare-workspace/types';

export type {
  DevOpsFactory,
  PrepareWorkspaceDeps,
  RunInstructionsPort,
} from './prepare-workspace/types';
export type {
  WorkspaceProgress,
  WorkspaceProgressReporter,
  WorkspaceProgressStep,
} from './prepare-workspace/types';

export async function prepareWorkspace(
  deps: PrepareWorkspaceDeps,
  issue: { id: string },
  repositories: RunIterationInput['repositories'],
  onProgress?: WorkspaceProgressReporter,
): Promise<GitPrepareResult['repoWorkspaces']> {
  const workspaceRoot = deps.workspaceRoot ?? DEFAULT_WORKSPACE_ROOT;
  const workspaceHostDir = workspaceHostDirFor(workspaceRoot, issue.id);
  const spec = containerSpecFor(deps, issue.id, workspaceHostDir, repositories);

  await spawnContainer(deps, spec, onProgress);

  if (repositories.length === 0) {
    onProgress?.({
      step: WorkspaceProgressStep.checking_instructions,
      status: WorkspaceProgressStatus.running,
    });
    onProgress?.({
      step: WorkspaceProgressStep.checking_instructions,
      status: WorkspaceProgressStatus.done,
    });
    onProgress?.({ step: WorkspaceProgressStep.ready, status: WorkspaceProgressStatus.done });
    return [];
  }

  const prepared = await cloneRepositories(
    deps,
    workspaceHostDir,
    repositories,
    onProgress,
  );
  const ctx: PrepareContext = {
    deps,
    issueId: issue.id,
    workspaceHostDir,
    containerName: spec.containerName,
    spec,
  };
  const isBootstrapEnabled = bootstrapGate(repositories);

  const generatedRepos = await prepareRunInstructions(
    ctx,
    prepared.repoWorkspaces,
    isBootstrapEnabled,
    onProgress,
  );

  await installAndServe(
    ctx,
    prepared.repoWorkspaces,
    generatedRepos,
    isBootstrapEnabled,
    onProgress,
  );

  onProgress?.({ step: WorkspaceProgressStep.ready, status: WorkspaceProgressStatus.done });

  return prepared.repoWorkspaces;
}

async function cloneRepositories(
  deps: PrepareWorkspaceDeps,
  workspaceHostDir: string,
  repositories: RunIterationInput['repositories'],
  onProgress?: WorkspaceProgressReporter,
) {
  let currentRepo: string | null = null;
  try {
    return await deps.git.prepare({
      repoUrls: repositories.map((repo) => repo.repository_url),
      baseBranches: repositories.map((repo) => repo.base_branch),
      workspacePath: workspaceHostDir,
      onRepoProgress: (repoUrl, status) => {
        currentRepo = repoUrl;
        onProgress?.({
          step: WorkspaceProgressStep.cloning,
          repo: extractRepoNameFromUrl(repoUrl),
          status,
        });
      },
    });
  } catch (error) {
    onProgress?.({
      step: WorkspaceProgressStep.cloning,
      ...(currentRepo ? { repo: extractRepoNameFromUrl(currentRepo) } : {}),
      status: WorkspaceProgressStatus.error,
      message: messageOf(error),
    });
    throw error;
  }
}