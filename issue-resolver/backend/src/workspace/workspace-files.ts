import { existsSync } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { join, posix, resolve, sep } from 'node:path';
import type { WorkspaceFile } from '@issue-resolver/shared';
import { workspaceHostDirFor } from './paths';

const ATTACHMENTS_DIR = 'attachments';

function isRepoWorkingCopy(dir: string): boolean {
  return existsSync(join(dir, '.git'));
}

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

export function mimeForFilename(name: string): string | null {
  const dot = name.lastIndexOf('.');
  if (dot === -1) {
    return null;
  }
  return MIME_BY_EXTENSION[name.slice(dot).toLowerCase()] ?? null;
}

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
        if (isRepoWorkingCopy(join(absDir, name))) {
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

function comparePaths(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

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