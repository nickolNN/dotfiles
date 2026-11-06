import { commitAndPush } from './commit-push';
import { startDevServer } from './run-instructions';
import { readChangeDigests } from './digest';
import {
  createGitContext,
  defaultGitExecFile,
  type GitContext,
  type GitExecFile,
} from './exec';
import { installDependencies } from './install';
import { DEFAULT_ORIGINALS_ROOT } from './paths';
import { prepareRepos } from './prepare';
import { devServerTimeoutMs, gitTimeoutMs } from './timeouts';
import type {
  DevServerStartResult,
  GitCommitInput,
  GitCommitResult,
  GitPrepareInput,
  GitPrepareResult,
  GitService,
  RepoChangeDigest,
} from './types';

export class GitCliService implements GitService {
  private readonly ctx: GitContext;

  constructor(
    private readonly originalsRoot = DEFAULT_ORIGINALS_ROOT,
    exec: GitExecFile = defaultGitExecFile,
    timeoutMs: number = gitTimeoutMs(),
    private readonly devServerTimeout: number = devServerTimeoutMs(),
  ) {
    this.ctx = createGitContext(exec, timeoutMs);
  }

  prepare(input: GitPrepareInput): Promise<GitPrepareResult> {
    return prepareRepos(this.ctx, this.originalsRoot, input);
  }

  installDependencies(repoPaths: string[]): Promise<void> {
    return installDependencies(this.ctx, repoPaths);
  }

  commitAndPush(input: GitCommitInput): Promise<GitCommitResult> {
    return commitAndPush(this.ctx, input);
  }

  changeDigest(repoPaths: string[]): Promise<RepoChangeDigest[]> {
    return readChangeDigests(this.ctx, repoPaths);
  }

  startDevServer(
    repoPath: string,
    instructions: string | null,
  ): Promise<DevServerStartResult> {
    return startDevServer(repoPath, instructions, this.devServerTimeout);
  }
}