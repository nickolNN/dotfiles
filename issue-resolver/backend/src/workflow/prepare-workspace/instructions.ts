import { WorkspaceProgressStep } from '@issue-resolver/shared';
import type { WorkspaceProgressReporter } from '@issue-resolver/shared';
import {
  PipelineStep,
  RunInstructionsStatus,
  SessionAddress,
  WorkspaceProgressStatus,
  extractRepoNameFromUrl,
} from '@issue-resolver/shared';
import { workspaceContainerDirFor } from '../../workspace/paths';
import type { BootstrapGate, RepoWorkspaces } from './bootstrap';
import type { PrepareContext } from './types';

export async function prepareRunInstructions(
  ctx: PrepareContext,
  prepared: RepoWorkspaces,
  isBootstrapEnabled: BootstrapGate,
  onProgress?: WorkspaceProgressReporter,
): Promise<string[]> {
  const { deps, issueId, workspaceHostDir, spec } = ctx;
  const generatedRepos: string[] = [];
  const runInstructions = deps.runInstructions;
  onProgress?.({
    step: WorkspaceProgressStep.checking_instructions,
    status: WorkspaceProgressStatus.running,
  });
  if (deps.devops && runInstructions) {
    const containerWorkspaceDir = deps.local
      ? workspaceHostDir
      : workspaceContainerDirFor(issueId);
    for (const workspace of prepared) {
      const repoName = extractRepoNameFromUrl(workspace.repoUrl);
      if (!isBootstrapEnabled(workspace)) {
        onProgress?.({
          step: PipelineStep.devops,
          repo: repoName,
          status: WorkspaceProgressStatus.done,
          message: 'пропущен',
        });
        continue;
      }
      if (
        runInstructions.getStatus(workspace.repoUrl) ===
        RunInstructionsStatus.generated
      ) {
        generatedRepos.push(workspace.repoUrl);
        onProgress?.({
          step: WorkspaceProgressStep.checking_instructions,
          repo: repoName,
          status: WorkspaceProgressStatus.done,
        });
        continue;
      }
      onProgress?.({
        step: WorkspaceProgressStep.checking_instructions,
        repo: repoName,
        status: WorkspaceProgressStatus.running,
      });
      onProgress?.({
        step: PipelineStep.devops,
        repo: repoName,
        status: WorkspaceProgressStatus.running,
      });
      const devopsId = SessionAddress.forIssueRun(issueId, PipelineStep.devops).toString();
      const devops = deps.devops({
        containerName: spec.containerName,
        hostWorkspaceDir: workspaceHostDir,
        containerWorkspaceDir,
        issueId,
        iterationId: deps.iterationId,
        stepRunId: devopsId,
        registry: deps.control,
        tagInstructions: deps.tagInstructions,
        reposNames: deps.reposNames,
        reposRequireDevServer: deps.reposRequireDevServer,
        reposInstructions: deps.reposInstructions,
        model: deps.devopsModel,
        thinkingLevel: deps.devopsThinkingLevel,
        timeoutMs: deps.devopsTimeoutMs,
        onStdout: (chunk) => deps.onDevOpsStdout?.(repoName, chunk),
        onStderr: (chunk) => deps.onDevOpsStderr?.(repoName, chunk),
        onEvent: (event) => deps.onDevOpsEvent?.(repoName, event),
      });
      const result = await devops.runDevOps(
        containerWorkspaceDir,
        workspace.repoUrl,
        repoName,
        deps.devServerPort,
      );
      if (result.success && result.instructions) {
        runInstructions.saveGenerated(workspace.repoUrl, result.instructions);
        generatedRepos.push(workspace.repoUrl);
        console.log(
          `run instructions for ${repoName}:\n${result.instructions}`,
        );
        onProgress?.({
          step: PipelineStep.devops,
          repo: repoName,
          status: WorkspaceProgressStatus.done,
          message: 'Инструкции сохранены',
        });
      } else {
        runInstructions.saveFailed(workspace.repoUrl);
        onProgress?.({
          step: PipelineStep.devops,
          repo: repoName,
          status: WorkspaceProgressStatus.error,
          message: result.error ?? 'не удалось сгенерировать инструкции',
        });
      }
    }
  }
  onProgress?.({
    step: WorkspaceProgressStep.checking_instructions,
    status: WorkspaceProgressStatus.done,
  });
  return generatedRepos;
}