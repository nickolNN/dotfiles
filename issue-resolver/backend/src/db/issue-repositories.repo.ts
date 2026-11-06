import { eq } from 'drizzle-orm';
import type { Db } from './client';
import { issueRepositories } from './schema';

export interface IssueRepositorySelection {
  repository_url: string;
  base_branch: string;
  create_mr: boolean;
  bootstrap_enabled: boolean;
}

export function listIssueRepositories(
  db: Db,
  issueId: string,
): IssueRepositorySelection[] {
  return db
    .select()
    .from(issueRepositories)
    .where(eq(issueRepositories.issue_id, issueId))
    .all()
    .map((repository) => ({
      repository_url: repository.repository_url,
      base_branch: repository.branch_name,
      create_mr: !!repository.create_mr,
      bootstrap_enabled: repository.bootstrap_enabled ?? true,
    }));
}