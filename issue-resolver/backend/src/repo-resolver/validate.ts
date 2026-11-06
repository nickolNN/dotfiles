
import { RepoPlatform } from '@issue-resolver/shared';
import type { RepoValidationResult } from '@issue-resolver/shared';
import { messageOf } from '../util/errors';
import {
  createRepoResolver,
  detectPlatform,
  type RepoResolverFactory,
} from './resolver';

export type ReposValidator = (
  urls: string[],
) => Promise<RepoValidationResult[]>;

export async function validateRepos(
  urls: string[],
  env: NodeJS.ProcessEnv,
  factory: RepoResolverFactory = createRepoResolver,
): Promise<RepoValidationResult[]> {
  return Promise.all(
    urls.map(async (url) => {
      const platform = detectPlatform(url);
      if (platform === RepoPlatform.unknown) {
        return { url, valid: false, platform, error: 'Unsupported platform' };
      }
      try {
        const resolver = factory(url, env);
        const info = await resolver.resolve(url);
        return {
          url,
          valid: true,
          platform,
          info: { ...info, writeAccess: info.writeAccess ?? false },
        };
      } catch (err) {
        return {
          url,
          valid: false,
          platform,
          error: messageOf(err, 'Unknown error'),
        };
      }
    }),
  );
}

export function createReposValidator(
  env: NodeJS.ProcessEnv,
  factory?: RepoResolverFactory,
): ReposValidator {
  return (urls) => validateRepos(urls, env, factory);
}