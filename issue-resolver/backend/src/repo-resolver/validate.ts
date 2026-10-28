
import type { RepoValidationResult } from '@issue-resolver/shared';
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
      if (platform === 'unknown') {
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
          error: err instanceof Error ? err.message : 'Unknown error',
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