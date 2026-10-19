/**
 * Сервис задач — глубокий модуль, скрывающий повторяющуюся сантехнику
 * из роутов: поиск задачи с 404, чтение артефактов результата,
 * фоновое удаление.
 *
 * Интерфейс: 7 методов. За швом: DB-запросы, файловые операции,
 * defaulting workspaceRoot, 6-шаговое чтение результата.
 */
import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile, rm } from 'node:fs/promises';
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
  containerNameFor,
  DEFAULT_WORKSPACE_ROOT,
  iterationResultDirFor,
  resultArtifactFor,
  type ResultArtifact,
  workspaceHostDirFor,
} from '../workspace/paths';
import {
  listWorkspaceFiles,
  workspaceFilePathFor,
} from '../workspace/workspace-files';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface IssueServiceConfig {
  workspaceRoot: string;
  container: ContainerController;
  sse: SseHub;
}

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

export interface ResultArtifactResponse {
  body: string;
  contentType: string;
  filename: string;
}

// ---------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

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
    status:
      statusOfIssue(iterationRows.map(toIteration), row.status) ??
      row.status ??
      'pending',
    created_at: row.created_at,
    updated_at: row.updated_at,
    workspace_missing: !existsSync(workspaceHostDirFor(workspaceRoot, row.id)),
    worker_count:
      iterationRows.reduce<typeof iterations.$inferSelect | null>(
        (latest, current) =>
          !latest || current.number > latest.number ? current : latest,
        null,
      )?.worker_count ?? undefined,
  };
}

async function readArtifactFrom(
  dir: string,
  artifact: ResultArtifact,
): Promise<({ body: string } & ResultArtifact) | null> {
  const path = join(dir, artifact.filename);
  try {
    const body = await readFile(path, 'utf8');
    return { ...artifact, body };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw error;
  }
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
      // Процессов может не быть — это нормально.
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
      // pkill -9, нет процессов — ok.
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

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

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

      const desiredResult: DesiredResult = (row.desired_result ?? 'md') as DesiredResult;
      const artifact = resultArtifactFor(desiredResult);
      if (!artifact) return null;

      const latest = latestCompletedIterationId(db, id);
      if (!latest) return null;

      const dir = iterationResultDirFor(
        config.workspaceRoot,
        id,
        latest,
      );
      const result = await readArtifactFrom(dir, artifact);
      if (!result) return null;

      return {
        body: result.body,
        contentType: result.contentType,
        filename: result.filename,
      };
    },

    async getResultFiles(db, config, id) {
      const row = getIssueRow(db, id);
      if (!row) return null;

      if (!latestCompletedIterationId(db, id)) return null;

      const desiredResult: DesiredResult = (row.desired_result ?? 'md') as DesiredResult;
      const artifact = resultArtifactFor(desiredResult);

      return listWorkspaceFiles(
        config.workspaceRoot,
        id,
        new Set([artifact?.filename ?? '']),
      );
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

      const desiredResult: DesiredResult = (row.desired_result ?? 'md') as DesiredResult;
      const artifact = resultArtifactFor(desiredResult);
      const files = await listWorkspaceFiles(
        config.workspaceRoot,
        id,
        new Set([artifact?.filename ?? '']),
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

      if (artifact) {
        const result = await readArtifactFrom(
          iterationResultDirFor(config.workspaceRoot, id, latest),
          artifact,
        );
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