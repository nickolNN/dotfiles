import type { GitContext } from './exec';
import type { RepoChangeDigest } from './types';

export const CHANGE_DIGEST_MAX_FILES = 120;

async function digestOf(
  ctx: GitContext,
  repoPath: string,
): Promise<RepoChangeDigest> {
  const digest: RepoChangeDigest = {
    repoPath,
    changedFiles: [],
    diffSummary: '',
    omittedFiles: 0,
  };
  let status: string;
  try {
    status = await ctx.git(['-C', repoPath, 'status', '--porcelain=v1', '-uall']);
  } catch {
    return digest;
  }
  const entries = status
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0);
  digest.omittedFiles = Math.max(0, entries.length - CHANGE_DIGEST_MAX_FILES);
  digest.changedFiles = entries
    .slice(0, CHANGE_DIGEST_MAX_FILES)
    .map((line) => line.slice(3));
  try {
    const stat = await ctx.git(['-C', repoPath, 'diff', '--stat', '--no-color']);
    const lines = stat
      .split('\n')
      .map((line) => line.trimEnd())
      .filter((line) => line.length > 0);
    digest.diffSummary = lines[lines.length - 1] ?? '';
  } catch {
  }
  return digest;
}

export async function readChangeDigests(
  ctx: GitContext,
  repoPaths: string[],
): Promise<RepoChangeDigest[]> {
  return Promise.all(repoPaths.map((repoPath) => digestOf(ctx, repoPath)));
}