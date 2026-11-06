import type { RepoInfo } from '@issue-resolver/shared';

export interface RepoResolver {
  resolve(url: string): Promise<RepoInfo>;
}

export type RepoResolverFactory = (
  url: string,
  env: NodeJS.ProcessEnv,
) => RepoResolver;