import { createHash } from 'node:crypto';
import { rm } from 'node:fs/promises';
import path from 'node:path';

export const DEFAULT_ORIGINALS_ROOT = '/tmp/issue-resolver/originals';

export const originalsRootFromEnv = (env: NodeJS.ProcessEnv): string => {
  const dataDir = env.ISSUE_RESOLVER_DATA_DIR;
  return dataDir ? path.join(dataDir, 'originals') : DEFAULT_ORIGINALS_ROOT;
};

export const repoName = (repoUrl: string): string => {
  const clean = repoUrl.replace(/\/+$/, '').replace(/\.git$/, '');
  const segment = clean.split(/[\\/]/).pop();
  return segment && segment.length > 0 ? segment : 'repo';
};

const sha256 = (value: string): string =>
  createHash('sha256').update(value).digest('hex');

export const gitCachePath = (
  originalsRoot: string,
  repoUrl: string,
): string =>
  path.join(
    originalsRoot,
    `${repoName(repoUrl)}-${sha256(repoUrl).slice(0, 4)}`,
  );

export const rmIndexLock = async (repoPath: string): Promise<void> => {
  await rm(path.join(repoPath, '.git', 'index.lock'), { force: true });
};