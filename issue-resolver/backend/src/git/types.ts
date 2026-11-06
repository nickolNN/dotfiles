import type { WorkspaceProgressStatus } from '@issue-resolver/shared';

export interface GitPrepareInput {
  repoUrls: string[];
  baseBranches: string[];
  workspacePath: string;
  onRepoProgress?: (
    repoUrl: string,
    status: WorkspaceProgressStatus,
  ) => void;
}

export interface GitPrepareResult {
  repoWorkspaces: { repoUrl: string; path: string; branch: string }[];
}

export interface GitCommitInput {
  repoPath: string;
  branchName: string;
  commitMessage: string;
  squashBase?: string;
}

export interface GitCommitResult {
  pushed: boolean;
  branchName: string;
}

export interface DevServerStartResult {
  port: number | null;
  message?: string;
}

export interface RepoChangeDigest {
  repoPath: string;
  changedFiles: string[];
  diffSummary: string;
  omittedFiles: number;
}

export interface GitService {
  prepare(input: GitPrepareInput): Promise<GitPrepareResult>;
  installDependencies(repoPaths: string[]): Promise<void>;
  commitAndPush(input: GitCommitInput): Promise<GitCommitResult>;
  changeDigest(repoPaths: string[]): Promise<RepoChangeDigest[]>;
  startDevServer(
    repoPath: string,
    instructions: string | null,
  ): Promise<DevServerStartResult>;
}