import type { Issue, WorkspaceFile } from '@issue-resolver/shared';
import type { Db } from '../db/client';
import type { ContainerController } from '../docker/controller';
import type { SseHub } from '../sse/hub';

export interface IssueServiceConfig {
  workspaceRoot: string;
  container: ContainerController;
  sse: SseHub;
}

export interface ResultArtifactResponse {
  body: string;
  contentType: string;
  filename: string;
  source: 'root' | 'iteration-snapshot';
  mtime: string;
}

export interface IssueService {
  resolveConfig(deps: {
    workspaceRoot?: string;
    container: ContainerController;
    sse: SseHub;
  }): IssueServiceConfig;

  listIssues(db: Db, config: IssueServiceConfig): Issue[];

  getIssue(db: Db, config: IssueServiceConfig, id: string): Issue | null;

  getResultArtifact(
    db: Db,
    config: IssueServiceConfig,
    id: string,
  ): Promise<ResultArtifactResponse | null>;

  getMdArtifact(
    db: Db,
    config: IssueServiceConfig,
    id: string,
  ): Promise<ResultArtifactResponse | null>;

  getResultFiles(
    db: Db,
    config: IssueServiceConfig,
    id: string,
  ): Promise<WorkspaceFile[] | null>;

  getResultArchive(
    db: Db,
    config: IssueServiceConfig,
    id: string,
  ): Promise<Buffer>;

  deleteIssue(
    db: Db,
    config: IssueServiceConfig,
    id: string,
  ): Promise<void>;
}