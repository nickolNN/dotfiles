import { WorkspaceProgressStep } from '@issue-resolver/shared';
import type { ContainerSpec, WorkspaceProgressReporter } from '@issue-resolver/shared';
import { WorkspaceProgressStatus } from '@issue-resolver/shared';
import { messageOf } from '../../util/errors';
import {
  containerNameFor,
  workspaceHostDirFor,
} from '../../workspace/paths';
import type { PrepareWorkspaceDeps } from './types';

export const AGENT_IMAGE = 'dotfiles-agent';

export function containerSpecFor(
  deps: PrepareWorkspaceDeps,
  issueId: string,
  workspaceHostDir: string,
  repositories: { repository_url: string }[],
): ContainerSpec {
  return {
    issueId,
    containerName: containerNameFor(issueId),
    image: AGENT_IMAGE,
    workspaceHostPath: workspaceHostDir,
    repoUrls: repositories.map((repo) => repo.repository_url),
    memoryVolumeName: process.env.ISSUE_RESOLVER_MEMORY_VOLUME || 'agent-memory',
  };
}

export async function spawnContainer(
  deps: PrepareWorkspaceDeps,
  spec: ContainerSpec,
  onProgress?: WorkspaceProgressReporter,
): Promise<void> {
  onProgress?.({
    step: WorkspaceProgressStep.creating_dirs,
    status: WorkspaceProgressStatus.running,
  });
  try {
    await deps.container.spawn(spec);
  } catch (error) {
    onProgress?.({
      step: WorkspaceProgressStep.creating_dirs,
      status: WorkspaceProgressStatus.error,
      message: messageOf(error),
    });
    throw error;
  }
  onProgress?.({ step: WorkspaceProgressStep.creating_dirs, status: WorkspaceProgressStatus.done });
}