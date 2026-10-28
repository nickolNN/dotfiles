import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  listWorkspaceFiles,
  mimeForFilename,
  workspaceFilePathFor,
} from '../src/workspace/workspace-files';

const roots: string[] = [];

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'issue-resolver-workspace-files-'));
  roots.push(root);
  return root;
}

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

describe('mimeForFilename', () => {
  it('мапит известные расширения регистронезависимо', () => {
    expect(mimeForFilename('index.html')).toBe('text/html');
    expect(mimeForFilename('theme.CSS')).toBe('text/css');
    expect(mimeForFilename('APP.JS')).toBe('application/javascript');
    expect(mimeForFilename('module.mjs')).toBe('text/javascript');
    expect(mimeForFilename('data.json')).toBe('application/json');
    expect(mimeForFilename('notes.md')).toBe('text/markdown');
    expect(mimeForFilename('readme.txt')).toBe('text/plain');
    expect(mimeForFilename('pic.png')).toBe('image/png');
    expect(mimeForFilename('pic.jpeg')).toBe('image/jpeg');
    expect(mimeForFilename('anim.gif')).toBe('image/gif');
    expect(mimeForFilename('logo.svg')).toBe('image/svg+xml');
    expect(mimeForFilename('photo.webp')).toBe('image/webp');
    expect(mimeForFilename('doc.pdf')).toBe('application/pdf');
  });

  it('неизвестное расширение и имя без расширения → null', () => {
    expect(mimeForFilename('archive.zip')).toBeNull();
    expect(mimeForFilename('Makefile')).toBeNull();
    expect(mimeForFilename('report.')).toBeNull();
  });
});

describe('listWorkspaceFiles', () => {
  it('возвращает только порождённые файлы, пропуская служебные, attachments и артефакт', async () => {
    const root = await tempRoot();
    const issueId = 'issue-1';
    const dir = join(root, issueId);
    await mkdir(join(dir, '.iteration-results', 'iter-1'), { recursive: true });
    await mkdir(join(dir, 'attachments'), { recursive: true });
    await mkdir(join(dir, 'nested', 'deep'), { recursive: true });
    await writeFile(join(dir, 'index.html'), '<h1>cats</h1>');
    await writeFile(join(dir, 'styles.css'), 'body{}');
    await writeFile(join(dir, 'app.js'), 'console.log(1)');
    await writeFile(join(dir, 'report.html'), 'result');
    await writeFile(join(dir, '.issue-step-result.json'), '{}');
    await writeFile(join(dir, 'attachments', 'a.txt'), 'a');
    await writeFile(
      join(dir, '.iteration-results', 'iter-1', 'report.html'),
      'snapshot',
    );
    await writeFile(join(dir, 'nested', 'deep', 'leaf.txt'), 'leaf');

    const files = await listWorkspaceFiles(
      root,
      issueId,
      new Set(['report.html']),
    );

    expect(files.map((file) => file.rel_path)).toEqual([
      'app.js',
      'index.html',
      'nested/deep/leaf.txt',
      'styles.css',
    ]);

    const byPath = new Map(files.map((file) => [file.rel_path, file]));
    expect(byPath.get('index.html')).toEqual({
      name: 'index.html',
      rel_path: 'index.html',
      size: Buffer.byteLength('<h1>cats</h1>'),
      mime_type: 'text/html',
    });
    expect(byPath.get('app.js')?.mime_type).toBe('application/javascript');
    expect(byPath.get('styles.css')?.mime_type).toBe('text/css');
    expect(byPath.get('nested/deep/leaf.txt')).toMatchObject({
      name: 'leaf.txt',
      size: Buffer.byteLength('leaf'),
      mime_type: 'text/plain',
    });
    expect(byPath.has('report.html')).toBe(false);
    expect(byPath.has('.issue-step-result.json')).toBe(false);
    expect(byPath.has('attachments/a.txt')).toBe(false);
  });

  it('пропускает рабочие копии клонированных репозиториев (каталог с .git)', async () => {
    const root = await tempRoot();
    const issueId = 'issue-2';
    const dir = join(root, issueId);
    await mkdir(join(dir, 'aqua-com', '.git', 'objects'), { recursive: true });
    await mkdir(join(dir, 'aqua-com', 'node_modules', 'left-pad'), {
      recursive: true,
    });
    await writeFile(join(dir, 'aqua-com', 'src.ts'), 'export {};');
    await writeFile(
      join(dir, 'aqua-com', 'node_modules', 'left-pad', 'index.js'),
      '',
    );
    await writeFile(join(dir, 'plan.md'), '# plan');
    await writeFile(join(dir, 'report.md'), '# report');

    const files = await listWorkspaceFiles(root, issueId, new Set());

    expect(files.map((file) => file.rel_path)).toEqual(['plan.md', 'report.md']);
  });

  it('отсутствующая рабочая папка → пустой список', async () => {
    const root = await tempRoot();
    expect(await listWorkspaceFiles(root, 'nope', new Set())).toEqual([]);
  });
});

describe('workspaceFilePathFor', () => {
  it('разрешает путь внутри рабочей папки', () => {
    expect(workspaceFilePathFor('/root', 'i', 'index.html')).toBe(
      '/root/i/index.html',
    );
    expect(workspaceFilePathFor('/root', 'i', 'nested/leaf.txt')).toBe(
      '/root/i/nested/leaf.txt',
    );
  });

  it('отбивает traversal, абсолютные и служебные пути', () => {
    expect(workspaceFilePathFor('/root', 'i', '../evil.txt')).toBeNull();
    expect(
      workspaceFilePathFor('/root', 'i', 'nested/../../evil.txt'),
    ).toBeNull();
    expect(workspaceFilePathFor('/root', 'i', '/etc/passwd')).toBeNull();
    expect(workspaceFilePathFor('/root', 'i', 'attachments/a.txt')).toBeNull();
    expect(
      workspaceFilePathFor('/root', 'i', '.issue-step-result.json'),
    ).toBeNull();
    expect(workspaceFilePathFor('/root', 'i', 'nested/.hidden')).toBeNull();
    expect(workspaceFilePathFor('/root', 'i', '..\\evil.txt')).toBeNull();
    expect(workspaceFilePathFor('/root', 'i', '')).toBeNull();
  });
});