import { RepoPlatform } from '@issue-resolver/shared';
import type { RepoResolver } from './types';
import { detectPlatform, hostOf } from './url';
import {
  DEFAULT_BITBUCKET_HOST,
  DEFAULT_GITHUB_HOST,
  DEFAULT_GITLAB_HOST,
} from './url';
import { GitHubResolver } from './github';
import { GitLabResolver } from './gitlab';
import { BitbucketResolver } from './bitbucket';

export function createRepoResolver(
  url: string,
  env: NodeJS.ProcessEnv,
): RepoResolver {
  const platform = detectPlatform(url);
  if (platform === RepoPlatform.github) {
    return new GitHubResolver(
      env.GITHUB_TOKEN ?? '',
      hostOf(url) || DEFAULT_GITHUB_HOST,
    );
  }
  if (platform === RepoPlatform.gitlab) {
    return new GitLabResolver(
      env.GITLAB_TOKEN ?? '',
      hostOf(url) || DEFAULT_GITLAB_HOST,
    );
  }
  if (platform === RepoPlatform.bitbucket) {
    return new BitbucketResolver(
      env.BITBUCKET_TOKEN ?? '',
      hostOf(url) || DEFAULT_BITBUCKET_HOST,
      env.BITBUCKET_USERNAME ?? '',
      env.BITBUCKET_PASSWORD ?? '',
    );
  }
  throw new Error('Unsupported platform');
}