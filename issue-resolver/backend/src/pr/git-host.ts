import { RepoPlatform } from '@issue-resolver/shared';
import { hostOf as hostNameOf } from '../repo-resolver/url';
import { pathOfMrUrl } from './mr-url';
import type { MrSource } from './mr-types';

export function hostOf(repositoryUrl: string): string {
  const host = hostNameOf(repositoryUrl);
  if (!host) throw new Error('unknown git host');
  return host;
}

export function detectGitHost(
  repositoryUrl: string,
  mrUrl = '',
): MrSource {
  const host = hostOf(repositoryUrl);
  if (host.includes('github')) return RepoPlatform.github;
  if (host.includes('gitlab')) return RepoPlatform.gitlab;
  const isBitbucketPrPath = (url: string) =>
    /\/projects\/[^/]+\/repos\/[^/]+\/pull-requests\//.test(
      pathOfMrUrl(url),
    );
  if (
    host.includes('bitbucket') ||
    host.includes('stash') ||
    /\/scm\//.test(repositoryUrl) ||
    isBitbucketPrPath(repositoryUrl) ||
    isBitbucketPrPath(mrUrl)
  ) {
    return RepoPlatform.bitbucket;
  }
  throw new Error('unknown git host');
}
