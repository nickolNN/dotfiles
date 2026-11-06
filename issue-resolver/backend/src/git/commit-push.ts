import type { GitContext } from './exec';
import { isNothingToCommitError } from './exec';
import { rmIndexLock } from './paths';
import type { GitCommitInput, GitCommitResult } from './types';

function pushToken(env: NodeJS.ProcessEnv): string {
  return (
    env.GITHUB_TOKEN || env.GITLAB_TOKEN || env.BITBUCKET_TOKEN || ''
  );
}

export async function commitAndPush(
  ctx: GitContext,
  input: GitCommitInput,
  env: NodeJS.ProcessEnv = process.env,
): Promise<GitCommitResult> {
  await rmIndexLock(input.repoPath);
  await ctx.git(['-C', input.repoPath, 'checkout', '-B', input.branchName]);
  if (input.squashBase) {
    await ctx.git(['-C', input.repoPath, 'reset', '--soft', input.squashBase]);
  }
  await ctx.git(['-C', input.repoPath, 'add', '-A']);
  const identity = [
    '-c',
    `user.name=${env.GIT_AUTHOR_NAME || 'issue-resolver'}`,
    '-c',
    `user.email=${env.GIT_AUTHOR_EMAIL || 'issue-resolver@localhost'}`,
  ];
  try {
    await ctx.git([
      '-C',
      input.repoPath,
      ...identity,
      'commit',
      '--no-verify',
      '-m',
      input.commitMessage,
    ]);
  } catch (error) {
    if (!isNothingToCommitError(error)) throw error;
  }

  const token = pushToken(env);
  const pushArgs = [
    '-C',
    input.repoPath,
    'push',
    '--set-upstream',
    'origin',
    input.branchName,
  ];
  if (input.squashBase) {
    pushArgs.push('--force');
  }
  if (token) {
    pushArgs.unshift(
      '-c',
      `credential.helper=!f() { echo "password=${token}"; echo "username=x-access-token"; }; f`,
    );
  }
  await ctx.git(pushArgs);
  return { pushed: true, branchName: input.branchName };
}