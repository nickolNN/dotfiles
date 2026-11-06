
import {
  asRecord,
  requireArray,
  requireRecord,
  requireString,
} from '../util/records';
import { stringOrNull } from '../util/scalars';

export interface JiraIssue {
  key: string;
  title: string;
  summary: string;
  raw?: unknown;
}

export interface JiraIssueFull {
  issue: JiraIssue;
  comments: JiraComment[];
  changelog: JiraChangelogEntry[];
}

export interface JiraComment {
  id: string;
  author: string;
  created: string;
  body: string;
}

export interface JiraChangelogEntry {
  author: string;
  created: string;
  items: Array<{ field: string; fromString?: string; toString?: string }>;
}

export interface JiraClient {
  fetchIssue(issueKey: string): Promise<JiraIssue>;
  fetchIssueFull(issueKey: string): Promise<JiraIssueFull>;
}

export class FakeJiraClient implements JiraClient {
  readonly calls: string[] = [];
  private readonly issues = new Map<string, JiraIssue>();
  private pendingError: Error | null = null;

  setIssue(key: string, issue: JiraIssue): void {
    this.issues.set(key, issue);
  }

  failNextWith(err: Error): void {
    this.pendingError = err;
  }

  async fetchIssue(issueKey: string): Promise<JiraIssue> {
    this.calls.push(issueKey);
    if (this.pendingError) {
      const err = this.pendingError;
      this.pendingError = null;
      throw err;
    }
    return (
      this.issues.get(issueKey) ?? {
        key: issueKey,
        title: issueKey,
        summary: '',
      }
    );
  }
async fetchIssueFull(issueKey: string): Promise<JiraIssueFull> {
    return {
      issue: await this.fetchIssue(issueKey),
      comments: [],
      changelog: [],
    };
  }
}

interface JiraIssueResponse {
  key?: string;
  fields?: {
    summary?: string;
    description?: string;
  };
}

function issuePayload(value: unknown): {
  issue: JiraIssueResponse;
  raw: Record<string, unknown>;
} {
  const raw = requireRecord(value, 'jira issue response');
  const fields = asRecord(raw.fields);
  return {
    issue: {
      key: stringOrNull(raw.key) ?? undefined,
      fields: fields
        ? {
            summary: stringOrNull(fields.summary) ?? undefined,
            description: stringOrNull(fields.description) ?? undefined,
          }
        : undefined,
    },
    raw,
  };
}

function commentsPayload(value: unknown): JiraComment[] {
  const raw = requireRecord(value, 'jira comments response');
  if (raw.comments === undefined) return [];
  return requireArray(raw.comments, 'jira comments response').map((entry) => {
    const comment = asRecord(entry);
    if (!comment) {
      throw new Error('jira comments response: comment is not an object');
    }
    const author = asRecord(comment.author);
    return {
      id: requireString(comment, 'id', 'jira comment'),
      author:
        stringOrNull(author?.displayName) ??
        stringOrNull(author?.name) ??
        'unknown',
      created: stringOrNull(comment.created) ?? '',
      body: stringOrNull(comment.body) ?? '',
    };
  });
}

function changelogPayload(value: unknown): JiraChangelogEntry[] {
  const raw = requireRecord(value, 'jira changelog response');
  const changelog = asRecord(raw.changelog);
  if (changelog?.histories === undefined) return [];
  return requireArray(changelog.histories, 'jira changelog histories').map(
    (entry) => {
      const history = asRecord(entry);
      if (!history) {
        throw new Error('jira changelog response: history is not an object');
      }
      const author = asRecord(history.author);
      const items =
        history.items === undefined
          ? []
          : requireArray(history.items, 'jira changelog items').map((item) => {
              const change = asRecord(item);
              if (!change) {
                throw new Error(
                  'jira changelog response: item is not an object',
                );
              }
              return {
                field: stringOrNull(change.field) ?? '',
                fromString: stringOrNull(change.fromString) ?? undefined,
                toString: stringOrNull(change.toString) ?? undefined,
              };
            });
      return {
        author:
          stringOrNull(author?.displayName) ??
          stringOrNull(author?.name) ??
          'unknown',
        created: stringOrNull(history.created) ?? '',
        items,
      };
    },
  );
}

export class HttpJiraClient implements JiraClient {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
  ) {}

  async fetchIssue(issueKey: string): Promise<JiraIssue> {
    if (!this.baseUrl) {
      throw new Error('JIRA_BASE_URL не задан — Jira-интеграция не настроена');
    }
    const url = `${this.baseUrl.replace(/\/+$/, '')}/rest/api/2/issue/${encodeURIComponent(issueKey)}`;
    const token = this.token.replace(/^Token\s+/i, '');
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${token}`,
      },
    });
    if (!response.ok) {
      throw new Error(`jira issue fetch failed: ${response.status}`);
    }
    const { issue: data, raw } = issuePayload(await response.json());
    return {
      key: data.key ?? issueKey,
      title: data.fields?.summary ?? '',
      summary: data.fields?.description ?? '',
      raw,
    };
  }

  async fetchIssueFull(issueKey: string): Promise<JiraIssueFull> {
    const issue = await this.fetchIssue(issueKey);
    const base = this.baseUrl.replace(/\/+$/, '');
    const token = this.token.replace(/^Token\s+/i, '');
    const headers = {
      Accept: 'application/json',
      Authorization: `Bearer ${token}`,
    };

    let comments: JiraComment[] = [];
    try {
      const res = await fetch(
        `${base}/rest/api/2/issue/${encodeURIComponent(issueKey)}/comment`,
        { headers },
      );
      if (res.ok) {
        comments = commentsPayload(await res.json());
      }
    } catch {
    }

    let changelog: JiraChangelogEntry[] = [];
    try {
      const res = await fetch(
        `${base}/rest/api/2/issue/${encodeURIComponent(issueKey)}?expand=changelog`,
        { headers },
      );
      if (res.ok) {
        changelog = changelogPayload(await res.json());
      }
    } catch {
    }

    return { issue, comments, changelog };
  }
}