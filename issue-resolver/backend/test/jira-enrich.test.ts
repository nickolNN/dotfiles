import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import type { Db } from '../src/db/client';
import { createDb } from '../src/db/client';
import { FakeJiraClient } from '../src/jira/client';

const ENDPOINT = '/issue-resolver/api/v1/issues';

const JIRA_URL = 'https://jira.example.com/browse/KLA-5672';

const payload = (overrides: Record<string, unknown> = {}) => ({
  jira_issue_url: JIRA_URL,
  repositories: [
    { repository_url: 'https://github.com/o/r.git', base_branch: 'main' },
  ],
  ...overrides,
});

const openApps: Array<{ close: () => Promise<void> }> = [];

function makeApp(deps: Parameters<typeof buildApp>[1] = {}): {
  app: ReturnType<typeof buildApp>;
  db: Db;
} {
  const db = createDb(':memory:');
  const app = buildApp(db, deps);
  openApps.push(app);
  return { app, db };
}

afterEach(async () => {
  await Promise.all(openApps.splice(0).map((app) => app.close()));
});

describe('POST /issues — Jira enrichment', () => {
  it('jira_issue_url без title → title и context из Jira', async () => {
    const jira = new FakeJiraClient();
    jira.setIssue('KLA-5672', {
      key: 'KLA-5672',
      title: 'Курсор',
      summary: 'desc',
    });
    const { app } = makeApp({ jira });

    const response = await app.inject({
      method: 'POST',
      url: ENDPOINT,
      payload: payload(),
    });

    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body.title).toBe('Курсор');
    // Creation обогащает title/context; фоновый прогон дополнительно берёт текст для refine.
    expect(jira.calls).toContain('KLA-5672');
  });

  it('Jira падает → 201 с фолбэком title = ключ (не 500)', async () => {
    const jira = new FakeJiraClient();
    jira.failNextWith(new Error('jira 401'));
    const { app } = makeApp({ jira });

    const response = await app.inject({
      method: 'POST',
      url: ENDPOINT,
      payload: payload(),
    });

    expect(response.statusCode).toBe(201);
    expect(response.json().title).toBe('KLA-5672');
  });

  it('jira не передан в deps → фолбэк title = ключ, без краха', async () => {
    const { app } = makeApp();

    const response = await app.inject({
      method: 'POST',
      url: ENDPOINT,
      payload: payload(),
    });

    expect(response.statusCode).toBe(201);
    expect(response.json().title).toBe('KLA-5672');
  });

  it('явный title → используется он, Jira не переопределяет title', async () => {
    const jira = new FakeJiraClient();
    jira.setIssue('KLA-5672', { key: 'KLA-5672', title: 'Из Jira', summary: '' });
    const { app } = makeApp({ jira });

    const response = await app.inject({
      method: 'POST',
      url: ENDPOINT,
      payload: payload({ title: 'Явный заголовок' }),
    });

    expect(response.statusCode).toBe(201);
    expect(response.json().title).toBe('Явный заголовок');
  });
});