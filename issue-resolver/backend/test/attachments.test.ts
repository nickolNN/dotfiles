import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  attachmentsDirFor,
  attachmentsFilePathFor,
  sanitizeFilename,
  saveUpload,
} from '../src/workspace/attachments';

const roots: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'issue-resolver-attachments-'));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('sanitizeFilename', () => {
  it('срезает путь по обоим разделителям', () => {
    expect(sanitizeFilename('/etc/passwd')).toBe('passwd');
    expect(sanitizeFilename('../../etc/passwd')).toBe('passwd');
    expect(sanitizeFilename('..\\..\\evil.txt')).toBe('evil.txt');
    expect(sanitizeFilename('a/../b.txt')).toBe('b.txt');
  });

  it('убирает управляющие символы и ..', () => {
    expect(sanitizeFilename('a\u0000b\u001f.txt')).toBe('ab.txt');
    expect(sanitizeFilename('foo..bar.txt')).toBe('foobar.txt');
  });

  it('пустое/точечное имя → file', () => {
    expect(sanitizeFilename('..')).toBe('file');
    expect(sanitizeFilename('')).toBe('file');
    expect(sanitizeFilename('   ')).toBe('file');
  });

  it('обычное имя сохраняется', () => {
    expect(sanitizeFilename('report.pdf')).toBe('report.pdf');
  });
});

describe('saveUpload', () => {
  it('пишет файл, возвращает метаданные и дедуплицирует коллизии', async () => {
    const root = tempRoot();
    const issueId = 'issue-1';

    const first = await saveUpload(root, issueId, 1, {
      filename: 'report.txt',
      mimetype: 'text/plain',
      buffer: Buffer.from('one'),
    });
    expect(first).toEqual({
      name: 'report.txt',
      relPath: 'attachments/report.txt',
      size: 3,
      mimeType: 'text/plain',
    });
    expect(
      readFileSync(join(root, issueId, 'attachments', 'report.txt'), 'utf8'),
    ).toBe('one');

    const second = await saveUpload(root, issueId, 1, {
      filename: 'report.txt',
      mimetype: 'text/plain',
      buffer: Buffer.from('two'),
    });
    expect(second.name).toBe('report-1.txt');
    expect(second.relPath).toBe('attachments/report-1.txt');
    expect(
      readFileSync(join(root, issueId, 'attachments', 'report-1.txt'), 'utf8'),
    ).toBe('two');
  });

  it('дедуплицирует имя без расширения', async () => {
    const root = tempRoot();
    const upload = { filename: 'file', mimetype: '', buffer: Buffer.from('x') };
    const first = await saveUpload(root, 'i', 1, upload);
    const second = await saveUpload(root, 'i', 1, upload);
    expect(first.name).toBe('file');
    expect(second.name).toBe('file-1');
  });

  it('итерация > 1 кладёт файл в attachments/iteration-<n>', async () => {
    const root = tempRoot();
    const saved = await saveUpload(root, 'i', 2, {
      filename: 'img.png',
      mimetype: 'image/png',
      buffer: Buffer.from('png'),
    });
    expect(saved.relPath).toBe('attachments/iteration-2/img.png');
    expect(existsSync(join(root, 'i', 'attachments', 'iteration-2', 'img.png'))).toBe(
      true,
    );
  });

  it('attachmentsDirFor: итерация 1 и undefined — без подпапки', () => {
    expect(attachmentsDirFor('/root', 'i', 1)).toBe('/root/i/attachments');
    expect(attachmentsDirFor('/root', 'i')).toBe('/root/i/attachments');
    expect(attachmentsDirFor('/root', 'i', 3)).toBe(
      '/root/i/attachments/iteration-3',
    );
  });
});

describe('attachmentsFilePathFor', () => {
  it('пропускает путь внутри attachments задачи', () => {
    expect(attachmentsFilePathFor('/root', 'i', 'attachments/x.txt')).toBe(
      '/root/i/attachments/x.txt',
    );
    expect(
      attachmentsFilePathFor('/root', 'i', 'attachments/iteration-2/x.txt'),
    ).toBe('/root/i/attachments/iteration-2/x.txt');
  });

  it('отбивает traversal за пределы attachments', () => {
    expect(attachmentsFilePathFor('/root', 'i', '../evil.txt')).toBeNull();
    expect(
      attachmentsFilePathFor('/root', 'i', 'attachments/../../evil.txt'),
    ).toBeNull();
    expect(attachmentsFilePathFor('/root', 'i', 'attachments')).toBeNull();
  });
});