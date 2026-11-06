import { RepoPlatform } from '@issue-resolver/shared';
import type { RepoInfo } from '@issue-resolver/shared';
import { BitbucketCloudResolver } from './bitbucket-cloud';
import {
  bitbucketAuthHeaders,
  cloneHref,
  cloneLinks,
  type BitbucketCloneLink,
} from './bitbucket-auth';
import {
  assertRepoResponse,
  chooseBranches,
  fetchBranchList,
  readJson,
} from './http';
import { asRecord, requireRecord } from '../util/records';
import { boolOrNull, stringOrNull } from '../util/scalars';
import type { RepoResolver } from './types';
import {
  bitbucketProjectRepo,
  DEFAULT_BITBUCKET_HOST,
  hostOf,
  isBitbucketCloudHost,
} from './url';

interface BitbucketRepoResponse {
  slug: string;
  project: { key: string };
  description: string | null;
  public: boolean;
  links: { clone: BitbucketCloneLink[] };
}

function bitbucketRepo(value: unknown): BitbucketRepoResponse {
  const raw = requireRecord(value, 'bitbucket repo response');
  const project = asRecord(raw.project);
  const links = asRecord(raw.links);
  return {
    slug: stringOrNull(raw.slug) ?? '',
    project: { key: stringOrNull(project?.key) ?? '' },
    description: stringOrNull(raw.description),
    public: boolOrNull(raw.public) ?? false,
    links: { clone: cloneLinks(links?.clone) ?? [] },
  };
}

const serverBase = (host: string, project: string, repo: string): string =>
  `https://${host}/rest/api/1.0/projects/${project}/repos/${repo}`;

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
    const base = serverBase(this.host, project, repo);
    const headers = this.headers();
    try {
      const createResp = await fetch(`${base}/branches`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: testBranch, startPoint }),
      });
      if (!createResp.ok) return false;
      await fetch(`${base}/branches`, {
        method: 'DELETE',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: `refs/heads/${testBranch}` }),
      }).catch(() => null);
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
    const base = serverBase(this.host, project, repo);

    const response = await fetch(base, { headers: this.headers() });
    assertRepoResponse(response, 'Bitbucket');
    const data = bitbucketRepo(await response.json());

    const branch = asRecord(
      await readJson(
        await fetch(`${base}/branches/default`, { headers: this.headers() }),
      ),
    );

    const listed = await fetchBranchList(
      `${base}/branches?limit=100`,
      { headers: this.headers() },
      (payload) => {
        const values = asRecord(payload)?.values;
        if (!Array.isArray(values)) return undefined;
        return values.flatMap((entry) => {
          const id = asRecord(entry)?.displayId;
          return typeof id === 'string' ? [id] : [];
        });
      },
    );

    const { defaultBranch, branches } = chooseBranches(
      stringOrNull(branch?.displayId),
      listed,
    );

    return {
      platform: RepoPlatform.bitbucket,
      fullName: `${data.project.key || project}/${data.slug || repo}`,
      defaultBranch,
      branches,
      language: null,
      description: data.description ?? null,
      stars: 0,
      isPrivate: !data.public,
      cloneUrl:
        cloneHref(data.links?.clone, 'http') ??
        `https://${this.host}/scm/${project}/${repo}.git`,
      writeAccess: defaultBranch
        ? await this.hasWriteAccess(
            project,
            repo,
            `refs/heads/${defaultBranch}`,
          )
        : false,
    };
  }
}