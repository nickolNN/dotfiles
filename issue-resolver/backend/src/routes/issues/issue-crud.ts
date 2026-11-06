import { randomUUID } from 'node:crypto';
import { TaskStatus } from '@issue-resolver/shared';
import { eq } from 'drizzle-orm';
import type { IssuesContext } from './context';
import { issueRepositories, issues } from '../../db/schema';
import { updateIssueRequestSchema } from '../../validation';
import { ROUTE_PATH } from './paths';
import { resolveRepositoryInput } from './repository-input';
import { conflict, draftOnlyConflict, notFound } from '../params';
import { parseBody } from '../parse-body';
import { nowIso } from '../../db/rows';

export function registerIssueCrud(ctx: IssuesContext): void {
  const { app, db, service, config } = ctx;
  app.get(ROUTE_PATH, async () => service.listIssues(db, config));

  app.get<{ Params: { id: string } }>(
    `${ROUTE_PATH}/:id`,
    async (request, reply) => {
      const issue = service.getIssue(db, config, request.params.id);
      if (!issue) {
        return notFound(reply, 'issue not found');
      }
      return issue;
    },
  );

  app.delete<{ Params: { id: string } }>(
    `${ROUTE_PATH}/:id`,
    async (request, reply) => {
      const { id } = request.params;
      if (!service.getIssue(db, config, id)) {
        return notFound(reply, 'issue not found');
      }

      void service.deleteIssue(db, config, id);
      return reply.code(202).send({ ok: true });
    },
  );

  app.put<{
    Params: { id: string };
    Body: Record<string, unknown>;
  }>(
    `${ROUTE_PATH}/:id`,
    async (request, reply) => {
      const { id } = request.params;

      const issue = service.getIssue(db, config, id);
      if (!issue) {
        return notFound(reply, 'issue not found');
      }
      if (issue.status !== TaskStatus.draft) {
        return conflict(reply, 'only draft issues can be edited');
      }

      const claimed = draftOnlyConflict(reply, db, id);
      if (claimed) return claimed;

      const parsed = parseBody(reply, updateIssueRequestSchema, request.body);
      if (!parsed.ok) return parsed.reply;

      const body = parsed.data;
      const now = nowIso();

      db.transaction((tx) => {
        const setData: Record<string, unknown> = { updated_at: now };
        if (body.title !== undefined) setData.title = body.title;
        if (body.description !== undefined) setData.description = body.description;
        if (body.desired_result !== undefined)
          setData.desired_result = body.desired_result;
        if (body.jira_issue_url !== undefined)
          setData.jira_issue_url = body.jira_issue_url;
        if (body.pipeline_steps !== undefined)
          setData.pipeline_steps = body.pipeline_steps;
        if (body.step_models !== undefined)
          setData.step_models = body.step_models;
        if (body.thinking_level !== undefined)
          setData.thinking_level = body.thinking_level;
        if (body.step_thinking_levels !== undefined)
          setData.step_thinking_levels = body.step_thinking_levels;
        if (body.tag_id !== undefined) setData.tag_id = body.tag_id;
        if (body.devops_model !== undefined)
          setData.devops_model = body.devops_model;
        if (body.devops_thinking_level !== undefined)
          setData.devops_thinking_level =
            body.devops_thinking_level;
        if (body.worker_count !== undefined)
          setData.worker_count = body.worker_count;

        tx.update(issues)
          .set(setData)
          .where(eq(issues.id, id))
          .run();

        if (body.repositories !== undefined) {
          tx.delete(issueRepositories)
            .where(eq(issueRepositories.issue_id, id))
            .run();

          const repoRows = body.repositories.map((repo) => {
            const resolved = resolveRepositoryInput(db, repo);
            if (!resolved) {
              throw new Error(`Repository not found: ${repo.repo_id}`);
            }
            const { repositoryUrl, baseBranch } = resolved;

            if (!repositoryUrl || !baseBranch) {
              throw new Error(
                `repository_url и base_branch обязательны для репозитория`,
              );
            }

            return {
              id: randomUUID(),
              issue_id: id,
              repository_url: repositoryUrl,
              branch_name: baseBranch,
              create_mr: repo.create_mr ?? false,
              bootstrap_enabled: repo.bootstrap_enabled ?? true,
              created_at: now,
              updated_at: now,
            };
          });

          if (repoRows.length > 0) {
            tx.insert(issueRepositories).values(repoRows).run();
          }
        }
      });

      const updated = service.getIssue(db, config, id);
      return reply.status(200).send(updated);
    },
  );
}
