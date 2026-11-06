import { numberOrNull, RepoPlatform } from '@issue-resolver/shared';
import type { RepoInfo } from '@issue-resolver/shared';
import {
  assertRepoResponse,
  chooseBranches,
  fetchBranchList,
  namesOf,
} from './http';
import { asRecord, requireRecord, requireString } from '../util/records';
import { stringOrNull } from '../util/scalars';
import type { RepoResolver } from './types';
import { DEFAULT_GITLAB_HOST, repoPathOf } from './url';

interface GitLabRepoResponse {
  path_with_namespace: string;
  default_branch: string;
  language: string | null;
  description: string | null;
  star_count: number;
  visibility: string;
  http_url_to_repo: string;
  permissions?: {
    project_access?: { access_level?: number } | null;
  } | null;
}

function gitlabRepo(value: unknown): GitLabRepoResponse {
  const raw = requireRecord(value, 'gitlab repo response');
  const access = asRecord(asRecord(raw.permissions)?.project_access);
  return {
    path_with_namespace: requireString(
      raw,
      'path_with_namespace',
      'gitlab repo response',
    ),
    default_branch: stringOrNull(raw.default_branch) ?? '',
    language: stringOrNull(raw.language),
    description: stringOrNull(raw.description),
    star_count: numberOrNull(raw.star_count) ?? 0,
    visibility: stringOrNull(raw.visibility) ?? '',
    http_url_to_repo: requireString(
      raw,
      'http_url_to_repo',
      'gitlab repo response',
    ),
    permissions:
      raw.permissions === undefined
        ? undefined
        : {
            project_access: access
              ? { access_level: numberOrNull(access.access_level) ?? undefined }
              : null,
          },
  };
}

export class GitLabResolver implements RepoResolver {
  constructor(
    private readonly token = '',
    private readonly host = DEFAULT_GITLAB_HOST,
  ) {}

  private headers(): Record<string, string> {
    return {
      ...(this.token ? { 'PRIVATE-TOKEN': this.token } : {}),
    };
  }

  async resolve(url: string): Promise<RepoInfo> {
    const path = repoPathOf(url);
    const projectUrl = `https://${this.host}/api/v4/projects/${encodeURIComponent(path)}`;
    const response = await fetch(projectUrl, { headers: this.headers() });

    assertRepoResponse(response, 'GitLab');

    const data = gitlabRepo(await response.json());

    const listed = await fetchBranchList(
      `${projectUrl}/repository/branches?per_page=100`,
      { headers: this.headers() },
      namesOf,
    );

    const { defaultBranch, branches } = chooseBranches(
      data.default_branch,
      listed,
    );

    return {
      platform: RepoPlatform.gitlab,
      fullName: data.path_with_namespace,
      defaultBranch,
      branches,
      language: data.language,
      description: data.description,
      stars: data.star_count,
      isPrivate: data.visibility !== 'public',
      cloneUrl: data.http_url_to_repo,
      writeAccess: (data.permissions?.project_access?.access_level ?? 0) >= 30,
    };
  }
}