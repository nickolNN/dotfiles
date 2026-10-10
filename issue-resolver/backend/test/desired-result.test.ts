import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DesiredResult } from '@issue-resolver/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { createDb } from '../src/db/client';
import type { Db } from '../src/db/client';
import { issues } from '../src/db/schema';

const ROUTE_PATH = '/issue-resolver/api/v1/issues';

const REPOSITORY = {
  repository_url: 'https://github.com/acme/app.git',
  base_branch: 'main',
};

const openApps: Array<{ close: () => Promise<void> }> = [];
const tempDirs: string[] = [];

function makeApp(deps: { workspaceRoot?: string } = {}): ReturnType<
  typeof buildApp
> {
  const app = buildApp(createDb(':memory:'), deps);
  openApps.push(app);
  return app;
}

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'issue-resolver-result-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(openApps.splice(0).map((app) => app.close()));
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

const post = (app: ReturnType<typeof buildApp>, payload: object) =>
  app.inject({ method: 'POST', url: ROUTE_PATH, payload });

/** Прямой insert issue (без HTTP) — фоновая итерация не запускается. */
function seedIssue(
  db: Db,
  issueId: string,
  desiredResult: DesiredResult = 'md',
): void {
  const now = new Date().toISOString();
  db.insert(issues)
    .values({
      id: issueId,
      title: 'Задача с результатом',
      desired_result: desiredResult,
      jira_issue_url: null,
      pipeline_steps: ['resolve'],
      container_name: null,
      status: 'pending',
      created_at: now,
      updated_at: now,
    })
    .run();
}

async function writeArtifact(
  root: string,
  issueId: string,
  filename: string,
  content: string,
): Promise<void> {
  const dir = join(root, issueId);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, filename), content);
}

describe('POST /issues — desired_result', () => {
  it('не указан → сохраняется как md, pr из шагов убирается', async () => {
    const app = makeApp();

    const created = await post(app, {
      title: 'По умолчанию md',
      repositories: [{ ...REPOSITORY, create_mr: true }],
    });

    expect(created.statusCode).toBe(201);
    const body = created.json();
    expect(body.desired_result).toBe('md');
    expect(body.pipeline_steps).not.toContain('pr');

    const fetched = await app.inject({
      method: 'GET',
      url: `${ROUTE_PATH}/${body.id}`,
    });
    expect(fetched.json().desired_result).toBe('md');
  });

  it("desired_result:'md' с репозиторием → 201 и сохранён md", async () => {
    const app = makeApp();

    const created = await post(app, {
      title: 'Markdown-отчёт',
      desired_result: 'md',
      repositories: [REPOSITORY],
    });

    expect(created.statusCode).toBe(201);
    const body = created.json();
    expect(body.desired_result).toBe('md');
    expect(body.pipeline_steps).not.toContain('pr');

    const fetched = await app.inject({
      method: 'GET',
      url: `${ROUTE_PATH}/${body.id}`,
    });
    expect(fetched.json().desired_result).toBe('md');
  });

  it("desired_result:'pr' с репозиторием → pr гарантирован и сохранён", async () => {
    const app = makeApp();

    const created = await post(app, {
      title: 'Нужен PR',
      desired_result: 'pr',
      repositories: [REPOSITORY],
    });

    expect(created.statusCode).toBe(201);
    const body = created.json();
    expect(body.desired_result).toBe('pr');
    expect(body.pipeline_steps).toContain('pr');

    const fetched = await app.inject({
      method: 'GET',
      url: `${ROUTE_PATH}/${body.id}`,
    });
    expect(fetched.json().desired_result).toBe('pr');
    expect(fetched.json().pipeline_steps).toContain('pr');
  });

  it("desired_result:'html' + create_mr:true → pr из шагов убран", async () => {
    const app = makeApp();

    const created = await post(app, {
      title: 'Только html',
      desired_result: 'html',
      repositories: [{ ...REPOSITORY, create_mr: true }],
    });

    expect(created.statusCode).toBe(201);
    expect(created.json().pipeline_steps).not.toContain('pr');
  });

  it("desired_result:'pr' без репозиториев → 400 «PR требует хотя бы один репозиторий»", async () => {
    const app = makeApp();

    const response = await post(app, {
      title: 'PR без репо',
      desired_result: 'pr',
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toContain(
      'PR требует хотя бы один репозиторий',
    );
  });

  it('невалидное значение enum → 400', async () => {
    const app = makeApp();

    const response = await post(app, {
      title: 'Кривой desired_result',
      desired_result: 'pdf',
      repositories: [REPOSITORY],
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toContain('desired_result');
  });
});

describe('GET /issues/:id/result', () => {
  it('200: html → report.html как text/html, inline', async () => {
    const root = await makeTempDir();
    const db = createDb(':memory:');
    const app = buildApp(db, { workspaceRoot: root });
    openApps.push(app);
    seedIssue(db, 'issue-html', 'html');
    await writeArtifact(root, 'issue-html', 'report.html', '<h1>Отчёт</h1>');

    const response = await app.inject({
      method: 'GET',
      url: `${ROUTE_PATH}/issue-html/result`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/html');
    expect(response.headers['content-disposition']).toBe('inline');
    expect(response.body).toBe('<h1>Отчёт</h1>');
  });

  it('200: md → report.md как text/markdown, inline', async () => {
    const root = await makeTempDir();
    const db = createDb(':memory:');
    const app = buildApp(db, { workspaceRoot: root });
    openApps.push(app);
    seedIssue(db, 'issue-md', 'md');
    await writeArtifact(root, 'issue-md', 'report.md', '# Отчёт');

    const response = await app.inject({
      method: 'GET',
      url: `${ROUTE_PATH}/issue-md/result`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/markdown');
    expect(response.headers['content-disposition']).toBe('inline');
    expect(response.body).toBe('# Отчёт');
  });

  it('download: attachment с именем файла по desired_result', async () => {
    const root = await makeTempDir();
    const db = createDb(':memory:');
    const app = buildApp(db, { workspaceRoot: root });
    openApps.push(app);
    seedIssue(db, 'issue-md-dl', 'md');
    await writeArtifact(root, 'issue-md-dl', 'report.md', '# Скачать');

    const response = await app.inject({
      method: 'GET',
      url: `${ROUTE_PATH}/issue-md-dl/result/download`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/markdown');
    expect(response.headers['content-disposition']).toBe(
      'attachment; filename="report.md"',
    );
    expect(response.body).toBe('# Скачать');
  });

  it('404: report.html отсутствует', async () => {
    const root = await makeTempDir();
    const db = createDb(':memory:');
    const app = buildApp(db, { workspaceRoot: root });
    openApps.push(app);
    seedIssue(db, 'issue-result-2', 'html');

    const response = await app.inject({
      method: 'GET',
      url: `${ROUTE_PATH}/issue-result-2/result`,
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: 'result not found' });
  });

  it('404: задача не найдена', async () => {
    const app = makeApp();

    const response = await app.inject({
      method: 'GET',
      url: `${ROUTE_PATH}/missing-issue/result`,
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: 'issue not found' });
  });
});