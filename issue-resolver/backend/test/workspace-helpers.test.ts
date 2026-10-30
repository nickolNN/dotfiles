import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { installWorkspaceHelpers } from '../src/workflow/run-iteration.service';

const PROMPTS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'prompts',
);

describe('installWorkspaceHelpers — помощники в рабочую папку задачи', () => {
  const root = mkdtempSync(join(tmpdir(), 'ws-helpers-'));
  const source = join(
    dirname(fileURLToPath(import.meta.url)),
    '..',
    '..',
    'bin',
    'pw-browsers.sh',
  );

  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('копирует pw-browsers.sh исполняемым', () => {
    const dir = join(root, 'issue-1');
    mkdirSync(dir, { recursive: true });
    installWorkspaceHelpers(dir);
    const target = join(dir, 'pw-browsers.sh');

    expect(existsSync(target)).toBe(true);
    expect(statSync(target).mode & 0o111).not.toBe(0);
    expect(readFileSync(target, 'utf-8')).toBe(
      readFileSync(source, 'utf-8'),
    );
  });

  it('повторный вызов не портит файл', () => {
    const dir = join(root, 'issue-2');
    mkdirSync(dir, { recursive: true });
    installWorkspaceHelpers(dir);
    installWorkspaceHelpers(dir);

    expect(readFileSync(join(dir, 'pw-browsers.sh'), 'utf-8')).toContain(
      'playwright',
    );
  });

  it('несуществующую папку не создаёт', () => {
    const dir = join(root, 'missing');
    installWorkspaceHelpers(dir);

    expect(existsSync(dir)).toBe(false);
  });
});

describe('пути в промптах', () => {
  it('ни один промпт не ссылается на домашний путь хоста', () => {
    const names = readdirSync(PROMPTS_DIR).filter((name) => name.endsWith('.md'));

    expect(names.length).toBeGreaterThan(0);
    for (const name of names) {
      expect(
        readFileSync(join(PROMPTS_DIR, name), 'utf-8'),
        `${name}: путь агента существует только в контейнере задачи`,
      ).not.toMatch(/\/home\/agent\//);
    }
  });
});
