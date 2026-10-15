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

/** Прямой insert итерации с заданным статусом (без HTTP). */
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

/** Завершённая итерация — именно её снапшот сервится эндпоинтами результата. */
function seedCompletedIteration(
  db: Db,
  issueId: string,
  number: number,
): string {
  return seedIterationWithStatus(db, issueId, number, 'completed');
}

/**
 * Снапшот результата итерации по контракту:
 * `<root>/<issueId>/.iteration-results/<iterationId>/<filename>`.
 * Путь собирается буквально, без импорта сервисных helper'ов.
 */
async function writeSnapshot(
  root: string,
  issueId: string,
  iterationId: string,
  filename: string,
  content: string,
): Promise<void> {
  const dir = join(root, issueId, '.iteration-results', iterationId);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, filename), content);
}

describe('POST /issues — desired_result', () => {
  it('не указан → сохраняется как md, pr остаётся если create_mr:true', async () => {
    const app = makeApp();

    const created = await post(app, {
      title: 'По умолчанию md',
      repositories: [{ ...REPOSITORY, create_mr: true }],
    });

    expect(created.statusCode).toBe(201);
    const body = created.json();
    expect(body.desired_result).toBe('md');
    // create_mr:true → pr в шагах (desired_result на pr не влияет)
    expect(body.pipeline_steps).toContain('pr');

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
    expect(created.json().pipeline_steps).toContain('pr');
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
    const root = await makeTempDir();
    const db = createDb(':memory:');
    const app = buildApp(db, { workspaceRoot: root });
    openApps.push(app);
    seedIssue(db, 'issue-html', 'html');
    const iterationId = seedCompletedIteration(db, 'issue-html', 1);
    await writeSnapshot(
      root,
      'issue-html',
      iterationId,
      'report.html',
      '<h1>Отчёт</h1>',
    );

    const response = await app.inject({
      method: 'GET',
      url: `${ROUTE_PATH}/issue-html/result`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/html');
    expect(response.headers['content-disposition']).toBe('inline');
    expect(response.body).toBe('<h1>Отчёт</h1>');
  });

  it('200: md-снапшот последней итерации → report.md как text/markdown, inline', async () => {
    const root = await makeTempDir();
    const db = createDb(':memory:');
    const app = buildApp(db, { workspaceRoot: root });
    openApps.push(app);
    seedIssue(db, 'issue-md', 'md');
    const iterationId = seedCompletedIteration(db, 'issue-md', 1);
    await writeSnapshot(root, 'issue-md', iterationId, 'report.md', '# Отчёт');

    const response = await app.inject({
      method: 'GET',
      url: `${ROUTE_PATH}/issue-md/result`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/markdown');
    expect(response.headers['content-disposition']).toBe('inline');
    expect(response.body).toBe('# Отчёт');
  });

  it('download: attachment; filename="report.md" из снапшота', async () => {
    const root = await makeTempDir();
    const db = createDb(':memory:');
    const app = buildApp(db, { workspaceRoot: root });
    openApps.push(app);
    seedIssue(db, 'issue-md-dl', 'md');
    const iterationId = seedCompletedIteration(db, 'issue-md-dl', 1);
    await writeSnapshot(root, 'issue-md-dl', iterationId, 'report.md', '# Скачать');

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

  it('сервится результат ПОСЛЕДНЕЙ completed-итерации (по номеру)', async () => {
    const root = await makeTempDir();
    const db = createDb(':memory:');
    const app = buildApp(db, { workspaceRoot: root });
    openApps.push(app);
    seedIssue(db, 'issue-last', 'md');
    const first = seedCompletedIteration(db, 'issue-last', 1);
    await writeSnapshot(root, 'issue-last', first, 'report.md', '# Итерация 1');
    const second = seedCompletedIteration(db, 'issue-last', 2);
    await writeSnapshot(root, 'issue-last', second, 'report.md', '# Итерация 2');

    const response = await app.inject({
      method: 'GET',
      url: `${ROUTE_PATH}/issue-last/result`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toBe('# Итерация 2');
  });

  it('running-итерация не меняет сервимый результат — берётся последняя completed', async () => {
    const root = await makeTempDir();
    const db = createDb(':memory:');
    const app = buildApp(db, { workspaceRoot: root });
    openApps.push(app);
    seedIssue(db, 'issue-running', 'md');
    const completed = seedCompletedIteration(db, 'issue-running', 1);
    await writeSnapshot(
      root,
      'issue-running',
      completed,
      'report.md',
      '# Итерация 1',
    );
    // running-итерация #2 без снапшота не должна перекрывать результат #1.
    seedIterationWithStatus(db, 'issue-running', 2, 'running');

    const response = await app.inject({
      method: 'GET',
      url: `${ROUTE_PATH}/issue-running/result`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toBe('# Итерация 1');
  });

  it('нет completed-итерации (только failed/running) и есть файл в корне задачи → 404', async () => {
    const root = await makeTempDir();
    const db = createDb(':memory:');
    const app = buildApp(db, { workspaceRoot: root });
    openApps.push(app);
    seedIssue(db, 'issue-none-completed', 'md');
    seedIterationWithStatus(db, 'issue-none-completed', 1, 'failed');
    seedIterationWithStatus(db, 'issue-none-completed', 2, 'running');
    // Старый файл в корне задачи больше не сервится.
    await writeArtifact(
      root,
      'issue-none-completed',
      'report.md',
      '# Старый корень',
    );

    const response = await app.inject({
      method: 'GET',
      url: `${ROUTE_PATH}/issue-none-completed/result`,
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: 'result not found' });
  });

  it('404: completed-итерация есть, но файла снапшота нет', async () => {
    const root = await makeTempDir();
    const db = createDb(':memory:');
    const app = buildApp(db, { workspaceRoot: root });
    openApps.push(app);
    seedIssue(db, 'issue-no-snapshot', 'md');
    seedCompletedIteration(db, 'issue-no-snapshot', 1);

    const response = await app.inject({
      method: 'GET',
      url: `${ROUTE_PATH}/issue-no-snapshot/result`,
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