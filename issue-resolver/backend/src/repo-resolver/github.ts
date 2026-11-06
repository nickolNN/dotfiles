import { numberOrNull, RepoPlatform } from '@issue-resolver/shared';
import type { RepoInfo } from '@issue-resolver/shared';
import {
  assertRepoResponse,
  chooseBranches,
  fetchBranchList,
  namesOf,
} from './http';
import { asRecord, requireRecord, requireString } from '../util/records';
import { boolOrNull, stringOrNull } from '../util/scalars';
import type { RepoResolver } from './types';
import { DEFAULT_GITHUB_HOST, githubOwnerRepo } from './url';

interface GitHubRepoResponse {
  full_name: string;
  default_branch: string;
  language: string | null;
  description: string | null;
  stargazers_count: number;
  private: boolean;
  clone_url: string;
  permissions?: { push?: boolean };
}

function githubRepo(value: unknown): GitHubRepoResponse {
  const raw = requireRecord(value, 'github repo response');
  const permissions = asRecord(raw.permissions);
  return {
    full_name: requireString(raw, 'full_name', 'github repo response'),
    default_branch: requireString(raw, 'default_branch', 'github repo response'),
    language: stringOrNull(raw.language),
    description: stringOrNull(raw.description),
    stargazers_count: numberOrNull(raw.stargazers_count) ?? 0,
    private: boolOrNull(raw.private) ?? false,
    clone_url: requireString(raw, 'clone_url', 'github repo response'),
    permissions: permissions
      ? { push: boolOrNull(permissions.push) ?? undefined }
      : undefined,
  };
}

export class GitHubResolver implements RepoResolver {
  constructor(
    private readonly token = '',
    private readonly host = DEFAULT_GITHUB_HOST,
  ) {}

  private apiBase(): string {
    return this.host === DEFAULT_GITHUB_HOST
      ? 'https://api.github.com'
      : `https://${this.host}/api/v3`;
  }

  private headers(): Record<string, string> {
    return {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'issue-resolver',
      ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
    };
  }

  async resolve(url: string): Promise<RepoInfo> {
    const { owner, repo } = githubOwnerRepo(url);
    const repoUrl = `${this.apiBase()}/repos/${owner}/${repo}`;
    const response = await fetch(repoUrl, { headers: this.headers() });

    assertRepoResponse(response, 'GitHub');

    const data = githubRepo(await response.json());

    const listed = await fetchBranchList(
      `${repoUrl}/branches?per_page=100`,
      { headers: this.headers() },
      namesOf,
    );

    const { defaultBranch, branches } = chooseBranches(
      data.default_branch,
      listed,
    );

    return {
      platform: RepoPlatform.github,
      fullName: data.full_name,
      defaultBranch,
      branches,
      language: data.language,
      description: data.description,
      stars: data.stargazers_count,
      isPrivate: data.private,
      cloneUrl: data.clone_url,
      writeAccess: data.permissions?.push === true,
    };
  }
}