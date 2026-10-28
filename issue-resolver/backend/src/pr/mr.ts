
export interface MrCreateInput {
  repositoryUrl: string;
  baseBranch: string;
  headBranch: string;
  title: string;
  description: string;
  token: string;
  source: 'gitlab' | 'github' | 'bitbucket';
}

export interface MrCreateResult {
  mrUrl: string;
  id: string;
}

export interface MrUpdateInput {
  repositoryUrl: string;
  mrId: string;
  title: string;
  description: string;
  token: string;
  source: 'gitlab' | 'github' | 'bitbucket';
}

export interface MrComment {
  file: string | null;
  line: number | null;
  body: string;
  author: string;
  created_at: string;
}

export interface MrFetchCommentsInput {
  mrUrl: string;
  token: string;
  repositoryUrl?: string;
}

export interface MrFindInput {
  repositoryUrl: string;
  headBranch: string;
  baseBranch: string;
  token: string;
  source: 'gitlab' | 'github' | 'bitbucket';
}

export interface MrClient {
  createMr(input: MrCreateInput): Promise<MrCreateResult>;
  fetchComments(input: MrFetchCommentsInput): Promise<MrComment[]>;
  findOpenMr(input: MrFindInput): Promise<MrCreateResult | null>;
  updateMr(input: MrUpdateInput): Promise<void>;
}

export interface PrPublishError {
  repositoryUrl: string;
  message: string;
}

export function formatPrPublishErrors(errors: PrPublishError[]): string {
  return errors.map((error) => error.message).join('; ');
}

export interface MrTokens {
  gitlab?: string;
  github?: string;
  bitbucket?: string;
}

export function hostOf(repositoryUrl: string): string {
  const trimmed = repositoryUrl.trim();
  if (!trimmed) throw new Error('unknown git host');

  const sshMatch = /^[^@/]+@([^:/]+)[:/]/.exec(trimmed);
  if (sshMatch) return sshMatch[1].toLowerCase();

  try {
    return new URL(trimmed).hostname.toLowerCase();
  } catch {
    throw new Error('unknown git host');
  }
}

export function detectGitHost(
  repositoryUrl: string,
  mrUrl = '',
): 'gitlab' | 'github' | 'bitbucket' {
  const host = hostOf(repositoryUrl);
  if (host.includes('github')) return 'github';
  if (host.includes('gitlab')) return 'gitlab';
  const isBitbucketPrPath = (url: string) =>
    /\/projects\/[^/]+\/repos\/[^/]+\/pull-requests\//.test(
      bitbucketPullPath(url),
    );
  if (
    host.includes('bitbucket') ||
    host.includes('stash') ||
    /\/scm\//.test(repositoryUrl) ||
    isBitbucketPrPath(repositoryUrl) ||
    isBitbucketPrPath(mrUrl)
  ) {
    return 'bitbucket';
  }
  throw new Error('unknown git host');
}

export class FakeMrClient implements MrClient {
  readonly calls: MrCreateInput[] = [];
  private pendingError: Error | null = null;

  reviewComments: MrComment[] = [];

  failNextWith(err: Error): void {
    this.pendingError = err;
  }

  async fetchComments(_input: MrFetchCommentsInput): Promise<MrComment[]> {
    return [...this.reviewComments];
  }

  openMrs: Array<{
    repositoryUrl: string;
    headBranch: string;
    baseBranch: string;
    mrUrl: string;
  }> = [];

  async findOpenMr(input: MrFindInput): Promise<MrCreateResult | null> {
    const found = this.openMrs.find(
      (mr) =>
        mr.repositoryUrl === input.repositoryUrl &&
        mr.headBranch === input.headBranch &&
        mr.baseBranch === input.baseBranch,
    );
    return found ? { mrUrl: found.mrUrl, id: found.mrUrl } : null;
  }

  readonly updateCalls: MrUpdateInput[] = [];
  private pendingUpdateError: Error | null = null;

  failNextUpdateWith(err: Error): void {
    this.pendingUpdateError = err;
  }

  async updateMr(input: MrUpdateInput): Promise<void> {
    this.updateCalls.push(input);
    if (this.pendingUpdateError) {
      const err = this.pendingUpdateError;
      this.pendingUpdateError = null;
      throw err;
    }
  }

  async createMr(input: MrCreateInput): Promise<MrCreateResult> {
    if (this.pendingError) {
      const err = this.pendingError;
      this.pendingError = null;
      throw err;
    }
    this.calls.push(input);
    const id = `mr-${this.calls.length}`;
    if (input.source === 'bitbucket') {
      const { project, repo } = bitbucketProjectRepo(input.repositoryUrl);
      return {
        mrUrl: `https://${hostOf(input.repositoryUrl)}/projects/${project}/repos/${repo}/pull-requests/${id}`,
        id,
      };
    }
    if (input.source === 'github') {
      const { owner, repo } = githubOwnerRepo(input.repositoryUrl);
      return {
        mrUrl: `https://${hostOf(input.repositoryUrl)}/${owner}/${repo}/pull/${id}`,
        id,
      };
    }
    const webBase = input.repositoryUrl
      .replace(/^[^@/]+@/, 'https://')
      .replace(/:/, '/')
      .replace(/\.git$/, '');
    return { mrUrl: `${webBase}/-/merge_requests/${id}`, id };
  }
}

interface GitLabMrResponse {
  iid: number;
  web_url: string;
}

interface GitHubPrResponse {
  number: number;
  html_url: string;
}

interface BitbucketPrResponse {
  id: number;
  links?: { self?: Array<{ href?: string }> };
}

function bitbucketPullPath(mrUrl: string): string {
  try {
    return new URL(mrUrl.trim()).pathname;
  } catch {
    return mrUrl;
  }
}

function bitbucketProjectRepoFromMrUrl(mrUrl: string): {
  project: string;
  repo: string;
  id: string;
} {
  const path = bitbucketPullPath(mrUrl);
  const match =
    /\/projects\/([^/]+)\/repos\/([^/]+)\/pull-requests\/(\d+)(?=\/|$)/.exec(
      path,
    );
  if (!match) {
    throw new Error(
      `cannot parse bitbucket pr url: ${mrUrl} — expected "projects/<PROJECT>/repos/<REPO>/pull-requests/<ID>" anywhere in the path`,
    );
  }
  return { project: match[1], repo: match[2], id: match[3] };
}

export class HttpMrClient implements MrClient {
  constructor(
    private readonly token = '',
    private readonly tokens: MrTokens = {},
  ) {}

  async fetchComments(input: MrFetchCommentsInput): Promise<MrComment[]> {
    const source = detectGitHost(input.repositoryUrl || input.mrUrl, input.mrUrl);
    const token = input.token || this.tokens[source] || this.token;

    if (source === 'github') {
      return this.fetchGitHubComments(input.mrUrl, token, input.repositoryUrl);
    }
    if (source === 'gitlab') {
      return this.fetchGitLabComments(input.mrUrl, token, input.repositoryUrl);
    }
    return this.fetchBitbucketComments(input.mrUrl, token, input.repositoryUrl);
  }

  async findOpenMr(input: MrFindInput): Promise<MrCreateResult | null> {
    const token = input.token || this.tokens[input.source] || this.token;

    if (input.source === 'gitlab') {
      return this.findGitLabOpenMr(input, token);
    }
    if (input.source === 'github') {
      return this.findGitHubOpenMr(input, token);
    }
    if (isBitbucketCloudHost(hostOf(input.repositoryUrl))) {
      return this.findBitbucketCloudOpenMr(input, token);
    }
    return this.findBitbucketServerOpenMr(input, token);
  }

  private async findBitbucketCloudOpenMr(
    input: MrFindInput,
    token: string,
  ): Promise<MrCreateResult | null> {
    const { project: workspace, repo } = bitbucketProjectRepo(
      input.repositoryUrl,
    );
    const url = `${BITBUCKET_CLOUD_API}/repositories/${encodeURIComponent(workspace)}/${encodeURIComponent(repo)}/pullrequests?state=OPEN&pagelen=${MR_PAGE_SIZE}`;
    const values = await this.collectPagedValues<{
      id?: number;
      html_url?: string;
      source?: { branch?: { name?: string } };
      destination?: { branch?: { name?: string } };
    }>(url, { Authorization: `Bearer ${token}`, Accept: 'application/json' }, 'bitbucket pr list');
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

  private async findGitLabOpenMr(
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
    const data = (await res.json()) as Array<{ iid: number; web_url: string }>;
    if (data.length === 0) return null;
    return { mrUrl: data[0].web_url, id: String(data[0].iid) };
  }

  private async findGitHubOpenMr(
    input: MrFindInput,
    token: string,
  ): Promise<MrCreateResult | null> {
    const { owner, repo } = githubOwnerRepo(input.repositoryUrl);
    const host = hostOf(input.repositoryUrl);
    const apiBase =
      host === 'github.com'
        ? 'https://api.github.com'
        : `https://${host}/api/v3`;
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
    const data = (await res.json()) as Array<{
      number: number;
      html_url: string;
    }>;
    if (data.length === 0) return null;
    return { mrUrl: data[0].html_url, id: String(data[0].number) };
  }

  private async findBitbucketServerOpenMr(
    input: MrFindInput,
    token: string,
  ): Promise<MrCreateResult | null> {
    const { project, repo } = bitbucketProjectRepo(input.repositoryUrl);
    const host = hostOf(input.repositoryUrl);
    const res = await fetch(
      `https://${host}/rest/api/1.0/projects/${project}/repos/${repo}/pull-requests?direction=OUTGOING&at=refs/heads/${encodeURIComponent(input.baseBranch)}&state=OPEN`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    if (!res.ok) return null;
    const data = (await res.json()) as {
      values?: Array<{
        id: number;
        fromRef?: { id?: string };
        links?: { self?: Array<{ href?: string }> };
      }>;
    };
    if (!data.values || data.values.length === 0) return null;
    const match = data.values.find(
      (pr) => pr.fromRef?.id === `refs/heads/${input.headBranch}`,
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

  private async fetchGitHubComments(
    mrUrl: string,
    token: string,
    repositoryUrl?: string,
  ): Promise<MrComment[]> {
    const { owner, repo, number, host } = githubPullParts(mrUrl, repositoryUrl);
    const apiBase =
      host === 'github.com'
        ? 'https://api.github.com'
        : `https://${host}/api/v3`;

    const all: MrComment[] = [];
    const headers = {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
    };

    const reviewData = await this.collectArrayPages<{
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

    const issueData = await this.collectArrayPages<{
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

  private async fetchGitLabComments(
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
    const data = await this.collectArrayPages<{
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

  private async collectPagedValues<T>(
    firstUrl: string,
    headers: Record<string, string>,
    label: string,
  ): Promise<T[]> {
    const out: T[] = [];
    let pageUrl: string | null = firstUrl;
    for (let page = 0; page < MR_MAX_PAGES && pageUrl !== null; page++) {
      const res = await fetch(pageUrl, { headers });
      if (!res.ok) {
        throw new Error(
          `${label} failed: ${res.status} — GET ${apiPathOf(pageUrl)}`,
        );
      }
      const data = (await res.json()) as {
        values?: T[];
        isLastPage?: boolean;
        nextPageStart?: number;
        next?: string;
      };
      out.push(...(data.values ?? []));
      if (data.next) {
        pageUrl = data.next;
      } else if (data.isLastPage === false) {
        const start = data.nextPageStart ?? out.length;
        pageUrl = setStartParam(pageUrl, label, start);
      } else {
        pageUrl = null;
      }
    }
    if (pageUrl !== null) {
      throw new Error(
        `${label}: pagination cap (${MR_MAX_PAGES} pages) reached at ${apiPathOf(firstUrl)} — часть комментариев могла не прийти`,
      );
    }
    return out;
  }

  private async collectArrayPages<T>(
    firstUrl: string,
    headers: Record<string, string>,
    label: string,
  ): Promise<T[]> {
    const out: T[] = [];
    let pageUrl: string | null = firstUrl;
    for (let page = 0; page < MR_MAX_PAGES && pageUrl !== null; page++) {
      const res = await fetch(pageUrl, { headers });
      if (!res.ok) {
        throw new Error(
          `${label} failed: ${res.status} — GET ${apiPathOf(pageUrl)}`,
        );
      }
      const batch = (await res.json()) as T[];
      out.push(...batch);
      if (batch.length >= MR_PAGE_SIZE) {
        pageUrl = nextPageParam(pageUrl, label);
      } else {
        pageUrl = null;
      }
    }
    if (pageUrl !== null) {
      throw new Error(
        `${label}: pagination cap (${MR_MAX_PAGES} pages) reached at ${apiPathOf(firstUrl)} — часть комментариев могла не прийти`,
      );
    }
    return out;
  }

  private bitbucketPartsOfMrUrl(
    mrUrl: string,
    repositoryUrl?: string,
  ): { project: string; repo: string; id: string } {
    try {
      return bitbucketProjectRepoFromMrUrl(mrUrl);
    } catch (error) {
      const id = /\/pull-requests\/(\d+)/.exec(bitbucketPullPath(mrUrl))?.[1];
      if (repositoryUrl && id) {
        const { project, repo } = bitbucketProjectRepo(repositoryUrl);
        return { project, repo, id };
      }
      throw error;
    }
  }

  private async fetchBitbucketComments(
    mrUrl: string,
    token: string,
    repositoryUrl?: string,
  ): Promise<MrComment[]> {
    const { project, repo, id } = this.bitbucketPartsOfMrUrl(
      mrUrl,
      repositoryUrl,
    );
    const host = hostOf(repositoryUrl || mrUrl);
    if (isBitbucketCloudHost(host)) {
      return this.fetchBitbucketCloudComments(mrUrl, token, repositoryUrl);
    }
    const apiPath = `/rest/api/1.0/projects/${encodeURIComponent(project)}/repos/${encodeURIComponent(repo)}/pull-requests/${id}/activities`;

    type Anchor = {
      path?: string;
      line?: number;
      lineSrc?: number;
      lineTgt?: number;
    };
    type RawComment = {
      text?: string;
      author?: { name?: string };
      createdDate?: number | string;
      pending?: boolean;
      anchors?: { line?: Anchor } | null;
      anchor?: Anchor | null;
    };
    type RawActivity = RawComment & {
      action?: string;
      commentAction?: string;
      comment?: RawComment;
    };
    const activities = await this.collectPagedValues<RawActivity>(
      `https://${host}${apiPath}?limit=500&start=0`,
      { Authorization: `Bearer ${token}` },
      'bitbucket comments',
    );

    const comments: MrComment[] = [];
    for (const a of activities) {
      if (a.action !== 'COMMENT' || a.commentAction === 'DELETED') {
        continue;
      }
      const c: RawComment = a.comment ?? a;
      if (c.pending === true) continue;
      const anchor = c.anchors?.line ?? c.anchor;
      comments.push({
        file: anchor?.path ?? null,
        line: anchor?.line ?? anchor?.lineTgt ?? anchor?.lineSrc ?? null,
        body: c.text ?? '',
        author: c.author?.name ?? 'unknown',
        created_at: isoDateOf(c.createdDate),
      });
    }
    return comments;
  }

  private async fetchBitbucketCloudComments(
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
    };
    const raw = await this.collectPagedValues<RawCloudComment>(
      url,
      { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      'bitbucket comments',
    );
    const comments: MrComment[] = [];
    for (const c of raw) {
      if (c.deleted || c.pending) continue;
      comments.push({
        file: c.inline?.path ?? null,
        line: c.inline?.to ?? c.inline?.from ?? null,
        body: c.content?.raw ?? c.content?.markup ?? '',
        author: c.user?.display_name ?? c.user?.account ?? 'unknown',
        created_at: c.created_on ?? '',
      });
    }
    return comments;
  }

  async updateMr(input: MrUpdateInput): Promise<void> {
    const token = input.token || this.tokens[input.source] || this.token;

    if (input.source === 'gitlab') {
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
      return;
    }

    if (input.source === 'github') {
      const { owner, repo } = githubOwnerRepo(input.repositoryUrl);
      const host = hostOf(input.repositoryUrl);
      const apiBase =
        host === 'github.com'
          ? 'https://api.github.com'
          : `https://${host}/api/v3`;
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
      return;
    }

    if (isBitbucketCloudHost(hostOf(input.repositoryUrl))) {
      return this.updateBitbucketCloudMr(input, token);
    }

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
      const body = await response.text().catch(() => '(body unavailable)');
      throw new Error(
        `bitbucket pr update failed: ${response.status} — ${body.slice(0, 500)}`,
      );
    }
  }

  private async updateBitbucketCloudMr(
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
      const body = await response.text().catch(() => '(body unavailable)');
      throw new Error(
        `bitbucket cloud pr update failed: ${response.status} — PUT ${apiPathOf(url)} — ${body.slice(0, 500)}`,
      );
    }
  }

  private async createBitbucketCloudMr(
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
        const existing = await this.findBitbucketCloudOpenMr(input, token);
        if (existing) return existing;
      }
      throw new Error(
        `bitbucket cloud pr failed: ${response.status} — POST ${apiPathOf(url)} — ${body.slice(0, 500)}`,
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

  async createMr(input: MrCreateInput): Promise<MrCreateResult> {
    const token = input.token || this.tokens[input.source] || this.token;

    if (input.source === 'gitlab') {
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
        const body = await response.text().catch(() => '(body unavailable)');
        throw new Error(
          `gitlab mr failed: ${response.status} — POST /projects/${encodeURIComponent(path)}/merge_requests — ${body.slice(0, 500)}`,
        );
      }
      const data = (await response.json()) as GitLabMrResponse;
      return { mrUrl: data.web_url, id: String(data.iid) };
    }

    if (input.source === 'github') {
      const { owner, repo } = githubOwnerRepo(input.repositoryUrl);
      const host = hostOf(input.repositoryUrl);
      const apiBase =
        host === 'github.com'
          ? 'https://api.github.com'
          : `https://${host}/api/v3`;
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
        const body = await response.text().catch(() => '(body unavailable)');
        throw new Error(
          `github pr failed: ${response.status} — POST /repos/${owner}/${repo}/pulls — ${body.slice(0, 500)}`,
        );
      }
      const data = (await response.json()) as GitHubPrResponse;
      return { mrUrl: data.html_url, id: String(data.number) };
    }

    if (isBitbucketCloudHost(hostOf(input.repositoryUrl))) {
      return this.createBitbucketCloudMr(input, token);
    }

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
      const existing = await this.resolveBitbucketDuplicate(
        input,
        token,
        response,
      );
      if (existing) return existing;
    }
    if (!response.ok) {
      const body = await response.text().catch(() => '(body unavailable)');
      throw new Error(
        `bitbucket pr failed: ${response.status} — POST ${createPath} — ${body.slice(0, 500)}`,
      );
    }
    const data = (await response.json()) as BitbucketPrResponse;
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

  private async resolveBitbucketDuplicate(
    input: MrCreateInput,
    token: string,
    response: Response,
  ): Promise<MrCreateResult | null> {
    const { project, repo } = bitbucketProjectRepo(input.repositoryUrl);
    const host = hostOf(input.repositoryUrl);
    const base = `https://${host}/rest/api/1.0/projects/${project}/repos/${repo}/pull-requests`;

    const open = await this.findBitbucketServerOpenMr(input, token);
    if (open) return open;

    const body = await response.text().catch(() => '');
    const idFromError =
      /"existingPullRequest"\s*:\s*\{[^}]*"id"\s*:\s*(\d+)/i.exec(body)?.[1] ??
      /"pullRequestId"\s*:\s*(\d+)/i.exec(body)?.[1];
    if (!idFromError) return null;

    const pr = await fetch(`${base}/${idFromError}`, {
      headers: { Authorization: `Bearer ${token}` },
    }).catch(() => null);
    if (pr?.ok) {
      const data = (await pr.json()) as BitbucketPrResponse;
      const id = String(data.id ?? idFromError);
      return {
        mrUrl: bitbucketMrWebUrl(host, project, repo, id, data.links),
        id,
      };
    }
    return {
      mrUrl: bitbucketMrWebUrl(host, project, repo, idFromError),
      id: idFromError,
    };
  }
}

function gitlabProjectPath(repositoryUrl: string): string {
  const trimmed = repositoryUrl.trim().replace(/\.git$/, '');
  const sshMatch = /^[^@/]+@[^:/]+[:/](.+)$/.exec(trimmed);
  if (sshMatch) return sshMatch[1];
  try {
    const pathname = new URL(trimmed).pathname;
    return pathname.replace(/^\/+/, '');
  } catch {
    throw new Error(`cannot parse repository url: ${repositoryUrl}`);
  }
}

function githubOwnerRepo(repositoryUrl: string): {
  owner: string;
  repo: string;
} {
  const path = gitlabProjectPath(repositoryUrl);
  const segments = path.split('/').filter((segment) => segment.length > 0);
  if (segments.length < 2) {
    throw new Error(`cannot parse github repository: ${repositoryUrl}`);
  }
  return {
    owner: segments[segments.length - 2],
    repo: segments[segments.length - 1],
  };
}

function isoDateOf(value: number | string | undefined): string {
  if (value === undefined || value === '') return '';
  if (typeof value === 'string' && !/^\d+$/.test(value)) return value;
  const ms = Number(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : String(value);
}

function pathOfMrUrl(mrUrl: string): string {
  try {
    return new URL(mrUrl).pathname;
  } catch {
    return mrUrl;
  }
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

function bitbucketMrWebUrl(
  host: string,
  project: string,
  repo: string,
  id: string,
  links?: BitbucketPrResponse['links'],
): string {
  const self = links?.self?.find((link) => link.href)?.href;
  if (self) return self;
  return `https://${host}/projects/${project}/repos/${repo}/pull-requests/${id}`;
}

function bitbucketProjectRepo(repositoryUrl: string): {
  project: string;
  repo: string;
} {
  const path = gitlabProjectPath(repositoryUrl);
  const segments = path.split('/').filter((segment) => segment.length > 0);
  const cleaned =
    segments[0]?.toLowerCase() === 'scm' ? segments.slice(1) : segments;
  if (cleaned.length < 2) {
    throw new Error(`cannot parse bitbucket repository: ${repositoryUrl}`);
  }
  return {
    project: cleaned[cleaned.length - 2],
    repo: cleaned[cleaned.length - 1],
  };
}

const MR_PAGE_SIZE = 100;

const MR_MAX_PAGES = 50;

const BITBUCKET_CLOUD_API = 'https://api.bitbucket.org/2.0';

function isBitbucketCloudHost(host: string): boolean {
  return host === 'bitbucket.org';
}

function apiPathOf(url: string): string {
  try {
    const u = new URL(url);
    return u.pathname + u.search;
  } catch {
    return url;
  }
}

function setStartParam(url: string, label: string, start: number): string {
  const u = parsePageUrl(url, label);
  u.searchParams.set('start', String(start));
  return u.toString();
}

function nextPageParam(url: string, label: string): string {
  const u = parsePageUrl(url, label);
  const page = Number(u.searchParams.get('page') ?? '1');
  u.searchParams.set('page', String((Number.isFinite(page) ? page : 1) + 1));
  return u.toString();
}

function parsePageUrl(url: string, label: string): URL {
  try {
    return new URL(url);
  } catch {
    throw new Error(`${label}: не разобран URL следующей страницы — ${url}`);
  }
}

function bitbucketCloudParts(
  mrUrl: string,
  repositoryUrl?: string,
): { workspace: string; repo: string; id: string } {
  const match = /\/([^/]+)\/([^/]+)\/pull-requests\/(\d+)/.exec(mrUrl);
  if (match) {
    return {
      workspace: decodeURIComponent(match[1]),
      repo: decodeURIComponent(match[2]).replace(/\.git$/, ''),
      id: match[3],
    };
  }
  const id = /\/pull-requests\/(\d+)/.exec(mrUrl)?.[1];
  if (repositoryUrl && id) {
    const { project, repo } = bitbucketProjectRepo(repositoryUrl);
    return { workspace: project, repo, id };
  }
  throw new Error(
    `cannot parse bitbucket cloud pr url: ${mrUrl} — ожидается https://bitbucket.org/{workspace}/{repo}/pull-requests/{id}`,
  );
}

function bitbucketCloudMrWebUrl(
  htmlUrl: string | undefined,
  workspace: string,
  repo: string,
  id: string,
): string {
  return (
    htmlUrl ??
    `https://bitbucket.org/${encodeURIComponent(workspace)}/${encodeURIComponent(repo)}/pull-requests/${id}`
  );
}
