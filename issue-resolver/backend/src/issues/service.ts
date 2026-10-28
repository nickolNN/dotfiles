import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  DesiredResult,
  Issue,
  IssueDeletingPhase,
  Iteration,
  WorkspaceFile,
} from '@issue-resolver/shared';
import { statusOfIssue } from '@issue-resolver/shared';
import { and, desc, eq } from 'drizzle-orm';
import type { Db } from '../db/client';
import { issueRepositories, issues, iterations } from '../db/schema';
import type { ContainerController } from '../docker/controller';
import { releaseIssueDevPorts } from '../port-allocator';
import type { SseHub } from '../sse/hub';
import { createTarGz, type ArchiveEntry } from '../workspace/archive';
import {
  ALL_RESULT_ARTIFACTS,
  containerNameFor,
  DEFAULT_WORKSPACE_ROOT,
  HTML_ARTIFACT,
  iterationResultDirFor,
  MD_ARTIFACT,
  type ResultArtifact,
  workspaceHostDirFor,
} from '../workspace/paths';
import {
  listWorkspaceFiles,
  workspaceFilePathFor,
} from '../workspace/workspace-files';

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

  getIssue(
    db: Db,
    config: IssueServiceConfig,
    id: string,
  ): Issue | null;

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

function toIteration(row: typeof iterations.$inferSelect): Iteration {
  return {
    id: row.id,
    issue_id: row.issue_id,
    number: row.number,
    context: row.context,
    review_context: row.review_context ?? '',
    is_review_need: !!row.is_review_need,
    steps: row.steps,
    status: row.status,
    model: row.model ?? null,
    step_models: row.step_models ?? undefined,
    thinking_level: row.thinking_level ?? null,
    step_thinking_levels: row.step_thinking_levels ?? undefined,
    worker_count: row.worker_count ?? undefined,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function toIssue(
  db: Db,
  row: typeof issues.$inferSelect,
  workspaceRoot: string,
): Issue {
  const repositories = db
    .select()
    .from(issueRepositories)
    .where(eq(issueRepositories.issue_id, row.id))
    .all()
    .map((repository) => ({
      id: repository.id,
      repository_url: repository.repository_url,
      branch_name: repository.branch_name,
      create_mr: !!repository.create_mr,
      bootstrap_enabled: repository.bootstrap_enabled ?? true,
      created_at: repository.created_at,
      updated_at: repository.updated_at,
    }));

  const iterationRows = db
    .select()
    .from(iterations)
    .where(eq(iterations.issue_id, row.id))
    .all();

  return {
    id: row.id,
    title: row.title,
    description: row.description ?? '',
    desired_result: row.desired_result ?? 'md',
    jira_issue_url: row.jira_issue_url,
    source: row.source ?? null,
    dev_server_port: row.dev_server_port ?? null,
    repositories,
    pipeline_steps: row.pipeline_steps,
    step_models: row.step_models ?? undefined,
    thinking_level: row.thinking_level ?? null,
    step_thinking_levels: row.step_thinking_levels ?? undefined,
    devops_model: row.devops_model ?? null,
    devops_thinking_level: row.devops_thinking_level ?? null,
    status:
      statusOfIssue(iterationRows.map(toIteration), row.status) ??
      row.status ??
      'pending',
    created_at: row.created_at,
    updated_at: row.updated_at,
    workspace_missing: !existsSync(workspaceHostDirFor(workspaceRoot, row.id)),
    worker_count:
      row.worker_count ??
      iterationRows.reduce<typeof iterations.$inferSelect | null>(
        (latest, current) =>
          !latest || current.number > latest.number ? current : latest,
        null,
      )?.worker_count ??
      undefined,
    merge_requests: row.merge_requests ?? null,
  };
}

async function readArtifactFrom(
  dir: string,
  artifact: ResultArtifact,
): Promise<({ body: string; mtime: string } & ResultArtifact) | null> {
  const path = join(dir, artifact.filename);
  try {
    const fileStat = await stat(path);
    const body = await readFile(path, 'utf8');
    return {
      ...artifact,
      body,
      mtime: fileStat.mtime.toISOString().replace(/\.\d{3}Z$/, 'Z'),
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

function artifactResponse(
  read: { body: string; mtime: string } & ResultArtifact,
  source: ResultArtifactResponse['source'],
): ResultArtifactResponse {
  return {
    body: read.body,
    contentType: read.contentType,
    filename: read.filename,
    source,
    mtime: read.mtime,
  };
}

function latestCompletedIterationId(db: Db, issueId: string): string | null {
  const row = db
    .select({ id: iterations.id })
    .from(iterations)
    .where(
      and(
        eq(iterations.issue_id, issueId),
        eq(iterations.status, 'completed'),
      ),
    )
    .orderBy(desc(iterations.number))
    .get();
  return row?.id ?? null;
}

function publishDeleting(
  sse: SseHub,
  id: string,
  phase: IssueDeletingPhase,
  message?: string,
): void {
  sse.publish({
    type: 'issue_deleting',
    issueId: id,
    data: JSON.stringify(message ? { phase, message } : { phase }),
    ts: new Date().toISOString(),
  });
}

async function deleteIssueInBackground(
  db: Db,
  config: IssueServiceConfig,
  id: string,
): Promise<void> {
  const { workspaceRoot, container, sse } = config;

  try {
    const wsPath = workspaceHostDirFor(workspaceRoot, id);
    publishDeleting(sse, id, 'stopping_processes');
    try {
      execSync(
        `pids=$(for p in /proc/*/cwd; do [ "$(readlink "$p" 2>/dev/null)" = "${wsPath}" ] && echo "$(basename $(dirname "$p"))"; done); ` +
          `[ -n "$pids" ] && echo "$pids" | xargs -r kill 2>/dev/null; ` +
          `pkill -f '${wsPath}' 2>/dev/null || true`,
        { stdio: 'ignore' },
      );
    } catch {
    }
    try {
      await new Promise((resolve) => setTimeout(resolve, 500));
      execSync(
        `pids=$(for p in /proc/*/cwd; do [ "$(readlink "$p" 2>/dev/null)" = "${wsPath}" ] && echo "$(basename $(dirname "$p"))"; done); ` +
          `[ -n "$pids" ] && echo "$pids" | xargs -r kill -9 2>/dev/null; ` +
          `pkill -9 -f '${wsPath}' 2>/dev/null || true`,
        { stdio: 'ignore' },
      );
    } catch {
    }

    releaseIssueDevPorts(id);

    publishDeleting(sse, id, 'removing_db_record');
    db.delete(issues).where(eq(issues.id, id)).run();

    publishDeleting(sse, id, 'removing_container');
    try {
      await container.remove(containerNameFor(id));
    } catch (error) {
      console.error('remove container failed', error);
    }
    publishDeleting(sse, id, 'removing_workspace');
    try {
      await rm(wsPath, { recursive: true, force: true });
    } catch (error) {
      console.error('remove workspace failed', error);
    }

    sse.publish({
      type: 'issue_deleted',
      issueId: id,
      data: JSON.stringify({ issueId: id }),
      ts: new Date().toISOString(),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('delete issue failed', error);
    publishDeleting(sse, id, 'error', message);
  }
}

function getIssueRow(
  db: Db,
  id: string,
): (typeof issues.$inferSelect) | undefined {
  return db.select().from(issues).where(eq(issues.id, id)).get();
}

export function createIssueService(): IssueService {
  return {
    resolveConfig(deps) {
      return {
        workspaceRoot: deps.workspaceRoot ?? DEFAULT_WORKSPACE_ROOT,
        container: deps.container,
        sse: deps.sse,
      };
    },

    listIssues(db, config) {
      const rows = db
        .select()
        .from(issues)
        .orderBy(desc(issues.created_at))
        .all();
      return rows.map((row) => toIssue(db, row, config.workspaceRoot));
    },

    getIssue(db, config, id) {
      const row = getIssueRow(db, id);
      return row ? toIssue(db, row, config.workspaceRoot) : null;
    },

    async getResultArtifact(db, config, id) {
      const row = getIssueRow(db, id);
      if (!row) return null;

      const latest = latestCompletedIterationId(db, id);

      const wsDir = workspaceHostDirFor(config.workspaceRoot, id);
      const rootHtml = await readArtifactFrom(wsDir, HTML_ARTIFACT);
      if (rootHtml) {
        return artifactResponse(rootHtml, 'root');
      }

      if (!latest) return null;
      const iterDir = iterationResultDirFor(config.workspaceRoot, id, latest);

      const htmlResult = await readArtifactFrom(iterDir, HTML_ARTIFACT);
      if (htmlResult) {
        return artifactResponse(htmlResult, 'iteration-snapshot');
      }

      const desiredResult: DesiredResult | undefined =
        (row.desired_result as DesiredResult) ?? undefined;
      if (desiredResult === 'md' || desiredResult === undefined) {
        const rootMd = await readArtifactFrom(wsDir, MD_ARTIFACT);
        if (rootMd) {
          return artifactResponse(rootMd, 'root');
        }
        const mdResult = await readArtifactFrom(iterDir, MD_ARTIFACT);
        if (mdResult) {
          return artifactResponse(mdResult, 'iteration-snapshot');
        }
      }

      return null;
    },

    async getMdArtifact(db, config, id) {
      const row = getIssueRow(db, id);
      if (!row) return null;

      const wsDir = workspaceHostDirFor(config.workspaceRoot, id);

      const rootMd = await readArtifactFrom(wsDir, MD_ARTIFACT);
      if (rootMd) {
        return artifactResponse(rootMd, 'root');
      }

      const latest = latestCompletedIterationId(db, id);
      if (!latest) return null;
      const iterDir = iterationResultDirFor(config.workspaceRoot, id, latest);
      const result = await readArtifactFrom(iterDir, MD_ARTIFACT);
      if (!result) return null;

      return artifactResponse(result, 'iteration-snapshot');
    },

    async getResultFiles(db, config, id) {
      const row = getIssueRow(db, id);
      if (!row) return null;

      if (!latestCompletedIterationId(db, id)) return null;

      const exclude = new Set(
        ALL_RESULT_ARTIFACTS.map((a) => a.filename),
      );

      return listWorkspaceFiles(config.workspaceRoot, id, exclude);
    },

    async getResultArchive(db, config, id) {
      const row = getIssueRow(db, id);
      if (!row) {
        throw new Error('issue not found');
      }

      const latest = latestCompletedIterationId(db, id);
      if (!latest) {
        throw new Error('result not found');
      }

      const files = await listWorkspaceFiles(
        config.workspaceRoot,
        id,
        new Set(ALL_RESULT_ARTIFACTS.map((a) => a.filename)),
      );

      const entries: ArchiveEntry[] = [];
      for (const file of files) {
        const abs = workspaceFilePathFor(config.workspaceRoot, id, file.rel_path);
        if (!abs) continue;
        try {
          entries.push({
            name: file.name,
            relPath: file.rel_path,
            body: await readFile(abs),
          });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
          throw error;
        }
      }

      const snapshotDir = iterationResultDirFor(
        config.workspaceRoot,
        id,
        latest,
      );
      for (const artifact of ALL_RESULT_ARTIFACTS) {
        const result = await readArtifactFrom(snapshotDir, artifact);
        if (result) {
          entries.push({
            name: artifact.filename,
            relPath: artifact.filename,
            body: Buffer.from(result.body),
          });
        }
      }

      if (entries.length === 0) {
        throw new Error('result not found');
      }

      return createTarGz(entries);
    },

    async deleteIssue(db, config, id) {
      await deleteIssueInBackground(db, config, id);
    },
  };
}