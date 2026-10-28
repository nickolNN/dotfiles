import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, posix, resolve, sep } from 'node:path';
import { workspaceHostDirFor } from './paths';

const ATTACHMENTS_DIR = 'attachments';

export interface UploadInput {
  filename: string;
  mimetype: string;
  buffer: Buffer;
}

export interface SavedUpload {
  name: string;
  relPath: string;
  size: number;
  mimeType: string;
}

function attachmentsRelDir(iterationNumber?: number): string {
  return iterationNumber !== undefined && iterationNumber > 1
    ? posix.join(ATTACHMENTS_DIR, `iteration-${iterationNumber}`)
    : ATTACHMENTS_DIR;
}

export function attachmentsDirFor(
  hostRoot: string,
  issueId: string,
  iterationNumber?: number,
): string {
  const rel = attachmentsRelDir(iterationNumber);
  return join(workspaceHostDirFor(hostRoot, issueId), ...rel.split('/'));
}

export function sanitizeFilename(raw: string): string {
  const base = raw.split(/[\\/]/).pop() ?? '';
  const cleaned = base
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/\.\./g, '')
    .trim();
  if (cleaned === '' || cleaned === '.' || cleaned === '..') {
    return 'file';
  }
  return cleaned;
}

function uniqueName(dir: string, name: string): string {
  if (!existsSync(join(dir, name))) {
    return name;
  }
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  for (let i = 1; ; i += 1) {
    const candidate = `${stem}-${i}${ext}`;
    if (!existsSync(join(dir, candidate))) {
      return candidate;
    }
  }
}

export async function saveUpload(
  hostRoot: string,
  issueId: string,
  iterationNumber: number | undefined,
  upload: UploadInput,
): Promise<SavedUpload> {
  const dir = attachmentsDirFor(hostRoot, issueId, iterationNumber);
  await mkdir(dir, { recursive: true });

  const name = uniqueName(dir, sanitizeFilename(upload.filename));
  await writeFile(join(dir, name), upload.buffer);

  return {
    name,
    relPath: posix.join(attachmentsRelDir(iterationNumber), name),
    size: upload.buffer.byteLength,
    mimeType: upload.mimetype,
  };
}

export function attachmentsFilePathFor(
  hostRoot: string,
  issueId: string,
  relPath: string,
): string | null {
  const baseDir = resolve(attachmentsDirFor(hostRoot, issueId));
  const abs = resolve(workspaceHostDirFor(hostRoot, issueId), relPath);
  if (!abs.startsWith(baseDir + sep)) {
    return null;
  }
  return abs;
}