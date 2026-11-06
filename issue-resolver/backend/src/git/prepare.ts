import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { WorkspaceProgressStatus } from '@issue-resolver/shared';
import type { GitContext } from './exec';
import { gitCachePath, repoName, rmIndexLock } from './paths';
import type { GitPrepareInput, GitPrepareResult } from './types';

export async function prepareRepos(
  ctx: GitContext,
  originalsRoot: string,
  input: GitPrepareInput,
): Promise<GitPrepareResult> {
  await mkdir(input.workspacePath, { recursive: true });
  const repoWorkspaces: GitPrepareResult['repoWorkspaces'] = [];

  for (let i = 0; i < input.repoUrls.length; i += 1) {
    const repoUrl = input.repoUrls[i];
    const baseBranch = input.baseBranches[i] ?? 'main';
    input.onRepoProgress?.(repoUrl, WorkspaceProgressStatus.running);

    const repoPath = path.join(input.workspacePath, repoName(repoUrl));

    if (existsSync(path.join(repoPath, '.git'))) {
      repoWorkspaces.push({ repoUrl, path: repoPath, branch: baseBranch });
      input.onRepoProgress?.(repoUrl, WorkspaceProgressStatus.done);
      continue;
    }

    const cachePath = gitCachePath(originalsRoot, repoUrl);

    if (!existsSync(cachePath)) {
      await mkdir(originalsRoot, { recursive: true });
      await ctx.git(['clone', '--bare', repoUrl, cachePath]);
    } else {
      await ctx
        .git([
          '-C',
          cachePath,
          'fetch',
          '--prune',
          'origin',
          '+refs/heads/*:refs/heads/*',
        ])
        .catch(() => undefined);
    }

    await ctx.git(['clone', '--branch', baseBranch, cachePath, repoPath]);
    await ctx.git(['-C', repoPath, 'remote', 'set-url', 'origin', repoUrl]);
    await ctx.git(['-C', repoPath, 'config', 'core.longpaths', 'true']);
    await rmIndexLock(repoPath);
    await ctx.git(['-C', repoPath, 'pull', '--ff-only', 'origin', baseBranch]);

    repoWorkspaces.push({ repoUrl, path: repoPath, branch: baseBranch });
    input.onRepoProgress?.(repoUrl, WorkspaceProgressStatus.done);
  }

  return { repoWorkspaces };
}