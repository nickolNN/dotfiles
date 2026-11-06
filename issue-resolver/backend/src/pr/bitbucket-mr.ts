import { hostOf } from './git-host';
import type {
  MrComment,
  MrCreateInput,
  MrCreateResult,
  MrFindInput,
  MrUpdateInput,
} from './mr-types';
import { bitbucketProjectRepoFromMrUrl, pathOfMrUrl } from './mr-url';
import {
  createBitbucketCloudMr,
  fetchBitbucketCloudComments,
  findBitbucketCloudOpenMr,
  updateBitbucketCloudMr,
} from './bitbucket-cloud-mr';
import {
  createBitbucketServerMr,
  fetchBitbucketServerComments,
  findBitbucketServerOpenMr,
  updateBitbucketServerMr,
} from './bitbucket-server-mr';
import { bitbucketProjectRepo, isBitbucketCloudHost } from '../repo-resolver/url';

function bitbucketPartsOfMrUrl(
  mrUrl: string,
  repositoryUrl?: string,
): { project: string; repo: string; id: string } {
  try {
    return bitbucketProjectRepoFromMrUrl(mrUrl);
  } catch (error) {
    const id = /\/pull-requests\/(\d+)/.exec(pathOfMrUrl(mrUrl))?.[1];
    if (repositoryUrl && id) {
      const { project, repo } = bitbucketProjectRepo(repositoryUrl);
      return { project, repo, id };
    }
    throw error;
  }
}

function isCloud(input: { repositoryUrl: string }): boolean {
  return isBitbucketCloudHost(hostOf(input.repositoryUrl));
}

export async function createBitbucketMr(
  input: MrCreateInput,
  token: string,
): Promise<MrCreateResult> {
  if (isCloud(input)) return createBitbucketCloudMr(input, token);
  return createBitbucketServerMr(input, token);
}

export async function findBitbucketOpenMr(
  input: MrFindInput,
  token: string,
): Promise<MrCreateResult | null> {
  if (isCloud(input)) return findBitbucketCloudOpenMr(input, token);
  return findBitbucketServerOpenMr(input, token);
}

export async function updateBitbucketMr(
  input: MrUpdateInput,
  token: string,
): Promise<void> {
  if (isCloud(input)) return updateBitbucketCloudMr(input, token);
  return updateBitbucketServerMr(input, token);
}

export async function fetchBitbucketComments(
  mrUrl: string,
  token: string,
  repositoryUrl?: string,
): Promise<MrComment[]> {
  const target = bitbucketPartsOfMrUrl(mrUrl, repositoryUrl);
  const host = hostOf(repositoryUrl || mrUrl);
  if (isBitbucketCloudHost(host)) {
    return fetchBitbucketCloudComments(mrUrl, token, repositoryUrl);
  }
  return fetchBitbucketServerComments({ host, ...target }, token);
}
