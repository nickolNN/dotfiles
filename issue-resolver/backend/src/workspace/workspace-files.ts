/**
 * Обход рабочей папки задачи: список файлов, порождённых агентом за итерацию,
 * и безопасное разрешение пути к ним.
 *
 * Рабочая папка — cwd агента в контейнере; внутри неё лежат как результат
 * (`report.md`/`report.html`/`result.json`), так и произвольные файлы, которые
 * агент создал сам (сайты, скрипты, картинки). Служебные `.`-записи
 * (`.iteration-results`, `.issue-step-result.json`, `.git`, …) и загруженные
 * пользователем вложения (`attachments/`) в список не попадают.
 */
import { readdir, stat } from 'node:fs/promises';
import { join, posix, resolve, sep } from 'node:path';
import type { WorkspaceFile } from '@issue-resolver/shared';
import { workspaceHostDirFor } from './paths';

/** Подпапка загрузок пользователя; в список порождённых файлов не входит. */
const ATTACHMENTS_DIR = 'attachments';

const MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.mjs': 'text/javascript',
  '.json': 'application/json',
  '.md': 'text/markdown',
  '.txt': 'text/plain',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.pdf': 'application/pdf',
};

/** content-type по расширению имени (регистронезависимо); неизвестное → null. */
export function mimeForFilename(name: string): string | null {
  const dot = name.lastIndexOf('.');
  if (dot === -1) {
    return null;
  }
  return MIME_BY_EXTENSION[name.slice(dot).toLowerCase()] ?? null;
}

/**
 * Рекурсивный список файлов в рабочей папке задачи (basename + posix rel_path
 * от корня + size + mime). Пропускает `.`-записи, каталог `attachments` и
 * имена из `excludeNames` (артефакт результата). Каталоги с `.` не обходятся
 * вообще. Сортировка — по `rel_path` asc, детерминированная.
 */
export async function listWorkspaceFiles(
  hostRoot: string,
  issueId: string,
  excludeNames: ReadonlySet<string>,
): Promise<WorkspaceFile[]> {
  const baseDir = workspaceHostDirFor(hostRoot, issueId);
  const files: WorkspaceFile[] = [];

  async function walk(absDir: string, relDir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(absDir, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return;
      }
      throw error;
    }

    for (const entry of entries) {
      const name = entry.name;
      if (name.startsWith('.')) {
        continue;
      }
      if (entry.isDirectory()) {
        if (name === ATTACHMENTS_DIR || name === 'node_modules') {
          continue;
        }
        await walk(join(absDir, name), posix.join(relDir, name));
        continue;
      }
      if (!entry.isFile() || excludeNames.has(name)) {
        continue;
      }
      const info = await stat(join(absDir, name));
      files.push({
        name,
        rel_path: posix.join(relDir, name),
        size: info.size,
        mime_type: mimeForFilename(name),
      });
    }
  }

  await walk(baseDir, '');
  files.sort((a, b) => comparePaths(a.rel_path, b.rel_path));
  return files;
}

/** Сравнение posix-путей по возрастанию (без locale-зависимости). */
function comparePaths(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/**
 * Абсолютный путь файла в рабочей папке; null, если `relPath` выходит за её
 * пределы (path traversal), содержит обратный слэш, ведёт в `attachments/`
 * или любой сегмент начинается с `.`.
 */
export function workspaceFilePathFor(
  hostRoot: string,
  issueId: string,
  relPath: string,
): string | null {
  if (relPath.includes('\\')) {
    return null;
  }

  const baseDir = resolve(workspaceHostDirFor(hostRoot, issueId));
  const resolved = resolve(baseDir, relPath);
  if (!resolved.startsWith(baseDir + sep)) {
    return null;
  }

  const segments = relPath.split('/').filter((segment) => segment !== '');
  if (segments.length === 0 || segments.some((s) => s.startsWith('.'))) {
    return null;
  }
  if (segments[0] === ATTACHMENTS_DIR) {
    return null;
  }

  return resolved;
}