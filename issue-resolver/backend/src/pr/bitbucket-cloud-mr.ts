import type {
  MrComment,
  MrCreateInput,
  MrCreateResult,
  MrFindInput,
  MrUpdateInput,
} from './mr-types';
import {
  bitbucketCloudMrWebUrl,
  bitbucketCloudParts,
} from './mr-url';
import { errorDetail, failureDetail } from './http-failure';
import {
  apiPathOf,
  BITBUCKET_CLOUD_API,
  BITBUCKET_PAGES,
  collectPages,
  MR_PAGE_SIZE,
} from './paged-http';
import { bitbucketProjectRepo } from '../repo-resolver/url';

export async function findBitbucketCloudOpenMr(
  input: MrFindInput,
  token: string,
): Promise<MrCreateResult | null> {
  const { project: workspace, repo } = bitbucketProjectRepo(
    input.repositoryUrl,
  );
  const url = `${BITBUCKET_CLOUD_API}/repositories/${encodeURIComponent(workspace)}/${encodeURIComponent(repo)}/pullrequests?state=OPEN&pagelen=${MR_PAGE_SIZE}`;
  const values = await collectPages<{
    id?: number;
    html_url?: string;
    source?: { branch?: { name?: string } };
    destination?: { branch?: { name?: string } };
  }>(
    url,
    { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    'bitbucket pr list',
    BITBUCKET_PAGES,
  );
  const match = values.find(
    (pr) =>
      pr.source?.branch?.name === input.headBranch &&
      pr.destination?.branch?.name === input.baseBranch,
  );
  if (!match || match.id === undefined) return null;
  return {
    mrUrl: bitbucketCloudMrWebUrl(match.html_url, workspace, repo, String(match.id)),
    id: String(match.id),
  };
}

export async function updateBitbucketCloudMr(
  input: MrUpdateInput,
  token: string,
): Promise<void> {
  const { project: workspace, repo } = bitbucketProjectRepo(
    input.repositoryUrl,
  );
  const url = `${BITBUCKET_CLOUD_API}/repositories/${encodeURIComponent(workspace)}/${encodeURIComponent(repo)}/pullrequests/${encodeURIComponent(input.mrId)}`;
  const response = await fetch(url, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
    },
    body: JSON.stringify({ title: input.title, summary: input.description }),
  });
  if (!response.ok) {
    const detail = await failureDetail(response);
    throw new Error(
      `bitbucket cloud pr update failed: ${response.status} — PUT ${apiPathOf(url)} — ${detail}`,
    );
  }
}

export async function createBitbucketCloudMr(
  input: MrCreateInput,
  token: string,
): Promise<MrCreateResult> {
  const { project: workspace, repo } = bitbucketProjectRepo(
    input.repositoryUrl,
  );
  const url = `${BITBUCKET_CLOUD_API}/repositories/${encodeURIComponent(workspace)}/${encodeURIComponent(repo)}/pullrequests`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
    },
    body: JSON.stringify({
      title: input.title,
      summary: input.description,
      source: {
        branch: { name: input.headBranch },
        repository: { full_name: `${workspace}/${repo}` },
      },
      destination: { branch: { name: input.baseBranch } },
    }),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    if (response.status === 409 || /already exists/i.test(body)) {
      const existing = await findBitbucketCloudOpenMr(input, token);
      if (existing) return existing;
    }
    throw new Error(
      `bitbucket cloud pr failed: ${response.status} — POST ${apiPathOf(url)} — ${errorDetail(body)}`,
    );
  }
  const data = (await response.json()) as {
    id?: number;
    html_url?: string;
  };
  const id = String(data.id ?? '');
  return {
    mrUrl: bitbucketCloudMrWebUrl(data.html_url, workspace, repo, id),
    id,
  };
}

export async function fetchBitbucketCloudComments(
  mrUrl: string,
  token: string,
  repositoryUrl?: string,
): Promise<MrComment[]> {
  const { workspace, repo, id } = bitbucketCloudParts(mrUrl, repositoryUrl);
  const url = `${BITBUCKET_CLOUD_API}/repositories/${encodeURIComponent(workspace)}/${encodeURIComponent(repo)}/pullrequests/${id}/comments?pagelen=${MR_PAGE_SIZE}`;
  type RawCloudComment = {
    content?: { raw?: string; markup?: string };
    user?: { display_name?: string; account?: string };
    created_on?: string;
    inline?: { path?: string; from?: number; to?: number } | null;
    deleted?: unknown;
    pending?: unknown;
    comments?: RawCloudComment[];
  };
  const raw = await collectPages<RawCloudComment>(
    url,
    { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    'bitbucket comments',
    BITBUCKET_PAGES,
  );
  const comments: MrComment[] = [];
  const pushComment = (
    c: RawCloudComment,
    anchor?: RawCloudComment['inline'],
  ) => {
    if (c.deleted || c.pending) return;
    const inline = c.inline ?? anchor;
    comments.push({
      file: inline?.path ?? null,
      line: inline?.to ?? inline?.from ?? null,
      body: c.content?.raw ?? c.content?.markup ?? '',
      author: c.user?.display_name ?? c.user?.account ?? 'unknown',
      created_at: c.created_on ?? '',
    });
  };
  for (const c of raw) {
    pushComment(c);
    for (const reply of c.comments ?? []) pushComment(reply, c.inline);
  }
  return comments;
}
