import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DesiredResult, TaskStatus } from '@issue-resolver/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { createDb } from '../src/db/client';
import type { Db } from '../src/db/client';
import { issues, iterations } from '../src/db/schema';

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

function seedIterationWithStatus(
  db: Db,
  issueId: string,
  number: number,
  status: TaskStatus,
): string {
  const iterationId = `${issueId}-iter-${number}`;
  const now = new Date().toISOString();
  db.insert(iterations)
    .values({
      id: iterationId,
      issue_id: issueId,
      number,
      context: '',
      review_context: '',
      is_review_need: false,
      steps: ['resolve'],
      status,
      created_at: now,
      updated_at: now,
    })
    .run();
  return iterationId;
}

function seedCompletedIteration(
  db: Db,
  issueId: string,
  number: number,
): string {
  return seedIterationWithStatus(db, issueId, number, 'completed');
}

async function writeSnapshot(
  root: string,
  issueId: string,
  iterationId: string,
  filename: string,
): Promise<void> {
  const dir = join(root, issueId, '.iteration-results', iterationId);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, filename), 'x');
}

async function setupResult(
  desiredResult: DesiredResult,
  filename: string,
): Promise<{ app: ReturnType<typeof buildApp>; db: Db; root: string }> {
  const root = await makeTempDir();
  const db = createDb(':memory:');
  const app = buildApp(db, { workspaceRoot: root });
  openApps.push(app);
  seedIssue(db, 'issue-1', desiredResult);
  const iterationId = seedCompletedIteration(db, 'issue-1', 1);
  await writeSnapshot(root, 'issue-1', iterationId, filename);
  return { app, db, root };
}

describe('POST /issues — desired_result', () => {
  it('не указан → сохраняется как md, pr остаётся если create_mr:true', async () => {
    const app = makeApp();

    const created = await post(app, {
      title: 'По умолчанию md',
      repositories: [{ ...REPOSITORY, create_mr: true }],
    });

    expect(created.statusCode).toBe(201);
  });

  it("desired_result:'md' с репозиторием → 201 и сохранён md", async () => {
    const app = makeApp();

    const created = await post(app, {
      title: 'Markdown-отчёт',
      desired_result: 'md',
      repositories: [REPOSITORY],
    });

    expect(created.statusCode).toBe(201);
  });

  it("desired_result:'pr' больше не в enum → 400", async () => {
    const app = makeApp();

    const response = await post(app, {
      title: 'Устаревший PR',
      desired_result: 'pr',
      repositories: [REPOSITORY],
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toContain('desired_result');
  });

  it("desired_result:'html' + create_mr:true → pr добавляется по create_mr", async () => {
    const app = makeApp();

    const created = await post(app, {
      title: 'Только html',
      desired_result: 'html',
      repositories: [{ ...REPOSITORY, create_mr: true }],
    });

    expect(created.statusCode).toBe(201);
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
  it('200: html-снапшот последней итерации → report.html как text/html, inline', async () => {
    const { app } = await setupResult('html', 'report.html');

    const response = await app.inject({
      method: 'GET',
      url: `${ROUTE_PATH}/issue-1/result`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/html');
    expect(response.headers['content-disposition']).toBe('inline');
  });

  it('200: md-снапшот последней итерации → report.md как text/markdown, inline', async () => {
    const { app } = await setupResult('md', 'report.md');

    const response = await app.inject({
      method: 'GET',
      url: `${ROUTE_PATH}/issue-1/result`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/markdown');
    expect(response.headers['content-disposition']).toBe('inline');
  });

  it('download: attachment; filename="report.md" из снапшота', async () => {
    const { app } = await setupResult('md', 'report.md');

    const response = await app.inject({
      method: 'GET',
      url: `${ROUTE_PATH}/issue-1/result/download`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/markdown');
    expect(response.headers['content-disposition']).toBe(
      'attachment; filename="report.md"',
    );
  });

  it('сервится результат ПОСЛЕДНЕЙ completed-итерации (по номеру)', async () => {
    const { app, db, root } = await setupResult('md', 'report.md');
    const second = seedCompletedIteration(db, 'issue-1', 2);
    await writeSnapshot(root, 'issue-1', second, 'report.md');

    const response = await app.inject({
      method: 'GET',
      url: `${ROUTE_PATH}/issue-1/result`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/markdown');
  });

  it('running-итерация не меняет сервимый результат — берётся последняя completed', async () => {
    const { app, db } = await setupResult('md', 'report.md');
    seedIterationWithStatus(db, 'issue-1', 2, 'running');

    const response = await app.inject({
      method: 'GET',
      url: `${ROUTE_PATH}/issue-1/result`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/markdown');
  });

  it('нет completed-итерации (только failed/running) → 404', async () => {
    const db = createDb(':memory:');
    const app = buildApp(db, { workspaceRoot: await makeTempDir() });
    openApps.push(app);
    seedIssue(db, 'issue-1', 'md');
    seedIterationWithStatus(db, 'issue-1', 1, 'failed');
    seedIterationWithStatus(db, 'issue-1', 2, 'running');

    const response = await app.inject({
      method: 'GET',
      url: `${ROUTE_PATH}/issue-1/result`,
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: 'result not found' });
  });

  it('404: completed-итерация есть, но файла снапшота нет', async () => {
    const db = createDb(':memory:');
    const app = buildApp(db, { workspaceRoot: await makeTempDir() });
    openApps.push(app);
    seedIssue(db, 'issue-1', 'md');
    seedCompletedIteration(db, 'issue-1', 1);

    const response = await app.inject({
      method: 'GET',
      url: `${ROUTE_PATH}/issue-1/result`,
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