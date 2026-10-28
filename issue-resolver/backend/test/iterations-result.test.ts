import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { createDb } from '../src/db/client';
import type { Db } from '../src/db/client';
import { issues, iterations } from '../src/db/schema';

const ROUTE_PATH = '/issue-resolver/api/v1/iterations';

const openApps: Array<{ close: () => Promise<void> }> = [];
const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'issue-resolver-iter-result-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(openApps.splice(0).map((app) => app.close()));
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

function seedIssue(db: Db, issueId: string): void {
  const now = new Date().toISOString();
  db.insert(issues)
    .values({
      id: issueId,
      title: 'Задача с итерацией',
      desired_result: 'md',
      jira_issue_url: null,
      pipeline_steps: ['resolve'],
      container_name: null,
      status: 'completed',
      created_at: now,
      updated_at: now,
    })
    .run();
}

function seedCompletedIteration(
  db: Db,
  issueId: string,
  iterationId: string,
  number = 1,
): void {
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
      status: 'completed',
      created_at: now,
      updated_at: now,
    })
    .run();
}

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

describe('GET /iterations/:id/result', () => {
  it('200: снапшот md → text/markdown inline', async () => {
    const root = await makeTempDir();
    const db = createDb(':memory:');
    const app = buildApp(db, { workspaceRoot: root });
    openApps.push(app);
    seedIssue(db, 'iter-issue-md');
    seedCompletedIteration(db, 'iter-issue-md', 'iter-md-1');
    await writeSnapshot(
      root,
      'iter-issue-md',
      'iter-md-1',
      'report.md',
      '# Отчёт итерации',
    );

    const response = await app.inject({
      method: 'GET',
      url: `${ROUTE_PATH}/iter-md-1/result`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/markdown');
    expect(response.headers['content-disposition']).toBe('inline');
    expect(response.body).toBe('# Отчёт итерации');
  });

  it('download: attachment; filename="report.md"', async () => {
    const root = await makeTempDir();
    const db = createDb(':memory:');
    const app = buildApp(db, { workspaceRoot: root });
    openApps.push(app);
    seedIssue(db, 'iter-issue-dl');
    seedCompletedIteration(db, 'iter-issue-dl', 'iter-dl-1');
    await writeSnapshot(
      root,
      'iter-issue-dl',
      'iter-dl-1',
      'report.md',
      '# Скачать',
    );

    const response = await app.inject({
      method: 'GET',
      url: `${ROUTE_PATH}/iter-dl-1/result/download`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/markdown');
    expect(response.headers['content-disposition']).toBe(
      'attachment; filename="report.md"',
    );
    expect(response.body).toBe('# Скачать');
  });

  it('404: итерация не найдена', async () => {
    const root = await makeTempDir();
    const db = createDb(':memory:');
    const app = buildApp(db, { workspaceRoot: root });
    openApps.push(app);

    const response = await app.inject({
      method: 'GET',
      url: `${ROUTE_PATH}/missing-iteration/result`,
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: 'iteration not found' });
  });

  it('404: файла снапшота нет', async () => {
    const root = await makeTempDir();
    const db = createDb(':memory:');
    const app = buildApp(db, { workspaceRoot: root });
    openApps.push(app);
    seedIssue(db, 'iter-issue-nofile');
    seedCompletedIteration(db, 'iter-issue-nofile', 'iter-nofile-1');

    const response = await app.inject({
      method: 'GET',
      url: `${ROUTE_PATH}/iter-nofile-1/result`,
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: 'result not found' });
  });
});