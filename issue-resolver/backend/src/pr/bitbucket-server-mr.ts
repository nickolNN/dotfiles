import type {
  MrComment,
  MrCreateInput,
  MrCreateResult,
  MrFindInput,
  MrUpdateInput,
} from './mr-types';
import { hostOf } from './git-host';
import { failureDetail } from './http-failure';
import { bitbucketMrWebUrl } from './mr-url';
import { BITBUCKET_PAGES, collectPages, MR_PAGE_SIZE } from './paged-http';
import { bitbucketProjectRepo } from '../repo-resolver/url';
import { numberOrNull } from '@issue-resolver/shared';

import { asRecord, requireRecord } from '../util/records';
import { stringOrNull } from '../util/scalars';

interface BitbucketServerLinks {
  self?: Array<{ href?: string }>;
}

interface BitbucketServerPrPayload {
  id: number | null;
  links?: BitbucketServerLinks;
}

function serverLinks(value: unknown): BitbucketServerLinks | undefined {
  const raw = asRecord(value);
  if (!raw || raw.self === undefined) return undefined;
  const self = Array.isArray(raw.self)
    ? raw.self.flatMap((entry) => {
        const href = stringOrNull(asRecord(entry)?.href);
        return href === null ? [] : [{ href }];
      })
    : [];
  return { self };
}

function serverPr(value: unknown): BitbucketServerPrPayload {
  const raw = requireRecord(value, 'bitbucket pr response');
  return {
    id: numberOrNull(raw.id),
    links: serverLinks(raw.links),
  };
}

export interface BitbucketServerTarget {
  host: string;
  project: string;
  repo: string;
  id: string;
}

function isoDateOf(value: number | string | undefined): string {
  if (value === undefined || value === '') return '';
  if (typeof value === 'string' && !/^\d+$/.test(value)) return value;
  const ms = Number(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : String(value);
}

export async function findBitbucketServerOpenMr(
  input: MrFindInput,
  token: string,
): Promise<MrCreateResult | null> {
  const { project, repo } = bitbucketProjectRepo(input.repositoryUrl);
  const host = hostOf(input.repositoryUrl);
  const url = `https://${host}/rest/api/1.0/projects/${encodeURIComponent(project)}/repos/${encodeURIComponent(repo)}/pull-requests?state=OPEN&limit=${MR_PAGE_SIZE}`;
  type PrListEntry = {
    id: number;
    fromRef?: { id?: string };
    toRef?: { id?: string };
    links?: BitbucketServerLinks;
  };
  let values: PrListEntry[];
  try {
    values = await collectPages<PrListEntry>(
      url,
      { Authorization: `Bearer ${token}` },
      'bitbucket pr list',
      BITBUCKET_PAGES,
    );
  } catch {
    return null;
  }
  const match = values.find(
    (pr) =>
      pr.fromRef?.id === `refs/heads/${input.headBranch}` &&
      pr.toRef?.id === `refs/heads/${input.baseBranch}`,
  );
  if (!match) return null;
  return {
    mrUrl: bitbucketMrWebUrl(
      host,
      project,
      repo,
      String(match.id),
      match.links,
    ),
    id: String(match.id),
  };
}

export async function fetchBitbucketServerComments(
  target: BitbucketServerTarget,
  token: string,
): Promise<MrComment[]> {
  const { host, project, repo, id } = target;
  const apiPath = `/rest/api/1.0/projects/${encodeURIComponent(project)}/repos/${encodeURIComponent(repo)}/pull-requests/${id}/activities`;

  type Anchor = {
    path?: string;
    line?: number;
    lineSrc?: number;
    lineTgt?: number;
  };
  type RawAuthor = { name?: string; displayName?: string };
  type RawComment = {
    text?: string;
    author?: RawAuthor;
    createdDate?: number | string;
    pending?: boolean;
    deleted?: boolean;
    state?: string;
    comments?: RawComment[];
    anchors?: { line?: Anchor } | null;
    anchor?: Anchor | null;
  };
  type RawActivity = RawComment & {
    action?: string;
    commentAction?: string;
    comment?: RawComment;
    commentAnchor?: Anchor | null;
  };
  const activities = await collectPages<RawActivity>(
    `https://${host}${apiPath}?limit=500&start=0`,
    { Authorization: `Bearer ${token}` },
    'bitbucket comments',
    BITBUCKET_PAGES,
  );

  const isDeleted = (c: RawComment) =>
    c.pending === true || c.deleted === true || c.state === 'DELETED';
  const authorOf = (c: RawComment) =>
    c.author?.displayName ?? c.author?.name ?? 'unknown';

  const comments: MrComment[] = [];
  for (const a of activities) {
    if (a.action !== 'COMMENTED' && a.action !== 'COMMENT') continue;
    if (a.commentAction === 'DELETED') continue;
    const c: RawComment = a.comment ?? a;
    if (isDeleted(c)) continue;
    const anchor = a.commentAnchor ?? c.anchors?.line ?? c.anchor;
    const comment: MrComment = {
      file: anchor?.path ?? null,
      line: anchor?.line ?? anchor?.lineTgt ?? anchor?.lineSrc ?? null,
      body: c.text ?? '',
      author: authorOf(c),
      created_at: isoDateOf(c.createdDate),
    };
    comments.push(comment);
    for (const reply of c.comments ?? []) {
      if (isDeleted(reply)) continue;
      comments.push({
        file: comment.file,
        line: comment.line,
        body: reply.text ?? '',
        author: authorOf(reply),
        created_at: isoDateOf(reply.createdDate),
      });
    }
  }
  return comments;
}

export async function updateBitbucketServerMr(
  input: MrUpdateInput,
  token: string,
): Promise<void> {
  const { project, repo } = bitbucketProjectRepo(input.repositoryUrl);
  const host = hostOf(input.repositoryUrl);
  const apiBase = `https://${host}/rest/api/1.0/projects/${project}/repos/${repo}/pull-requests/${encodeURIComponent(input.mrId)}`;
  const current = await fetch(apiBase, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!current.ok) {
    throw new Error(`bitbucket pr read failed: ${current.status}`);
  }
  const { version } = (await current.json()) as { version?: number };
  const response = await fetch(apiBase, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      title: input.title,
      description: input.description,
      version,
    }),
  });
  if (!response.ok) {
    const detail = await failureDetail(response);
    throw new Error(
      `bitbucket pr update failed: ${response.status} — ${detail}`,
    );
  }
}

export async function createBitbucketServerMr(
  input: MrCreateInput,
  token: string,
): Promise<MrCreateResult> {
  const { project, repo } = bitbucketProjectRepo(input.repositoryUrl);
  const host = hostOf(input.repositoryUrl);
  const createPath = `/rest/api/1.0/projects/${project}/repos/${repo}/pull-requests`;
  const response = await fetch(`https://${host}${createPath}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      title: input.title,
      description: input.description,
      fromRef: { id: input.headBranch },
      toRef: { id: input.baseBranch },
    }),
  });
  if (response.status === 409) {
    const existing = await resolveBitbucketDuplicate(input, token, response);
    if (existing) return existing;
  }
  if (!response.ok) {
    const detail = await failureDetail(response);
    throw new Error(
      `bitbucket pr failed: ${response.status} — POST ${createPath} — ${detail}`,
    );
  }
  const data = serverPr(await response.json());
  if (data.id === null) {
    throw new Error('bitbucket pr response: no pull request id');
  }
  return {
    mrUrl: bitbucketMrWebUrl(
      host,
      project,
      repo,
      String(data.id),
      data.links,
    ),
    id: String(data.id),
  };
}

async function resolveBitbucketDuplicate(
  input: MrCreateInput,
  token: string,
  response: Response,
): Promise<MrCreateResult | null> {
  const { project, repo } = bitbucketProjectRepo(input.repositoryUrl);
  const host = hostOf(input.repositoryUrl);
  const base = `https://${host}/rest/api/1.0/projects/${project}/repos/${repo}/pull-requests`;

  const open = await findBitbucketServerOpenMr(input, token);
  if (open) return open;

  const body = await response.text().catch(() => '');
  const idFromError =
    /"existingPullRequest"\s*:\s*\{[^}]*"id"\s*:\s*(\d+)/i.exec(body)?.[1] ??
    /"pullRequestId"\s*:\s*(\d+)/i.exec(body)?.[1];
  if (!idFromError) return null;

  const pr = await fetch(`${base}/${idFromError}`, {
    headers: { Authorization: `Bearer ${token}` },
  }).catch(() => null);
  if (!pr?.ok) return null;
  const data = serverPr(await pr.json());
  const id = data.id === null ? idFromError : String(data.id);
  return {
    mrUrl: bitbucketMrWebUrl(host, project, repo, id, data.links),
    id,
  };
}
