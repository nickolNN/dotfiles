import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { JiraIssueFull } from '../../jira/client';
import { workspaceHostDirFor } from '../../workspace/paths';

export function jiraMarkdownPath(hostDir: string, key: string): string {
  return join(hostDir, 'jira', `${key}.md`);
}

export function writeJiraWorkspaceFiles(
  workspaceRoot: string,
  issueId: string,
  full: JiraIssueFull,
): void {
  const wsDir = workspaceHostDirFor(workspaceRoot, issueId);
  mkdirSync(join(wsDir, 'jira'), { recursive: true });

  const fullRaw = {
    issue: full.issue.raw ?? full.issue,
    comments: full.comments,
    changelog: full.changelog,
  };
  writeFileSync(
    join(wsDir, 'jira', `${full.issue.key}.json`),
    JSON.stringify(fullRaw, null, 2),
    'utf8',
  );
  writeFileSync(
    jiraMarkdownPath(wsDir, full.issue.key),
    buildJiraMarkdown(full),
    'utf8',
  );
}

function buildJiraMarkdown(full: JiraIssueFull): string {
  const issue = full.issue;
  const raw = issue.raw as Record<string, unknown> | undefined;
  const fields = raw?.fields as Record<string, unknown> | undefined;

  const parts: string[] = [
    `# ${issue.title}`,
    '',
    `**Ключ:** ${issue.key}`,
  ];

  if (fields) {
    const status = (fields.status as { name?: string } | undefined)?.name;
    const priority = (fields.priority as { name?: string } | undefined)?.name;
    const assignee = (fields.assignee as { displayName?: string } | undefined)?.displayName;
    if (status || priority || assignee) {
      parts.push('');
      if (status) parts.push(`**Статус:** ${status}`);
      if (priority) parts.push(`**Приоритет:** ${priority}`);
      if (assignee) parts.push(`**Исполнитель:** ${assignee}`);
    }
  }

  parts.push('', '## Описание', '', issue.summary || '_Описания нет_');

  if (full.comments.length > 0) {
    parts.push('', '## Комментарии', '');
    for (const c of full.comments) {
      const date = c.created ? new Date(c.created).toLocaleString('ru-RU') : '';
      parts.push(`### ${c.author} — ${date}`, '', c.body, '');
    }
  }

  if (full.changelog.length > 0) {
    parts.push('', '## История изменений', '');
    const recent = full.changelog.slice(0, 30);
    for (const entry of recent) {
      const date = entry.created
        ? new Date(entry.created).toLocaleString('ru-RU')
        : '';
      const itemDescs = entry.items.map(
        (i) => `  - ${i.field}: _${i.fromString ?? '—'}_ → **${i.toString ?? '—'}**`,
      );
      parts.push(`**${entry.author}** — ${date}`, ...itemDescs, '');
    }
  }

  return parts.join('\n');
}
