import type { GitPrepareResult } from '../../git/service';

export interface BootstrapRepository {
  repository_url: string;
  base_branch: string;
  bootstrap_enabled?: boolean;
}

export type BootstrapGate = (workspace: {
  repoUrl: string;
  branch: string;
}) => boolean;

export function bootstrapGate(
  repositories: BootstrapRepository[],
): BootstrapGate {
  const byKey = new Map(
    repositories.map((repo) => [
      `${repo.repository_url}\u0000${repo.base_branch}`,
      repo.bootstrap_enabled !== false,
    ]),
  );
  const byUrl = new Map(
    repositories.map((repo) => [
      repo.repository_url,
      repo.bootstrap_enabled !== false,
    ]),
  );

  return (workspace) =>
    byKey.get(`${workspace.repoUrl}\u0000${workspace.branch}`) ??
    byUrl.get(workspace.repoUrl) ??
    true;
}

export type RepoWorkspaces = GitPrepareResult['repoWorkspaces'];