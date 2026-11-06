import type { Issue, SavedRepo } from '@issue-resolver/shared';
import {
  REPO_READINESS_COLORS,
  REPO_READINESS_ICONS,
  REPO_READINESS_LABELS,
  REPO_READINESS_ORDER,
} from './constants';
import { repoReadiness } from './format';
import { RepoReadiness } from './types';

function readinessCounts(
  issue: Issue,
  savedRepos: SavedRepo[],
): Record<RepoReadiness, number> {
  const counts: Record<RepoReadiness, number> = {
    [RepoReadiness.ready]: 0,
    [RepoReadiness.connected]: 0,
    [RepoReadiness.waiting]: 0,
    [RepoReadiness.error]: 0,
  };
  for (const repository of issue.repositories) {
    const url = repository.repository_url.trim();
    const saved = savedRepos.find(
      (repo) => typeof repo.url === 'string' && repo.url.trim() === url,
    );
    counts[repoReadiness(saved)] += 1;
  }
  return counts;
}

export default function RepoReadinessLine({
  issue,
  savedRepos,
}: {
  issue: Issue;
  savedRepos: SavedRepo[] | null;
}) {
  if (savedRepos === null || issue.repositories.length === 0) return null;

  const counts = readinessCounts(issue, savedRepos);

  return (
    <div
      data-testid="repo-readiness"
      className="mb-1.5 flex flex-wrap items-center gap-x-2 text-xs text-[#00FF41]/80"
    >
      <span className="text-[#00FF41]/60">📦 репо:</span>{' '}
      {REPO_READINESS_ORDER.filter(
        (status) => status !== RepoReadiness.error || counts.error > 0,
      ).map((status, index) => (
        <span
          key={status}
          data-testid={`repo-readiness-${status}`}
          data-count={counts[status]}
          title={`${REPO_READINESS_LABELS[status]}: ${counts[status]}`}
          className="whitespace-nowrap"
        >
          {index > 0 && ' '}
          <span style={{ color: REPO_READINESS_COLORS[status] }}>
            {REPO_READINESS_ICONS[status]}
          </span>
          {counts[status]}
        </span>
      ))}
    </div>
  );
}