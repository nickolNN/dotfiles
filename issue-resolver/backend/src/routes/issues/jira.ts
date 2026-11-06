import { extractIssueKeyFromUrl } from '@issue-resolver/shared';
import type { IssuesContext } from './context';
import { validateJiraUrlSchema } from '../../validation';
import { parseBody } from '../parse-body';
import { DEFAULT_WORKSPACE_ROOT, workspaceHostDirFor } from '../../workspace/paths';
import { jiraMarkdownPath } from './jira-workspace';
import { ROUTE_PATH } from './paths';
import { messageOf } from '../../util/errors';
import { readTextFileOrNullAsync } from '../../util/files';
import { notFound } from '../params';

export function registerIssueJira(ctx: IssuesContext): void {
  const { app, db, deps, jira, service, config } = ctx;

  app.get<{ Params: { id: string } }>(
    `${ROUTE_PATH}/:id/jira-preview`,
    async (request, reply) => {
      const { id } = request.params;
      const issue = service.getIssue(db, config, id);
      if (!issue) {
        return notFound(reply, 'issue not found');
      }
      if (!issue.jira_issue_url) {
        return notFound(reply, 'no jira issue attached');
      }
      const key = extractIssueKeyFromUrl(issue.jira_issue_url);
      if (!key) {
        return notFound(reply, 'cannot extract issue key');
      }
      const wsDir = workspaceHostDirFor(
        deps.workspaceRoot ?? DEFAULT_WORKSPACE_ROOT,
        id,
      );
      const mdPath = jiraMarkdownPath(wsDir, key);
      const content = await readTextFileOrNullAsync(mdPath);
      if (content === null) {
        return notFound(reply, 'jira preview not found');
      }
      return reply.type('text/markdown; charset=utf-8').send(content);
    },
  );

  app.post(`${ROUTE_PATH}/validate-jira`, async (request, reply) => {
    const parsed = parseBody(reply, validateJiraUrlSchema, request.body);
    if (!parsed.ok) return parsed.reply;

    const url = parsed.data.url.trim();
    const key = extractIssueKeyFromUrl(url);

    if (!key) {
      return { url, valid: false, error: 'Не удалось извлечь ключ задачи из URL' };
    }

    try {
      const issue = await jira.fetchIssue(key);
      return { url, valid: true, key, issue };
    } catch (err) {
      return {
        url,
        valid: false,
        key,
        error: `Jira недоступна: ${messageOf(err)}`,
      };
    }
  });
}
