import type { Db } from '../../db/client';
import { getRepository } from '../../db/repositories.repo';

export interface RepositoryInput {
  repo_id?: string;
  repository_url?: string;
  base_branch?: string;
}

export interface ResolvedRepositoryInput {
  repositoryUrl?: string;
  baseBranch?: string;
}

export function resolveRepositoryInput(
  db: Db,
  repository: RepositoryInput,
): ResolvedRepositoryInput | null {
  let repositoryUrl = repository.repository_url;
  let baseBranch = repository.base_branch;
  if (repository.repo_id) {
    const saved = getRepository(db, repository.repo_id);
    if (!saved) return null;
    repositoryUrl = saved.cloneUrl ?? saved.url;
    baseBranch = baseBranch ?? saved.defaultBranch ?? undefined;
  }
  return { repositoryUrl, baseBranch };
}