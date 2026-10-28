import { gunzipSync } from 'node:zlib';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { createDb } from '../src/db/client';
import type { Db } from '../src/db/client';
import { issues, iterations } from '../src/db/schema';
import { createTarGz, type ArchiveEntry } from '../src/workspace/archive';

const ROUTE_PATH = '/issue-resolver/api/v1/issues';

function parseTar(buf: Buffer): Array<{ name: string; body: Buffer }> {
  const out: Array<{ name: string; body: Buffer }> = [];
  let offset = 0;
  while (offset + 512 <= buf.length) {
    const block = buf.subarray(offset, offset + 512);
    if (block.every((byte) => byte === 0)) {
      break;
    }
    const rawName = block
      .subarray(0, 100)
      .toString('utf8')
      .replace(/\0.*$/, '');
    const prefix = block
      .subarray(345, 500)
      .toString('utf8')
      .replace(/\0.*$/, '');
    const size = parseInt(
      block
        .subarray(124, 136)
        .toString('ascii')
        .replace(/\0.*$/, '')
        .trim() || '0',
      8,
    );
    const bodyStart = offset + 512;
    const body = buf.subarray(bodyStart, bodyStart + size);
    out.push({ name: prefix ? `${prefix}/${rawName}` : rawName, body });
    offset = bodyStart + Math.ceil(size / 512) * 512;
  }
  return out;
}

const openApps: Array<{ close: () => Promise<void> }> = [];
const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'issue-resolver-archive-'));
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

function seedCompletedIteration(
  db: Db,
  issueId: string,
  iterationId: string,
): void {
  const now = new Date().toISOString();
  db.insert(iterations)
    .values({
      id: iterationId,
      issue_id: issueId,
      number: 1,
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

afterEach(async () => {
  await Promise.all(openApps.splice(0).map((app) => app.close()));
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe('createTarGz', () => {
  it('создаёт gzip, который распаковывается обратно в те же имена и тела', async () => {
    const entries: ArchiveEntry[] = [
      { name: 'b.txt', relPath: 'b.txt', body: Buffer.from('bravo') },
      {
        name: 'a.txt',
        relPath: 'nested/a.txt',
        body: Buffer.from('alpha'),
      },
    ];

    const gz = await createTarGz(entries);
    const parsed = parseTar(gunzipSync(gz));

    expect(parsed.map((entry) => entry.name)).toEqual([
      'b.txt',
      'nested/a.txt',
    ]);
    expect(parsed[0].body.toString('utf8')).toBe('bravo');
    expect(parsed[1].body.toString('utf8')).toBe('alpha');
  });

  it('пустой список → валидный gzip с пустым tar', async () => {
    const parsed = parseTar(gunzipSync(await createTarGz([])));
    expect(parsed).toEqual([]);
  });
});

describe('GET /issues/:id/result/files/archive', () => {
  it('200 + gzip: порождённые файлы и артефакт результата в архиве', async () => {
    const root = await makeTempDir();
    const db = createDb(':memory:');
    const app = buildApp(db, { workspaceRoot: root });
    openApps.push(app);
    seedIssue(db, 'issue-1');
    seedCompletedIteration(db, 'issue-1', 'iter-1');

    const dir = join(root, 'issue-1');
    await mkdir(join(dir, 'nested'), { recursive: true });
    await writeFile(join(dir, 'index.html'), '<h1>cats</h1>');
    await writeFile(join(dir, 'nested', 'leaf.txt'), 'leaf');
    const snap = join(dir, '.iteration-results', 'iter-1');
    await mkdir(snap, { recursive: true });
    await writeFile(join(snap, 'report.html'), 'result');

    const response = await app.inject({
      method: 'GET',
      url: `${ROUTE_PATH}/issue-1/result/files/archive`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('application/gzip');
    expect(response.headers['content-disposition']).toBe(
      'attachment; filename="issue-issue-1.tar.gz"',
    );

    const parsed = parseTar(gunzipSync(response.rawPayload));
    const byName = new Map(
      parsed.map((entry) => [entry.name, entry.body.toString('utf8')]),
    );
    expect(byName.get('index.html')).toBe('<h1>cats</h1>');
    expect(byName.get('nested/leaf.txt')).toBe('leaf');
    expect(byName.get('report.html')).toBe('result');
  });

  it('404 result not found: нет completed-итерации', async () => {
    const root = await makeTempDir();
    const db = createDb(':memory:');
    const app = buildApp(db, { workspaceRoot: root });
    openApps.push(app);
    seedIssue(db, 'issue-empty');

    const response = await app.inject({
      method: 'GET',
      url: `${ROUTE_PATH}/issue-empty/result/files/archive`,
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: 'result not found' });
  });

  it('404 result not found: итерация есть, но файлов нет', async () => {
    const root = await makeTempDir();
    const db = createDb(':memory:');
    const app = buildApp(db, { workspaceRoot: root });
    openApps.push(app);
    seedIssue(db, 'issue-nofiles');
    seedCompletedIteration(db, 'issue-nofiles', 'iter-nofiles');

    const response = await app.inject({
      method: 'GET',
      url: `${ROUTE_PATH}/issue-nofiles/result/files/archive`,
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: 'result not found' });
  });

  it('404 issue not found: неизвестная задача', async () => {
    const root = await makeTempDir();
    const db = createDb(':memory:');
    const app = buildApp(db, { workspaceRoot: root });
    openApps.push(app);

    const response = await app.inject({
      method: 'GET',
      url: `${ROUTE_PATH}/missing/result/files/archive`,
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: 'issue not found' });
  });
});