import { RepoPlatform } from '@issue-resolver/shared';
import type { RepoInfo } from '@issue-resolver/shared';
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
} from './http';
import { asRecord, requireRecord, requireString } from '../util/records';
import { boolOrNull, stringOrNull } from '../util/scalars';
import type { RepoResolver } from './types';
import { bitbucketProjectRepo } from './url';

interface BitbucketCloudRepoResponse {
  full_name: string;
  mainbranch?: { name: string } | null;
  language: string | null;
  description: string | null;
  is_private: boolean;
  links?: { clone?: BitbucketCloneLink[] };
}

function bitbucketCloudRepo(value: unknown): BitbucketCloudRepoResponse {
  const raw = requireRecord(value, 'bitbucket cloud repo response');
  const mainbranch = asRecord(raw.mainbranch);
  const links = asRecord(raw.links);
  return {
    full_name: requireString(raw, 'full_name', 'bitbucket cloud repo response'),
    mainbranch: mainbranch
      ? { name: stringOrNull(mainbranch.name) ?? '' }
      : null,
    language: stringOrNull(raw.language),
    description: stringOrNull(raw.description),
    is_private: boolOrNull(raw.is_private) ?? false,
    links: links ? { clone: cloneLinks(links.clone) } : undefined,
  };
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
    assertRepoResponse(response, 'Bitbucket');
    const data = bitbucketCloudRepo(await response.json());

    const listed = await fetchBranchList(
      `${base}/refs/branches?pagelen=100`,
      { headers },
      (payload) => {
        const values = asRecord(payload)?.values;
        if (!Array.isArray(values)) return undefined;
        return values.flatMap((branch) => {
          const name = asRecord(branch)?.name;
          return typeof name === 'string' ? [name] : [];
        });
      },
    );

    const { defaultBranch, branches } = chooseBranches(
      data.mainbranch?.name,
      listed,
    );

    return {
      platform: RepoPlatform.bitbucket,
      fullName: data.full_name,
      defaultBranch,
      branches,
      language: data.language ?? null,
      description: data.description ?? null,
      stars: 0,
      isPrivate: data.is_private,
      cloneUrl:
        cloneHref(data.links?.clone, 'https') ??
        `https://bitbucket.org/${owner}/${repo}.git`,
      writeAccess: false,
    };
  }
}