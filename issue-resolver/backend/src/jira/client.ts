/**
 * Jira-клиент (Фаза 6): подтягивает задачу по ключу. Реальный клиент ходит в
 * Jira REST API v3 через global fetch — без новых зависимостей.
 */

export interface JiraIssue {
  key: string;
  title: string;
  summary: string;
}

export interface JiraClient {
  fetchIssue(issueKey: string): Promise<JiraIssue>;
}

/**
 * In-memory-клиент для тестов: хранит задачи в Map, неизвестный ключ даёт
 * дефолт. `failNextWith` позволяет проверить путь ошибки.
 */
export class FakeJiraClient implements JiraClient {
  readonly calls: string[] = [];
  private readonly issues = new Map<string, JiraIssue>();
  private pendingError: Error | null = null;

  /** Кладёт задачу, которую вернёт fetchIssue для этого ключа. */
  setIssue(key: string, issue: JiraIssue): void {
    this.issues.set(key, issue);
  }

  /** Следующий fetchIssue отклонится этой ошибкой. */
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
}

interface JiraIssueResponse {
  key?: string;
  fields?: {
    summary?: string;
    description?: string;
  };
}

/**
 * Реальная интеграция через global fetch. Юнит-тестами не покрывается.
 *
 * TODO(§10): token в реальном коде приходит из secrets-конфига (не env).
 * TODO(auth): перейти на Bearer при переходе на Jira Cloud OAuth/scoped tokens
 *   и добавить User-Agent; сейчас — Basic/Bearer-совместимый заголовок.
 *
 * GET {baseUrl}/rest/api/3/issue/{issueKey}
 *   headers: Authorization: Bearer <token>, Accept: application/json
 *   title   = fields.summary
 *   summary = fields.description ?? ''
 */
export class HttpJiraClient implements JiraClient {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
  ) {}

  async fetchIssue(issueKey: string): Promise<JiraIssue> {
    const url = `${this.baseUrl.replace(/\/+$/, '')}/rest/api/3/issue/${encodeURIComponent(issueKey)}`;
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${this.token}`,
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
    };
  }
}