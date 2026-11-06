import { hostOf } from './git-host';
import { failureDetail } from './http-failure';
import type {
  MrComment,
  MrCreateInput,
  MrCreateResult,
  MrFindInput,
  MrUpdateInput,
} from './mr-types';
import { pathOfMrUrl } from './mr-url';
import { collectPages, MR_PAGE_SIZE } from './paged-http';
import { githubOwnerRepo } from '../repo-resolver/url';
import {
  requireArray,
  requireNumber,
  requireRecord,
  requireString,
} from '../util/records';

interface GitHubPrResponse {
  number: number;
  html_url: string;
}

function createdPr(value: unknown): GitHubPrResponse {
  const raw = requireRecord(value, 'github pr response');
  return {
    number: requireNumber(raw, 'number', 'github pr response'),
    html_url: requireString(raw, 'html_url', 'github pr response'),
  };
}

function prList(value: unknown): GitHubPrResponse[] {
  return requireArray(value, 'github pr list').map((entry) => {
    const raw = requireRecord(entry, 'github pr list entry');
    return {
      number: requireNumber(raw, 'number', 'github pr list entry'),
      html_url: requireString(raw, 'html_url', 'github pr list entry'),
    };
  });
}

function githubApiBase(host: string): string {
  return host === 'github.com'
    ? 'https://api.github.com'
    : `https://${host}/api/v3`;
}

function githubPullParts(
  mrUrl: string,
  repositoryUrl?: string,
): { owner: string; repo: string; number: string; host: string } {
  const host = hostOf(repositoryUrl || mrUrl);
  const path = pathOfMrUrl(mrUrl);
  const match = /\/([^/]+)\/([^/]+)\/pull\/(\d+)/.exec(path);
  if (match) {
    return {
      owner: decodeURIComponent(match[1]),
      repo: decodeURIComponent(match[2]).replace(/\.git$/, ''),
      number: match[3],
      host,
    };
  }
  const number = /\/pull\/(\d+)/.exec(path)?.[1];
  if (repositoryUrl && number) {
    const { owner, repo } = githubOwnerRepo(repositoryUrl);
    return { owner, repo, number, host };
  }
  throw new Error(
    `cannot parse github pr url: ${mrUrl} — ожидается https://{host}/{owner}/{repo}/pull/{number}`,
  );
}

export async function createGitHubMr(
  input: MrCreateInput,
  token: string,
): Promise<MrCreateResult> {
  const { owner, repo } = githubOwnerRepo(input.repositoryUrl);
  const apiBase = githubApiBase(hostOf(input.repositoryUrl));
  const response = await fetch(`${apiBase}/repos/${owner}/${repo}/pulls`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      head: input.headBranch,
      base: input.baseBranch,
      title: input.title,
      body: input.description,
    }),
  });
  if (!response.ok) {
    const detail = await failureDetail(response);
    throw new Error(
      `github pr failed: ${response.status} — POST /repos/${owner}/${repo}/pulls — ${detail}`,
    );
  }
  const data = createdPr(await response.json());
  return { mrUrl: data.html_url, id: String(data.number) };
}

export async function findGitHubOpenMr(
  input: MrFindInput,
  token: string,
): Promise<MrCreateResult | null> {
  const { owner, repo } = githubOwnerRepo(input.repositoryUrl);
  const apiBase = githubApiBase(hostOf(input.repositoryUrl));
  const res = await fetch(
    `${apiBase}/repos/${owner}/${repo}/pulls?head=${encodeURIComponent(`${owner}:${input.headBranch}`)}&base=${encodeURIComponent(input.baseBranch)}&state=open&per_page=1`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
      },
    },
  );
  if (!res.ok) return null;
  const data = prList(await res.json());
  if (data.length === 0) return null;
  return { mrUrl: data[0].html_url, id: String(data[0].number) };
}

export async function updateGitHubMr(
  input: MrUpdateInput,
  token: string,
): Promise<void> {
  const { owner, repo } = githubOwnerRepo(input.repositoryUrl);
  const apiBase = githubApiBase(hostOf(input.repositoryUrl));
  const response = await fetch(
    `${apiBase}/repos/${owner}/${repo}/pulls/${encodeURIComponent(input.mrId)}`,
    {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        title: input.title,
        body: input.description,
      }),
    },
  );
  if (!response.ok) {
    throw new Error(`github pr update failed: ${response.status}`);
  }
}

export async function fetchGitHubComments(
  mrUrl: string,
  token: string,
  repositoryUrl?: string,
): Promise<MrComment[]> {
  const { owner, repo, number, host } = githubPullParts(mrUrl, repositoryUrl);
  const apiBase = githubApiBase(host);

  const all: MrComment[] = [];
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
  };

  const reviewData = await collectPages<{
    path?: string;
    line?: number;
    body?: string;
    user?: { login?: string };
    created_at?: string;
  }>(
    `${apiBase}/repos/${owner}/${repo}/pulls/${number}/comments?per_page=${MR_PAGE_SIZE}&page=1`,
    headers,
    'github review comments',
  );
  for (const c of reviewData) {
    all.push({
      file: c.path ?? null,
      line: typeof c.line === 'number' ? c.line : null,
      body: c.body ?? '',
      author: c.user?.login ?? 'unknown',
      created_at: c.created_at ?? '',
    });
  }

  const issueData = await collectPages<{
    body?: string;
    user?: { login?: string };
    created_at?: string;
  }>(
    `${apiBase}/repos/${owner}/${repo}/issues/${number}/comments?per_page=${MR_PAGE_SIZE}&page=1`,
    headers,
    'github issue comments',
  );
  for (const c of issueData) {
    all.push({
      file: null,
      line: null,
      body: c.body ?? '',
      author: c.user?.login ?? 'unknown',
      created_at: c.created_at ?? '',
    });
  }

  return all;
}
