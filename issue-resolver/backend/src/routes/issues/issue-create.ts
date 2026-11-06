import { randomUUID } from 'node:crypto';

import { DesiredResult } from '@issue-resolver/shared';
import { extractIssueKeyFromUrl, TaskStatus } from '@issue-resolver/shared';
import type { IssueRepositorySelection } from '../../db/issue-repositories.repo';
import type { IssuesContext } from './context';
import { issueRepositories, issues, iterations } from '../../db/schema';
import type { JiraIssueFull } from '../../jira/client';
import { createIssueRequestSchema } from '../../validation';
import { readRequestPayload } from '../multipart';
import {
  startIteration,
  startIterationIssue,
} from '../../workflow/start-iteration';
import { DEFAULT_WORKSPACE_ROOT } from '../../workspace/paths';
import { saveAttachments } from './attachments';
import { writeJiraWorkspaceFiles } from './jira-workspace';
import { ROUTE_PATH } from './paths';
import { resolvePipelineSteps } from './pipeline';
import { resolveRepositoryInput } from './repository-input';
import { badRequest, unprocessable } from '../params';
import { parseBody } from '../parse-body';
import { nowIso } from '../../db/rows';

export function registerIssueCreate(ctx: IssuesContext): void {
  const { app, db, deps, jira } = ctx;
  app.post(ROUTE_PATH, async (request, reply) => {
    const requestPayload = await readRequestPayload(request);
    if (!requestPayload.ok) {
      return badRequest(reply, requestPayload.error);
    }

    const parsed = parseBody(
      reply,
      createIssueRequestSchema,
      requestPayload.body,
    );
    if (!parsed.ok) return parsed.reply;

    const body = parsed.data;
    const explicitTitle = body.title?.trim();
    const jiraIssueUrl = body.jira_issue_url ?? null;

    let title = explicitTitle ?? '';
    let additionalContext = body.additional_context ?? '';
    const description = body.additional_context ?? '';
    let jiraFull: JiraIssueFull | null = null;

    if (!explicitTitle && jiraIssueUrl) {
      const key = extractIssueKeyFromUrl(jiraIssueUrl);
      if (key) {
        try {
          const full = await jira.fetchIssueFull(key);
          jiraFull = full;
          title = full.issue.title || key;
          if (full.issue.summary) {
            additionalContext = additionalContext
              ? `${additionalContext}\n\n${full.issue.summary}`
              : full.issue.summary;
          }
        } catch {
          title = key;
        }
      }
    }

    if (!jiraFull && jiraIssueUrl) {
      const key = extractIssueKeyFromUrl(jiraIssueUrl);
      if (key) {
        try {
          jiraFull = await jira.fetchIssueFull(key);
        } catch (error) {
          void error;
        }
      }
    }

    if (!title) {
      return badRequest(
        reply,
        'Не удалось определить title: передайте title или jira_issue_url с ключом тикета',
      );
    }

    const isReviewNeed = body.is_review_need ?? false;
    const reviewContext = body.review_context ?? '';
    const desiredResult: DesiredResult = body.desired_result ?? DesiredResult.md;
    const repositories: IssueRepositorySelection[] = [];
    for (const repository of body.repositories ?? []) {
      const resolved = resolveRepositoryInput(db, repository);
      if (!resolved) {
        return unprocessable(reply, 'Repository not found');
      }
      const { repositoryUrl, baseBranch } = resolved;
      if (!repositoryUrl) {
        return badRequest(
          reply,
          'repository_url обязателен, если не указан repo_id',
        );
      }
      if (!baseBranch) {
        return unprocessable(
          reply,
          `Repository ${repository.repo_id ?? repositoryUrl} не содержит default branch — укажите base_branch`,
        );
      }
      repositories.push({
        repository_url: repositoryUrl,
        base_branch: baseBranch,
        create_mr: repository.create_mr ?? false,
        bootstrap_enabled: repository.bootstrap_enabled ?? true,
      });
    }

    const runImmediately = body.run_immediately !== false;
    const createMr = repositories.some((repository) => repository.create_mr);
    const pipelineSteps = resolvePipelineSteps(body.pipeline_steps, createMr);
    const now = nowIso();
    const issueId = randomUUID();
    const iterationId = runImmediately ? randomUUID() : null;
    const issueStatus: TaskStatus = runImmediately ? TaskStatus.pending : TaskStatus.draft;

    const repositoryRows = repositories.map((repository) => ({
      id: randomUUID(),
      repository_url: repository.repository_url,
      branch_name: repository.base_branch,
      create_mr: repository.create_mr,
      bootstrap_enabled: repository.bootstrap_enabled,
      created_at: now,
      updated_at: now,
    }));

    db.transaction((tx) => {
      tx.insert(issues)
        .values({
          id: issueId,
          title,
          description,
          desired_result: desiredResult,
          jira_issue_url: jiraIssueUrl,
          pipeline_steps: pipelineSteps,
          step_models: body.step_models ?? null,
          thinking_level: body.thinking_level ?? null,
          step_thinking_levels: body.step_thinking_levels ?? null,
          devops_model: body.devops_model ?? null,
          devops_thinking_level:
            body.devops_thinking_level ?? null,
          worker_count: body.worker_count ?? undefined,
          container_name: null,
          source: jiraIssueUrl ? 'jira' : null,
          tag_id: body.tag_id ?? null,
          status: issueStatus,
          created_at: now,
          updated_at: now,
        })
        .run();

      if (repositoryRows.length > 0) {
        tx.insert(issueRepositories)
          .values(
            repositoryRows.map((repository) => ({
              ...repository,
              issue_id: issueId,
            })),
          )
          .run();
      }

      if (runImmediately) {
        tx.insert(iterations)
          .values({
            id: iterationId!,
            issue_id: issueId,
            number: 1,
            context: additionalContext,
            review_context: reviewContext,
            is_review_need: isReviewNeed,
            steps: pipelineSteps,
            model: body.model ?? null,
            step_models: body.step_models ?? null,
            thinking_level: body.thinking_level ?? null,
            step_thinking_levels: body.step_thinking_levels ?? null,
            worker_count: body.worker_count ?? undefined,
            status: TaskStatus.pending,
            created_at: now,
            updated_at: now,
          })
          .run();
      }
    });

    await saveAttachments(db, deps, issueId, iterationId, 1, requestPayload.files);

    if (runImmediately) {
      const createdIterationId = iterationId!;
      startIteration(db, deps, {
        issue: startIterationIssue({
          id: issueId,
          title,
          pipeline_steps: pipelineSteps,
          description,
          desired_result: desiredResult,
          jira_issue_url: jiraIssueUrl,
        }),
        iteration: {
          id: createdIterationId,
          issueId,
          number: 1,
          context: additionalContext,
          steps: pipelineSteps,
          reviewContext,
          isReviewNeed,
          worker_count: body.worker_count ?? undefined,
        },
        models: {
          model: body.model,
          step_models: body.step_models,
          thinking_level: body.thinking_level,
          step_thinking_levels: body.step_thinking_levels,
        },
        repositories,
        devops: {
          devopsModel: body.devops_model,
          devopsThinkingLevel: body.devops_thinking_level,
        },
        beforePrepare: () => {
          if (!jiraFull) return;
          writeJiraWorkspaceFiles(
            deps.workspaceRoot ?? DEFAULT_WORKSPACE_ROOT,
            issueId,
            jiraFull,
          );
        },
      });
    }

    return reply.status(201).send({
      id: issueId,
      title,
      description,
      desired_result: desiredResult,
      jira_issue_url: jiraIssueUrl,
      source: jiraIssueUrl ? 'jira' : null,
      repositories: repositoryRows,
      pipeline_steps: pipelineSteps,
      step_models: body.step_models,
      thinking_level: body.thinking_level ?? null,
      step_thinking_levels: body.step_thinking_levels,
      status: issueStatus,
      created_at: now,
      updated_at: now,
    });
  });
}
