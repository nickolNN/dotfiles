import { extractIssueKeyFromUrl, extractRepoNameFromUrl, RepoConnectionStatus, RunInstructionsStatus, TaskStatus, type Issue, type SavedRepo, DesiredResult } from '@issue-resolver/shared';
import { TASK_STATUSES } from './constants';
import { RepoReadiness } from './types';

export function isTaskStatus(value: unknown): value is TaskStatus {
  return typeof value === 'string' && TASK_STATUSES.has(value);
}

export function issueKey(issue: Issue): string {
  return (
    extractIssueKeyFromUrl(issue.jira_issue_url ?? '') ||
    issue.title.trim() ||
    issue.id
  );
}

export function repositoryNames(issue: Issue): string {
  return issue.repositories
    .map((repository) => {
      const name = extractRepoNameFromUrl(repository.repository_url);
      const branch = repository.branch_name?.trim();
      if (!name) return branch ?? '';
      return branch ? `${name}:${branch}` : name;
    })
    .filter((label) => label.length > 0)
    .join(' · ');
}

export function hasViewableResult(issue: Issue): boolean {
  return (
    issue.status === TaskStatus.completed &&
    (issue.desired_result === DesiredResult.md ||
      issue.desired_result === DesiredResult.html)
  );
}

export function showsRepoReadiness(issue: Issue): boolean {
  return (
    (issue.status === TaskStatus.pending ||
      issue.status === TaskStatus.preparing) &&
    issue.repositories.length > 0
  );
}

export function showsIssueStats(issue: Issue): boolean {
  return issue.status !== TaskStatus.pending;
}

export function repoReadiness(repo: SavedRepo | undefined): RepoReadiness {
  if (repo === undefined) return RepoReadiness.waiting;
  if (repo.connectionStatus === RepoConnectionStatus.error)
    return RepoReadiness.error;
  if (repo.connectionStatus === RepoConnectionStatus.ok) {
    return repo.runInstructionsStatus === RunInstructionsStatus.generated
      ? RepoReadiness.ready
      : RepoReadiness.connected;
  }
  return RepoReadiness.waiting;
}