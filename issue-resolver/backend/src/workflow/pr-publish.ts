import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  detectGitHost,
  type PrPublishError,
} from '../pr/mr';
import { DEFAULT_WORKSPACE_ROOT, workspaceHostDirFor } from '../workspace/paths';
import type { GitPrepareResult } from '../git/service';
import type { RunIterationInput, WorkflowDeps } from './iteration/contracts';
import { streamEvent } from './sse-events';
import { messageOf } from '../util/errors';
import { SSEStream } from '@issue-resolver/shared';

export interface MrResultArtifact {
  repositoryUrl: string;
  mrUrl: string;
  title: string;
  description: string;
}

export function featureBranchName(
  issueTitle: string,
  issueId: string,
): string {
  const jiraMatch = /([A-Z]+-\d+)/.exec(issueTitle);
  const jiraKey = jiraMatch ? jiraMatch[1].toLowerCase() : null;

  const slug = issueTitle
    .replace(/([A-Z]+-\d+):?\s*/, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 50)
    .replace(/-+$/, '');

  const prefix = jiraKey
    ? `feature/${jiraKey}-${slug}`
    : `feature/${slug || 'changes'}`;

  return `${prefix}-${issueId.slice(-6)}`;
}

export interface PrPublishOutcome {
  artifacts: MrResultArtifact[];
  errors: PrPublishError[];
}

export async function publishPrResult(
  deps: WorkflowDeps,
  input: RunIterationInput,
  repoWorkspaces: GitPrepareResult['repoWorkspaces'],
  title: string,
  description: string,
  stepRunId: string,
  reportMrEntries?: readonly {
    repository_url: string;
    title: string;
    description: string;
  }[],
): Promise<PrPublishOutcome> {
  const baseBranchByUrl = new Map(
    input.repositories.map((repo) => [repo.repository_url, repo.base_branch]),
  );
  const createMrByUrl = new Map(
    input.repositories.map((repo) => [
      repo.repository_url,
      repo.create_mr ?? false,
    ]),
  );

  const artifacts: MrResultArtifact[] = [];
  const errors: PrPublishError[] = [];

  const perRepoMap = new Map<string, { title: string; description: string }>();
  if (reportMrEntries) {
    for (const entry of reportMrEntries) {
      if (entry.repository_url && entry.title) {
        perRepoMap.set(entry.repository_url, entry);
      }
    }
  }

  if (repoWorkspaces.length === 0) {
    return { artifacts, errors };
  }

  for (const workspace of repoWorkspaces) {
    if (!createMrByUrl.get(workspace.repoUrl)) {
      continue;
    }
    const repoOverride = perRepoMap.get(workspace.repoUrl);
    const repoTitle = repoOverride?.title || title;
    const repoDescription = repoOverride?.description || description;
    let phase = 'commit/push';
    try {
      const baseBranch =
        baseBranchByUrl.get(workspace.repoUrl) ?? workspace.branch;
      const featureBranch = featureBranchName(
        input.issue.title,
        input.issue.id,
      );
      const commit = await deps.git.commitAndPush({
        repoPath: workspace.path,
        branchName: featureBranch,
        commitMessage: `feat: ${input.issue.title}`,
        squashBase: `origin/${baseBranch}`,
      });
      deps.sse.publish(
        streamEvent(
          input.issue.id,
          input.iteration.id,
          stepRunId,
          SSEStream.system,
          `committed ${commit.branchName}`,
        ),
      );

      phase = 'MR';
      const source = detectGitHost(workspace.repoUrl);

      const existing = await deps.mr.findOpenMr({
        repositoryUrl: workspace.repoUrl,
        baseBranch:
          baseBranchByUrl.get(workspace.repoUrl) ?? workspace.branch,
        headBranch: featureBranch,
        token: input.mrToken ?? '',
        source,
      });

      let mrResult: { mrUrl: string; id: string };
      if (existing) {
        mrResult = existing;
        try {
          await deps.mr.updateMr({
            repositoryUrl: workspace.repoUrl,
            mrId: existing.id,
            title: repoTitle,
            description: repoDescription,
            token: input.mrToken ?? '',
            source,
          });
          deps.sse.publish(
            streamEvent(
              input.issue.id,
              input.iteration.id,
              stepRunId,
              SSEStream.mr,
              `заголовок и описание MR обновлены — ${existing.mrUrl}`,
            ),
          );
        } catch (error) {
          const message = messageOf(error);
          deps.sse.publish(
            streamEvent(
              input.issue.id,
              input.iteration.id,
              stepRunId,
              SSEStream.mr,
              `MR обновлён кодом, но текст обновить не удалось: ${message}`,
            ),
          );
        }
        deps.sse.publish(
          streamEvent(
            input.issue.id,
            input.iteration.id,
            stepRunId,
            SSEStream.system,
            `MR уже существует: ${existing.mrUrl} (новый push обновляет его)`,
          ),
        );
      } else {
        mrResult = await deps.mr.createMr({
          repositoryUrl: workspace.repoUrl,
          baseBranch:
            baseBranchByUrl.get(workspace.repoUrl) ?? workspace.branch,
          headBranch: featureBranch,
          title: repoTitle,
          description: repoDescription,
          token: input.mrToken ?? '',
          source,
        });
      }

      artifacts.push({
        repositoryUrl: workspace.repoUrl,
        mrUrl: mrResult.mrUrl,
        title: repoTitle,
        description: repoDescription,
      });
      deps.sse.publish(
        streamEvent(
          input.issue.id,
          input.iteration.id,
          stepRunId,
          SSEStream.mr,
          mrResult.mrUrl,
        ),
      );
    } catch (error) {
      const message = messageOf(error);
      errors.push({
        repositoryUrl: workspace.repoUrl,
        message: `${workspace.repoUrl} — ${phase}: ${message}`,
      });
      break;
    }
  }

  if (artifacts.length > 0) {
    try {
      const dir = workspaceHostDirFor(
        deps.workspaceRoot ?? DEFAULT_WORKSPACE_ROOT,
        input.issue.id,
      );
      await mkdir(dir, { recursive: true });
      await writeFile(
        join(dir, 'result.json'),
        JSON.stringify(
          {
            merge_requests: artifacts.map((a) => ({
              repository_url: a.repositoryUrl,
              url: a.mrUrl,
              title: a.title,
              message: a.description,
            })),
          },
          null,
          2,
        ),
      );
    } catch (error) {
      void error;
    }
  }

  return { artifacts, errors };
}