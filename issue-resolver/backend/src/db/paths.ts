import { join, resolve } from 'node:path';

export const DEFAULT_DB_PATH = resolve(
  import.meta.dirname,
  '../../data/issue-resolver.db',
);

export const dbPathFromEnv = (env: NodeJS.ProcessEnv): string => {
  const dataDir = env.ISSUE_RESOLVER_DATA_DIR;
  return dataDir ? join(dataDir, 'issue-resolver.db') : DEFAULT_DB_PATH;
};