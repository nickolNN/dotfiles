import { WorkspaceProgressStep } from '@issue-resolver/shared';
import type { WorkspaceProgressReporter } from '@issue-resolver/shared';
import { WorkspaceProgressStatus, extractRepoNameFromUrl } from '@issue-resolver/shared';
import type { DevServerStartResult } from '../../git/service';
import { messageOf } from '../../util/errors';
import type { BootstrapGate, RepoWorkspaces } from './bootstrap';
import type { PrepareContext } from './types';

export async function installAndServe(
  ctx: PrepareContext,
  prepared: RepoWorkspaces,
  generatedRepos: string[],
  isBootstrapEnabled: BootstrapGate,
  onProgress?: WorkspaceProgressReporter,
): Promise<void> {
  const { deps } = ctx;
  const runInstructions = deps.runInstructions;

  for (const workspace of prepared) {
    const repoName = extractRepoNameFromUrl(workspace.repoUrl);
    if (!isBootstrapEnabled(workspace)) {
      onProgress?.({
        step: WorkspaceProgressStep.installing,
        repo: repoName,
        status: WorkspaceProgressStatus.done,
        message: 'пропущен',
      });
      continue;
    }
    onProgress?.({
      step: WorkspaceProgressStep.installing,
      repo: repoName,
      status: WorkspaceProgressStatus.running,
    });
    try {
      await deps.git.installDependencies([workspace.path]);
    } catch (error) {
      for (const repoUrl of generatedRepos) {
        runInstructions?.saveFailed(repoUrl);
      }
      onProgress?.({
        step: WorkspaceProgressStep.installing,
        repo: repoName,
        status: WorkspaceProgressStatus.error,
        message: messageOf(error),
      });
      throw error;
    }
    onProgress?.({
      step: WorkspaceProgressStep.installing,
      repo: repoName,
      status: WorkspaceProgressStatus.done,
    });

    if (deps.devServerPort !== undefined) {
      continue;
    }

    onProgress?.({
      step: WorkspaceProgressStep.dev_server,
      repo: repoName,
      status: WorkspaceProgressStatus.running,
    });
    const instructionsText =
      runInstructions?.getInstructions(workspace.repoUrl) ?? null;
    let devStart: DevServerStartResult;
    try {
      devStart = await deps.git.startDevServer(workspace.path, instructionsText);
    } catch (error) {
      devStart = { port: null, message: messageOf(error) };
    }
    if (devStart.port === null) {
      onProgress?.({
        step: WorkspaceProgressStep.dev_server,
        repo: repoName,
        status: WorkspaceProgressStatus.warning,
        message: devStart.message ?? 'не удалось определить порт',
      });
    } else {
      onProgress?.({
        step: WorkspaceProgressStep.dev_server,
        repo: repoName,
        status: WorkspaceProgressStatus.done,
        message: `localhost:${devStart.port}`,
        devPort: devStart.port,
      });
    }
  }
}