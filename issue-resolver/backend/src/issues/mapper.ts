import { existsSync } from 'node:fs';
import {
  TaskStatus,
  statusOfIssue,
  type Issue,
  type Iteration,
} from '@issue-resolver/shared';
import { eq } from 'drizzle-orm';
import type { Db } from '../db/client';
import { issueRepositories, issues, iterations } from '../db/schema';
import { workspaceHostDirFor } from '../workspace/paths';
import { DesiredResult } from '@issue-resolver/shared';

export function toIteration(row: typeof iterations.$inferSelect): Iteration {
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

export function toIssue(
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
    desired_result: row.desired_result ?? DesiredResult.md,
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
      TaskStatus.pending,
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