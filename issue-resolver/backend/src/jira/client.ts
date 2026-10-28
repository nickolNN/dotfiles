
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
    const data = (await response.json()) as JiraIssueResponse;
    return {
      key: data.key ?? issueKey,
      title: data.fields?.summary ?? '',
      summary: data.fields?.description ?? '',
      raw: data,
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
        const data = (await res.json()) as {
          comments?: Array<{
            id: string;
            author?: { displayName?: string; name?: string };
            created?: string;
            body?: string;
          }>;
        };
        comments =
          data.comments?.map((c) => ({
            id: c.id,
            author: c.author?.displayName ?? c.author?.name ?? 'unknown',
            created: c.created ?? '',
            body: c.body ?? '',
          })) ?? [];
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
        const data = (await res.json()) as {
          changelog?: {
            histories?: Array<{
              author?: { displayName?: string; name?: string };
              created?: string;
              items?: Array<{
                field?: string;
                fromString?: string;
                toString?: string;
              }>;
            }>;
          };
        };
        changelog =
          data.changelog?.histories?.map((h) => ({
            author: h.author?.displayName ?? h.author?.name ?? 'unknown',
            created: h.created ?? '',
            items:
              h.items?.map((i) => ({
                field: i.field ?? '',
                fromString: i.fromString,
                toString: i.toString,
              })) ?? [],
          })) ?? [];
      }
    } catch {
    }

    return { issue, comments, changelog };
  }
}