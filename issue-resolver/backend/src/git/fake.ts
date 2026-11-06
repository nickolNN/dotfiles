import { WorkspaceProgressStatus } from '@issue-resolver/shared';
import { repoName } from './paths';
import { PendingFailure } from '../util/pending-failure';
import type {
  DevServerStartResult,
  GitCommitInput,
  GitCommitResult,
  GitPrepareInput,
  GitPrepareResult,
  GitService,
  RepoChangeDigest,
} from './types';

export class FakeGitService extends PendingFailure implements GitService {
  readonly prepares: GitPrepareInput[] = [];
  readonly commits: GitCommitInput[] = [];
  readonly dependenciesInstalled: string[][] = [];
  readonly devServersStarted: { repoPath: string; instructions: string | null }[] =
    [];
  devServerResult: DevServerStartResult = { port: 5173 };

  async prepare(input: GitPrepareInput): Promise<GitPrepareResult> {
    this.throwIfPending();
    this.prepares.push(input);
    return {
      repoWorkspaces: input.repoUrls.map((repoUrl, index) => {
        input.onRepoProgress?.(repoUrl, WorkspaceProgressStatus.running);
        input.onRepoProgress?.(repoUrl, WorkspaceProgressStatus.done);
        return {
          repoUrl,
          path: `${input.workspacePath}/${repoName(repoUrl)}`,
          branch: input.baseBranches[index] ?? 'main',
        };
      }),
    };
  }

  async installDependencies(repoPaths: string[]): Promise<void> {
    this.throwIfPending();
    this.dependenciesInstalled.push([...repoPaths]);
  }

  async startDevServer(
    repoPath: string,
    instructions: string | null,
  ): Promise<DevServerStartResult> {
    this.throwIfPending();
    this.devServersStarted.push({ repoPath, instructions });
    return this.devServerResult;
  }

  async commitAndPush(input: GitCommitInput): Promise<GitCommitResult> {
    this.throwIfPending();
    this.commits.push(input);
    return { pushed: true, branchName: input.branchName };
  }

  changeDigests: RepoChangeDigest[] = [];
  readonly digestCalls: string[][] = [];
  private digestError: Error | null = null;

  failDigestWith(err: Error): void {
    this.digestError = err;
  }

  async changeDigest(repoPaths: string[]): Promise<RepoChangeDigest[]> {
    this.digestCalls.push([...repoPaths]);
    if (this.digestError) {
      const error = this.digestError;
      this.digestError = null;
      throw error;
    }
    return repoPaths.map(
      (repoPath, index) =>
        this.changeDigests[index] ?? {
          repoPath,
          changedFiles: [],
          diffSummary: '',
          omittedFiles: 0,
        },
    );
  }
}