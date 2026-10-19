import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import type {
  DesiredResult,
  SSEEvent,
  TaskStatus,
} from '@issue-resolver/shared';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { createDb } from '../src/db/client';
import type { Db } from '../src/db/client';
import { issueRepositories, issues, iterations } from '../src/db/schema';
import { FakeContainerController } from '../src/docker/controller';
import { createIssueService, type IssueService } from '../src/issues/service';
import { InMemorySseHub } from '../src/sse/hub';
import {
  DEFAULT_WORKSPACE_ROOT,
  iterationResultDirFor,
} from '../src/workspace/paths';

const service: IssueService = createIssueService();

const tempRoots: string[] = [];

afterAll(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'issue-service-'));
  tempRoots.push(root);
  return root;
}

function newDb(): Db {
  return createDb(':memory:');
}

interface MakeConfigResult {
  config: ReturnType<IssueService['resolveConfig']>;
  container: FakeContainerController;
  sse: InMemorySseHub;
}

function makeConfig(workspaceRoot: string): MakeConfigResult {
  const container = new FakeContainerController();
  const sse = new InMemorySseHub();
  const config = service.resolveConfig({ workspaceRoot, container, sse });
  return { config, container, sse };
}

interface SeedIssueOptions {
  id?: string;
  title?: string;
  description?: string;
  desired_result?: DesiredResult;
  jira_issue_url?: string | null;
  source?: string | null;
  dev_server_port?: number | null;
  status?: TaskStatus;
  created_at?: string;
}

function seedIssue(db: Db, opts: SeedIssueOptions = {}): string {
  const id = opts.id ?? randomUUID();
  const created = opts.created_at ?? new Date().toISOString();
  db.insert(issues)
    .values({
      id,
      title: opts.title ?? 'Test issue',
      description: opts.description ?? '',
      desired_result: opts.desired_result ?? 'md',
      jira_issue_url: opts.jira_issue_url ?? null,
      source: opts.source ?? null,
      dev_server_port: opts.dev_server_port ?? null,
      pipeline_steps: ['resolve'],
      status: opts.status ?? 'pending',
      created_at: created,
      updated_at: created,
    })
    .run();
  return id;
}

interface SeedIterationOptions {
  id?: string;
  number?: number;
  status?: TaskStatus;
}

function seedIteration(
  db: Db,
  issueId: string,
  opts: SeedIterationOptions = {},
): string {
  const id = opts.id ?? randomUUID();
  const now = new Date().toISOString();
  db.insert(iterations)
    .values({
      id,
      issue_id: issueId,
      number: opts.number ?? 1,
      context: '',
      review_context: '',
      is_review_need: false,
      steps: ['resolve'],
      status: opts.status ?? 'completed',
      created_at: now,
      updated_at: now,
    })
    .run();
  return id;
}

/** Разбирает несжатый ustar-тар в список имён записей. */
function parseTarNames(buf: Buffer): string[] {
  const names: string[] = [];
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
      block.subarray(124, 136).toString('ascii').replace(/\0.*$/, '').trim() ||
        '0',
      8,
    );
    names.push(prefix ? `${prefix}/${rawName}` : rawName);
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return names;
}

describe('resolveConfig', () => {
  it('берёт workspaceRoot из deps', () => {
    const container = new FakeContainerController();
    const sse = new InMemorySseHub();

    const config = service.resolveConfig({
      workspaceRoot: '/custom/root',
      container,
      sse,
    });

    expect(config).toEqual({
      workspaceRoot: '/custom/root',
      container,
      sse,
    });
  });

  it('подставляет DEFAULT_WORKSPACE_ROOT, если workspaceRoot не задан', () => {
    const config = service.resolveConfig({
      container: new FakeContainerController(),
      sse: new InMemorySseHub(),
    });

    expect(config.workspaceRoot).toBe(DEFAULT_WORKSPACE_ROOT);
  });
});

describe('listIssues', () => {
  it('пустая БД → []', () => {
    const db = newDb();
    const { config } = makeConfig(makeRoot());

    expect(service.listIssues(db, config)).toEqual([]);
  });

  it('одна задача → [Issue] со всеми полями', () => {
    const db = newDb();
    const { config } = makeConfig(makeRoot());
    const id = seedIssue(db, {
      title: 'Hello',
      description: 'world',
      desired_result: 'html',
      status: 'pending',
    });

    const list = service.listIssues(db, config);

    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      id,
      title: 'Hello',
      description: 'world',
      desired_result: 'html',
      status: 'pending',
      repositories: [],
    });
    expect(list[0]!.workspace_missing).toBe(true);
  });

  it('сортирует по created_at DESC', () => {
    const db = newDb();
    const { config } = makeConfig(makeRoot());
    const older = seedIssue(db, {
      title: 'older',
      created_at: '2024-01-01T00:00:00.000Z',
    });
    const newer = seedIssue(db, {
      title: 'newer',
      created_at: '2024-06-01T00:00:00.000Z',
    });
    const middle = seedIssue(db, {
      title: 'middle',
      created_at: '2024-03-01T00:00:00.000Z',
    });

    expect(service.listIssues(db, config).map((issue) => issue.id)).toEqual([
      newer,
      middle,
      older,
    ]);
  });
});

describe('getIssue', () => {
  it('найденная задача → Issue со всеми полями', () => {
    const db = newDb();
    const root = makeRoot();
    const { config } = makeConfig(root);
    const id = seedIssue(db, {
      title: 'Full',
      description: 'desc',
      desired_result: 'html',
      jira_issue_url: 'https://jira.example/browse/ABC-1',
      source: 'jira',
      dev_server_port: 5101,
      status: 'pending',
    });
    const now = new Date().toISOString();
    db.insert(issueRepositories)
      .values({
        id: randomUUID(),
        issue_id: id,
        repository_url: 'https://github.com/acme/app.git',
        branch_name: 'main',
        create_mr: true,
        bootstrap_enabled: false,
        created_at: now,
        updated_at: now,
      })
      .run();
    const iterationId = seedIteration(db, id, { status: 'completed' });

    const found = service.getIssue(db, config, id);

    expect(found).toMatchObject({
      id,
      title: 'Full',
      description: 'desc',
      desired_result: 'html',
      jira_issue_url: 'https://jira.example/browse/ABC-1',
      source: 'jira',
      dev_server_port: 5101,
      pipeline_steps: ['resolve'],
      // Статус выводится из последней итерации.
      status: 'completed',
      workspace_missing: true,
    });
    expect(found!.repositories).toHaveLength(1);
    expect(found!.repositories[0]).toMatchObject({
      repository_url: 'https://github.com/acme/app.git',
      branch_name: 'main',
      create_mr: true,
      bootstrap_enabled: false,
    });
    expect(iterationId).toBeTruthy();
  });

  it('не найдена → null', () => {
    const db = newDb();
    const { config } = makeConfig(makeRoot());

    expect(service.getIssue(db, config, 'missing')).toBeNull();
  });
});

describe('getResultArtifact', () => {
  it('нет завершённой итерации → null', async () => {
    const db = newDb();
    const { config } = makeConfig(makeRoot());
    const id = seedIssue(db);
    seedIteration(db, id, { status: 'pending' });

    expect(await service.getResultArtifact(db, config, id)).toBeNull();
  });

  it('задача не найдена → null', async () => {
    const db = newDb();
    const { config } = makeConfig(makeRoot());

    expect(await service.getResultArtifact(db, config, 'missing')).toBeNull();
  });

  it('нет файла результата → null', async () => {
    const db = newDb();
    const { config } = makeConfig(makeRoot());
    const id = seedIssue(db, { desired_result: 'md' });
    seedIteration(db, id, { status: 'completed' });

    expect(await service.getResultArtifact(db, config, id)).toBeNull();
  });

  it('читает report.md завершённой итерации', async () => {
    const db = newDb();
    const root = makeRoot();
    const { config } = makeConfig(root);
    const id = seedIssue(db, { desired_result: 'md' });
    const iterationId = seedIteration(db, id, { status: 'completed' });
    const dir = iterationResultDirFor(root, id, iterationId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'report.md'), '# Result\n');

    expect(await service.getResultArtifact(db, config, id)).toEqual({
      body: '# Result\n',
      contentType: 'text/markdown',
      filename: 'report.md',
    });
  });

  it('читает report.html при desired_result=html', async () => {
    const db = newDb();
    const root = makeRoot();
    const { config } = makeConfig(root);
    const id = seedIssue(db, { desired_result: 'html' });
    const iterationId = seedIteration(db, id, { status: 'completed' });
    const dir = iterationResultDirFor(root, id, iterationId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'report.html'), '<h1>done</h1>');

    expect(await service.getResultArtifact(db, config, id)).toEqual({
      body: '<h1>done</h1>',
      contentType: 'text/html',
      filename: 'report.html',
    });
  });
});

describe('getResultFiles', () => {
  it('возвращает файлы, пропуская служебные каталоги и артефакт', async () => {
    const db = newDb();
    const root = makeRoot();
    const { config } = makeConfig(root);
    const id = seedIssue(db, { desired_result: 'md' });
    const iterationId = seedIteration(db, id, { status: 'completed' });
    const dir = join(root, id);
    mkdirSync(join(dir, '.iteration-results', iterationId), {
      recursive: true,
    });
    mkdirSync(join(dir, 'attachments'), { recursive: true });
    mkdirSync(join(dir, 'nested', 'deep'), { recursive: true });
    writeFileSync(join(dir, 'index.html'), '<h1>hi</h1>');
    writeFileSync(join(dir, 'styles.css'), 'body{}');
    writeFileSync(join(dir, 'report.md'), '# result');
    writeFileSync(join(dir, '.issue-step-result.json'), '{}');
    writeFileSync(join(dir, 'attachments', 'a.txt'), 'a');
    writeFileSync(join(dir, 'nested', 'deep', 'leaf.txt'), 'leaf');
    writeFileSync(
      join(dir, '.iteration-results', iterationId, 'report.md'),
      '# snapshot',
    );

    const files = await service.getResultFiles(db, config, id);

    expect(files).not.toBeNull();
    expect(files!.map((file) => file.rel_path)).toEqual([
      'index.html',
      'nested/deep/leaf.txt',
      'styles.css',
    ]);
    expect(files!.map((file) => file.mime_type)).toEqual([
      'text/html',
      'text/plain',
      'text/css',
    ]);
  });

  it('задача не найдена → null', async () => {
    const db = newDb();
    const { config } = makeConfig(makeRoot());

    expect(await service.getResultFiles(db, config, 'missing')).toBeNull();
  });

  it('нет завершённой итерации → null', async () => {
    const db = newDb();
    const { config } = makeConfig(makeRoot());
    const id = seedIssue(db);

    expect(await service.getResultFiles(db, config, id)).toBeNull();
  });
});

describe('getResultArchive', () => {
  it('возвращает gzip-буфер с файлами задачи и артефактом', async () => {
    const db = newDb();
    const root = makeRoot();
    const { config } = makeConfig(root);
    const id = seedIssue(db, { desired_result: 'md' });
    const iterationId = seedIteration(db, id, { status: 'completed' });
    const dir = join(root, id);
    const resultDir = iterationResultDirFor(root, id, iterationId);
    mkdirSync(resultDir, { recursive: true });
    writeFileSync(join(dir, 'index.html'), '<h1>hi</h1>');
    writeFileSync(join(dir, 'report.md'), '# workspace report');
    writeFileSync(join(resultDir, 'report.md'), '# snapshot report');

    const buf = await service.getResultArchive(db, config, id);

    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(buf.length).toBeGreaterThan(0);
    const names = parseTarNames(gunzipSync(buf));
    expect(names).toEqual(['index.html', 'report.md']);
  });

  it('задача не найдена → бросает issue not found', async () => {
    const db = newDb();
    const { config } = makeConfig(makeRoot());

    await expect(
      service.getResultArchive(db, config, 'missing'),
    ).rejects.toThrow('issue not found');
  });

  it('нет завершённой итерации → бросает result not found', async () => {
    const db = newDb();
    const { config } = makeConfig(makeRoot());
    const id = seedIssue(db);
    seedIteration(db, id, { status: 'pending' });

    await expect(service.getResultArchive(db, config, id)).rejects.toThrow(
      'result not found',
    );
  });

  it('нет файлов → бросает result not found', async () => {
    const db = newDb();
    const { config } = makeConfig(makeRoot());
    const id = seedIssue(db);
    seedIteration(db, id, { status: 'completed' });

    await expect(service.getResultArchive(db, config, id)).rejects.toThrow(
      'result not found',
    );
  });
});

describe('deleteIssue', () => {
  it('удаляет запись, контейнер и папку, публикуя SSE-фазы по порядку', async () => {
    const db = newDb();
    const root = makeRoot();
    const { config, container, sse } = makeConfig(root);
    const id = seedIssue(db);
    const issueDir = join(root, id);
    mkdirSync(issueDir, { recursive: true });
    writeFileSync(join(issueDir, 'work.txt'), 'artifact');

    const events: SSEEvent[] = [];
    sse.subscribeByIssue(id, (event) => events.push(event));
    const removeSpy = vi.spyOn(container, 'remove');

    await service.deleteIssue(db, config, id);

    // Запись стёрта, контейнер и рабочая папка снесены.
    expect(db.select().from(issues).all()).toHaveLength(0);
    expect(removeSpy).toHaveBeenCalledWith(`issue-resolver-${id}`);
    expect(existsSync(issueDir)).toBe(false);

    // Прогресс — фазы issue_deleting в порядке, финал — issue_deleted.
    const phases = events
      .filter((event) => event.type === 'issue_deleting')
      .map(
        (event) => (JSON.parse(event.data) as { phase: string }).phase,
      );
    expect(phases).toEqual([
      'stopping_processes',
      'removing_db_record',
      'removing_container',
      'removing_workspace',
    ]);

    const last = events[events.length - 1]!;
    expect(last.type).toBe('issue_deleted');
    expect(last.issueId).toBe(id);
    expect(JSON.parse(last.data)).toEqual({ issueId: id });
  });

  it('не трогает контейнер и папку, если удаление из БД упало', async () => {
    const db = newDb();
    const root = makeRoot();
    const { config, container, sse } = makeConfig(root);
    const id = seedIssue(db);
    const issueDir = join(root, id);
    mkdirSync(issueDir, { recursive: true });
    writeFileSync(join(issueDir, 'work.txt'), 'artifact');

    const events: SSEEvent[] = [];
    sse.subscribeByIssue(id, (event) => events.push(event));
    const removeSpy = vi.spyOn(container, 'remove');
    const deleteSpy = vi.spyOn(db, 'delete').mockImplementation(() => {
      throw new Error('db delete failed');
    });

    await service.deleteIssue(db, config, id);

    const phases = events
      .filter((event) => event.type === 'issue_deleting')
      .map(
        (event) => (JSON.parse(event.data) as { phase: string }).phase,
      );
    expect(phases).toEqual([
      'stopping_processes',
      'removing_db_record',
      'error',
    ]);
    const errorEvent = events.find(
      (event) =>
        event.type === 'issue_deleting' &&
        (JSON.parse(event.data) as { phase: string }).phase === 'error',
    );
    expect(JSON.parse(errorEvent!.data)).toMatchObject({
      phase: 'error',
      message: 'db delete failed',
    });
    expect(removeSpy).not.toHaveBeenCalled();
    expect(existsSync(issueDir)).toBe(true);
    expect(events.some((event) => event.type === 'issue_deleted')).toBe(false);

    deleteSpy.mockRestore();
  });
});