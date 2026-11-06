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
import { repoPathOf as gitlabProjectPath } from '../repo-resolver/url';
import {
  requireArray,
  requireNumber,
  requireRecord,
  requireString,
} from '../util/records';

interface GitLabMrResponse {
  iid: number;
  web_url: string;
}

function createdMr(value: unknown): GitLabMrResponse {
  const raw = requireRecord(value, 'gitlab mr response');
  return {
    iid: requireNumber(raw, 'iid', 'gitlab mr response'),
    web_url: requireString(raw, 'web_url', 'gitlab mr response'),
  };
}

function mrList(value: unknown): GitLabMrResponse[] {
  return requireArray(value, 'gitlab mr list').map((entry) => {
    const raw = requireRecord(entry, 'gitlab mr list entry');
    return {
      iid: requireNumber(raw, 'iid', 'gitlab mr list entry'),
      web_url: requireString(raw, 'web_url', 'gitlab mr list entry'),
    };
  });
}

export async function createGitLabMr(
  input: MrCreateInput,
  token: string,
): Promise<MrCreateResult> {
  const path = gitlabProjectPath(input.repositoryUrl);
  const host = hostOf(input.repositoryUrl);
  const response = await fetch(
    `https://${host}/api/v4/projects/${encodeURIComponent(path)}/merge_requests`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'PRIVATE-TOKEN': token,
      },
      body: JSON.stringify({
        source_branch: input.headBranch,
        target_branch: input.baseBranch,
        title: input.title,
        description: input.description,
      }),
    },
  );
  if (!response.ok) {
    const detail = await failureDetail(response);
    throw new Error(
      `gitlab mr failed: ${response.status} — POST /projects/${encodeURIComponent(path)}/merge_requests — ${detail}`,
    );
  }
  const data = createdMr(await response.json());
  return { mrUrl: data.web_url, id: String(data.iid) };
}

export async function findGitLabOpenMr(
  input: MrFindInput,
  token: string,
): Promise<MrCreateResult | null> {
  const path = gitlabProjectPath(input.repositoryUrl);
  const host = hostOf(input.repositoryUrl);
  const res = await fetch(
    `https://${host}/api/v4/projects/${encodeURIComponent(path)}/merge_requests?source_branch=${encodeURIComponent(input.headBranch)}&target_branch=${encodeURIComponent(input.baseBranch)}&state=opened&per_page=1`,
    { headers: { 'PRIVATE-TOKEN': token } },
  );
  if (!res.ok) return null;
  const data = mrList(await res.json());
  if (data.length === 0) return null;
  return { mrUrl: data[0].web_url, id: String(data[0].iid) };
}

export async function updateGitLabMr(
  input: MrUpdateInput,
  token: string,
): Promise<void> {
  const path = gitlabProjectPath(input.repositoryUrl);
  const host = hostOf(input.repositoryUrl);
  const response = await fetch(
    `https://${host}/api/v4/projects/${encodeURIComponent(path)}/merge_requests/${encodeURIComponent(input.mrId)}`,
    {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'PRIVATE-TOKEN': token,
      },
      body: JSON.stringify({
        title: input.title,
        description: input.description,
      }),
    },
  );
  if (!response.ok) {
    throw new Error(`gitlab mr update failed: ${response.status}`);
  }
}

export async function fetchGitLabComments(
  mrUrl: string,
  token: string,
  repositoryUrl?: string,
): Promise<MrComment[]> {
  const host = hostOf(repositoryUrl || mrUrl);
  const path = pathOfMrUrl(mrUrl);
  const full = /\/([^/]+(?:\/[^/]+)*)\/-\/merge_requests\/(\d+)/.exec(path);
  let projectPath: string | null = full ? full[1] : null;
  let iid: string | undefined = full?.[2];
  if (!projectPath && repositoryUrl) {
    const bare = /\/merge_requests\/(\d+)/.exec(path)?.[1];
    if (bare) {
      projectPath = gitlabProjectPath(repositoryUrl);
      iid = bare;
    }
  }
  if (!projectPath || !iid) {
    throw new Error(
      `cannot parse gitlab mr url: ${mrUrl} — ожидается https://{host}/{group}/{project}/-/merge_requests/{iid}`,
    );
  }
  const data = await collectPages<{
    body?: string;
    author?: { name?: string };
    created_at?: string;
    position?: { new_path?: string; new_line?: number };
    system?: boolean;
  }>(
    `https://${host}/api/v4/projects/${encodeURIComponent(projectPath)}/merge_requests/${iid}/notes?sort=asc&per_page=${MR_PAGE_SIZE}&page=1`,
    { 'PRIVATE-TOKEN': token },
    'gitlab notes',
  );

  return data
    .filter((c) => !c.system)
    .map((c) => ({
      file: c.position?.new_path ?? null,
      line: c.position?.new_line ?? null,
      body: c.body ?? '',
      author: c.author?.name ?? 'unknown',
      created_at: c.created_at ?? '',
    }));
}
