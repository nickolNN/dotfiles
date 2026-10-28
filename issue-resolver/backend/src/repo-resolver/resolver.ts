
import type { RepoInfo, RepoPlatform } from '@issue-resolver/shared';

export interface RepoResolver {
  resolve(url: string): Promise<RepoInfo>;
}

export type RepoResolverFactory = (
  url: string,
  env: NodeJS.ProcessEnv,
) => RepoResolver;

const DEFAULT_GITHUB_HOST = 'github.com';
const DEFAULT_GITLAB_HOST = 'gitlab.com';
const DEFAULT_BITBUCKET_HOST = 'bitbucket.org';

function hostOf(url: string): string {
  const trimmed = url.trim();
  const sshMatch = /^[^@/]+@([^:/]+)[:/]/.exec(trimmed);
  if (sshMatch) {
    return sshMatch[1].toLowerCase();
  }
  try {
    return new URL(trimmed).hostname.toLowerCase();
  } catch {
    return '';
  }
}

function repoPathOf(url: string): string {
  const trimmed = url.trim().replace(/\.git$/, '');
  const sshMatch = /^[^@/]+@[^:/]+[:/](.+)$/.exec(trimmed);
  if (sshMatch) {
    return sshMatch[1].replace(/^\/+/, '');
  }
  try {
    return new URL(trimmed).pathname.replace(/^\/+/, '');
  } catch {
    throw new Error(`cannot parse repository url: ${url}`);
  }
}

function githubOwnerRepo(url: string): { owner: string; repo: string } {
  const segments = repoPathOf(url)
    .split('/')
    .filter((segment) => segment.length > 0);
  if (segments.length < 2) {
    throw new Error(`cannot parse github repository: ${url}`);
  }
  return { owner: segments[0], repo: segments[1] };
}

function isBitbucketCloudHost(host: string): boolean {
  return host === 'bitbucket.org';
}

function bitbucketProjectRepo(url: string): { project: string; repo: string } {
  const segments = repoPathOf(url)
    .split('/')
    .filter((segment) => segment.length > 0);

  if (isBitbucketCloudHost(hostOf(url))) {
    if (segments.length < 2) {
      throw new Error(`cannot parse bitbucket repository: ${url}`);
    }
    return { project: segments[0], repo: segments[1] };
  }

  if (segments[0]?.toLowerCase() === 'scm') {
    if (segments.length < 3) {
      throw new Error(`cannot parse bitbucket repository: ${url}`);
    }
    return { project: segments[1], repo: segments[2] };
  }

  const projectsIndex = segments.findIndex(
    (segment) => segment.toLowerCase() === 'projects',
  );
  const reposIndex = segments.findIndex(
    (segment, index) =>
      index > projectsIndex && segment.toLowerCase() === 'repos',
  );
  if (projectsIndex !== -1 && reposIndex !== -1) {
    return {
      project: segments[projectsIndex + 1],
      repo: segments[reposIndex + 1],
    };
  }

  if (segments.length >= 2) {
    return { project: segments[0], repo: segments[1] };
  }

  throw new Error(`cannot parse bitbucket repository: ${url}`);
}

export function detectPlatform(url: string): RepoPlatform {
  const host = hostOf(url);
  if (!host) {
    return 'unknown';
  }
  if (host.includes('github')) {
    return 'github';
  }
  if (host.includes('gitlab')) {
    return 'gitlab';
  }
  if (host.includes('bitbucket')) {
    return 'bitbucket';
  }
  if (host.includes('stash')) {
    return 'bitbucket';
  }
  if (host === 'github.com' || host === 'gitlab.com' || host === 'bitbucket.org') {
    return 'unknown';
  }
  return 'bitbucket';
}

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

  async resolve(url: string): Promise<RepoInfo> {
    const { owner, repo } = githubOwnerRepo(url);
    const repoUrl = `${this.apiBase()}/repos/${owner}/${repo}`;
    const response = await fetch(
      repoUrl,
      {
        headers: {
          Accept: 'application/vnd.github+json',
          'User-Agent': 'issue-resolver',
          ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
        },
      },
    );

    if (response.status === 404) {
      throw new Error('Repository not found');
    }
    if (response.status === 401 || response.status === 403) {
      throw new Error('Access denied');
    }
    if (!response.ok) {
      throw new Error(`GitHub API request failed: ${response.status}`);
    }

    const data = (await response.json()) as GitHubRepoResponse;

    let branches: string[] = [data.default_branch];
    try {
      const branchesResp = await fetch(
        `${repoUrl}/branches?per_page=100`,
        {
          headers: {
            Accept: 'application/vnd.github+json',
            'User-Agent': 'issue-resolver',
            ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
          },
        },
      );
      if (branchesResp.ok) {
        const list = (await branchesResp.json()) as Array<{ name: string }>;
        branches = list.map((b) => b.name);
      }
    } catch {
    }

    return {
      platform: 'github',
      fullName: data.full_name,
      defaultBranch: data.default_branch,
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
export class GitLabResolver implements RepoResolver {
  constructor(
    private readonly token = '',
    private readonly host = DEFAULT_GITLAB_HOST,
  ) {}

  async resolve(url: string): Promise<RepoInfo> {
    const path = repoPathOf(url);
    const response = await fetch(
      `https://${this.host}/api/v4/projects/${encodeURIComponent(path)}`,
      {
        headers: {
          ...(this.token ? { 'PRIVATE-TOKEN': this.token } : {}),
        },
      },
    );

    if (response.status === 404) {
      throw new Error('Repository not found');
    }
    if (response.status === 401 || response.status === 403) {
      throw new Error('Access denied');
    }
    if (!response.ok) {
      throw new Error(`GitLab API request failed: ${response.status}`);
    }

    const data = (await response.json()) as GitLabRepoResponse;

    let branches: string[] = [data.default_branch];
    try {
      const branchesResp = await fetch(
        `https://${this.host}/api/v4/projects/${encodeURIComponent(path)}/repository/branches?per_page=100`,
        {
          headers: {
            ...(this.token ? { 'PRIVATE-TOKEN': this.token } : {}),
          },
        },
      );
      if (branchesResp.ok) {
        const list = (await branchesResp.json()) as Array<{ name: string }>;
        branches = list.map((b) => b.name);
      }
    } catch {
    }

    return {
      platform: 'gitlab',
      fullName: data.path_with_namespace,
      defaultBranch: data.default_branch,
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

interface BitbucketCloneLink {
  name: string;
  href: string;
}

interface BitbucketRepoResponse {
  slug: string;
  name: string;
  project: { key: string; name: string };
  description: string | null;
  public: boolean;
  links: { clone: BitbucketCloneLink[] };
}

interface BitbucketBranchResponse {
  displayId: string;
}

function bitbucketAuthHeaders(
  token: string,
  username: string,
  password: string,
): Record<string, string> {
  if (token) {
    return { Authorization: `Bearer ${token}` };
  }
  if (username) {
    const basic = Buffer.from(`${username}:${password}`).toString('base64');
    return { Authorization: `Basic ${basic}` };
  }
  return {};
}

export class BitbucketResolver implements RepoResolver {
  constructor(
    private readonly token = '',
    private readonly host = DEFAULT_BITBUCKET_HOST,
    private readonly username = '',
    private readonly password = '',
  ) {}

  private headers(): Record<string, string> {
    return bitbucketAuthHeaders(this.token, this.username, this.password);
  }

  private async hasWriteAccess(
    project: string,
    repo: string,
    startPoint: string,
  ): Promise<boolean> {
    const testBranch = `_pi_write_test_${Date.now()}`;
    const base = `https://${this.host}/rest/api/1.0/projects/${project}/repos/${repo}`;
    const headers = this.headers();
    try {
      const createResp = await fetch(`${base}/branches`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: testBranch, startPoint }),
      });
      if (!createResp.ok) return false;
      try {
        await fetch(`${base}/branches`, {
          method: 'DELETE',
          headers: { ...headers, 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: `refs/heads/${testBranch}` }),
        });
      } catch {
      }
      return true;
    } catch {
      return false;
    }
  }

  async resolve(url: string): Promise<RepoInfo> {
    if (isBitbucketCloudHost(hostOf(url) || this.host)) {
      return new BitbucketCloudResolver(
        this.token,
        this.username,
        this.password,
      ).resolve(url);
    }

    const { project, repo } = bitbucketProjectRepo(url);
    const base = `https://${this.host}/rest/api/1.0/projects/${project}/repos/${repo}`;

    const response = await fetch(base, { headers: this.headers() });
    if (response.status === 404) {
      throw new Error('Repository not found');
    }
    if (response.status === 401 || response.status === 403) {
      throw new Error('Access denied');
    }
    if (!response.ok) {
      throw new Error(`Bitbucket API request failed: ${response.status}`);
    }
    const data = (await response.json()) as BitbucketRepoResponse;

    const branchResponse = await fetch(`${base}/branches/default`, {
      headers: this.headers(),
    });
    const branch = branchResponse.ok
      ? ((await branchResponse.json()) as BitbucketBranchResponse)
      : null;

    const httpClone = data.links?.clone?.find(
      (link) => link.name === 'http',
    );

    let branches: string[] = [branch?.displayId ?? 'main'];
    try {
      const branchesResp = await fetch(`${base}/branches?limit=100`, {
        headers: this.headers(),
      });
      if (branchesResp.ok) {
        const list = (await branchesResp.json()) as {
          values?: Array<{ displayId: string }>;
        };
        if (list.values) {
          branches = list.values.map((b) => b.displayId);
        }
      }
    } catch {
    }

    const defaultBranch = branch?.displayId ?? 'main';

    return {
      platform: 'bitbucket',
      fullName: `${data.project?.key ?? project}/${data.slug ?? repo}`,
      defaultBranch,
      branches,
      language: null,
      description: data.description ?? null,
      stars: 0,
      isPrivate: !data.public,
      cloneUrl:
        httpClone?.href ?? `https://${this.host}/scm/${project}/${repo}.git`,
      writeAccess: await this.hasWriteAccess(
        project,
        repo,
        `refs/heads/${defaultBranch}`,
      ),
    };
  }
}

interface BitbucketCloudRepoResponse {
  full_name: string;
  mainbranch?: { name: string } | null;
  language: string | null;
  description: string | null;
  is_private: boolean;
  links?: { clone?: BitbucketCloneLink[] };
}

export class BitbucketCloudResolver implements RepoResolver {
  constructor(
    private readonly token = '',
    private readonly username = '',
    private readonly password = '',
  ) {}

  async resolve(url: string): Promise<RepoInfo> {
    const { project: owner, repo } = bitbucketProjectRepo(url);
    const base = `https://api.bitbucket.org/2.0/repositories/${owner}/${repo}`;
    const headers = bitbucketAuthHeaders(
      this.token,
      this.username,
      this.password,
    );

    const response = await fetch(base, { headers });
    if (response.status === 404) {
      throw new Error('Repository not found');
    }
    if (response.status === 401 || response.status === 403) {
      throw new Error('Access denied');
    }
    if (!response.ok) {
      throw new Error(`Bitbucket API request failed: ${response.status}`);
    }
    const data = (await response.json()) as BitbucketCloudRepoResponse;

    const defaultBranch = data.mainbranch?.name ?? 'main';

    let branches: string[] = [defaultBranch];
    try {
      const branchesResp = await fetch(`${base}/refs/branches?pagelen=100`, {
        headers,
      });
      if (branchesResp.ok) {
        const list = (await branchesResp.json()) as {
          values?: Array<{ name: string }>;
        };
        if (list.values) {
          branches = list.values.map((b) => b.name);
        }
      }
    } catch {
    }

    const httpsClone = data.links?.clone?.find(
      (link) => link.name === 'https',
    );

    return {
      platform: 'bitbucket',
      fullName: data.full_name,
      defaultBranch,
      branches,
      language: data.language ?? null,
      description: data.description ?? null,
      stars: 0,
      isPrivate: data.is_private,
      cloneUrl:
        httpsClone?.href ?? `https://bitbucket.org/${owner}/${repo}.git`,
      writeAccess: false,
    };
  }
}

export function createRepoResolver(
  url: string,
  env: NodeJS.ProcessEnv,
): RepoResolver {
  const platform = detectPlatform(url);
  if (platform === 'github') {
    return new GitHubResolver(
      env.GITHUB_TOKEN ?? '',
      hostOf(url) || DEFAULT_GITHUB_HOST,
    );
  }
  if (platform === 'gitlab') {
    return new GitLabResolver(
      env.GITLAB_TOKEN ?? '',
      hostOf(url) || DEFAULT_GITLAB_HOST,
    );
  }
  if (platform === 'bitbucket') {
    return new BitbucketResolver(
      env.BITBUCKET_TOKEN ?? '',
      hostOf(url) || DEFAULT_BITBUCKET_HOST,
      env.BITBUCKET_USERNAME ?? '',
      env.BITBUCKET_PASSWORD ?? '',
    );
  }
  throw new Error('Unsupported platform');
}

export class FakeRepoResolver implements RepoResolver {
  readonly calls: string[] = [];
  private pendingError: Error | null = null;

  constructor(private readonly info: RepoInfo) {}

  failNextWith(err: Error): void {
    this.pendingError = err;
  }

  async resolve(url: string): Promise<RepoInfo> {
    this.calls.push(url);
    if (this.pendingError) {
      const err = this.pendingError;
      this.pendingError = null;
      throw err;
    }
    return { ...this.info, writeAccess: this.info.writeAccess ?? true };
  }
}