import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { createDb } from '../src/db/client';
import type { Db } from '../src/db/client';
import { issues } from '../src/db/schema';

const ROUTE_PATH = '/issue-resolver/api/v1/issues';

const openApps: Array<{ close: () => Promise<void> }> = [];
const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'issue-resolver-file-content-'));
  tempDirs.push(dir);
  return dir;
}

function seedIssue(db: Db, issueId: string): void {
  const now = new Date().toISOString();
  db.insert(issues)
    .values({
      id: issueId,
      title: 'Задача с файлами',
      desired_result: 'html',
      jira_issue_url: null,
      pipeline_steps: ['resolve'],
      container_name: null,
      status: 'completed',
      created_at: now,
      updated_at: now,
    })
    .run();
}

afterEach(async () => {
  await Promise.all(openApps.splice(0).map((app) => app.close()));
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe('GET /issues/:id/result/files/content', () => {
  async function setup() {
    const root = await makeTempDir();
    const db = createDb(':memory:');
    const app = buildApp(db, { workspaceRoot: root });
    openApps.push(app);
    seedIssue(db, 'issue-1');
    await mkdir(join(root, 'issue-1'), { recursive: true });
    await writeFile(join(root, 'issue-1', 'index.html'), '<h1>cats</h1>');
    return app;
  }

  it('без inline → attachment', async () => {
    const app = await setup();

    const response = await app.inject({
      method: 'GET',
      url: `${ROUTE_PATH}/issue-1/result/files/content?path=index.html`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/html');
    expect(response.headers['content-disposition']).toContain('attachment');
  });

  it('inline=1 → Content-Disposition: inline (для предпросмотра)', async () => {
    const app = await setup();

    const response = await app.inject({
      method: 'GET',
      url: `${ROUTE_PATH}/issue-1/result/files/content?path=index.html&inline=1`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-disposition']).toBe('inline');
  });

  it('inline не равен "1" → остаётся attachment', async () => {
    const app = await setup();

    const response = await app.inject({
      method: 'GET',
      url: `${ROUTE_PATH}/issue-1/result/files/content?path=index.html&inline=0`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-disposition']).toContain('attachment');
  });

  it('404 file not found: traversal-путь', async () => {
    const app = await setup();

    const response = await app.inject({
      method: 'GET',
      url: `${ROUTE_PATH}/issue-1/result/files/content?path=../evil.txt`,
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: 'file not found' });
  });
});