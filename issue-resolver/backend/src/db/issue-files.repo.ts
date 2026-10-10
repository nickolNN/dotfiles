import { randomUUID } from 'node:crypto';
import type { IssueFile } from '@issue-resolver/shared';
import { and, asc, eq, isNull, or } from 'drizzle-orm';
import type { Db } from './client';
import { issueFiles } from './schema';

export interface NewIssueFile {
  issueId: string;
  /** null/undefined — общезадачный файл без привязки к итерации. */
  iterationId?: string | null;
  name: string;
  /** Путь относительно корня рабочей папки задачи (= cwd агента). */
  relPath: string;
  size: number;
  mimeType?: string | null;
}

/** Вставка пачки файлов одной задачей; возвращает вставленные строки. */
export async function insertMany(
  db: Db,
  files: NewIssueFile[],
): Promise<IssueFile[]> {
  if (files.length === 0) {
    return [];
  }
  const now = new Date().toISOString();
  const rows: IssueFile[] = files.map((file) => ({
    id: randomUUID(),
    issue_id: file.issueId,
    iteration_id: file.iterationId ?? null,
    name: file.name,
    rel_path: file.relPath,
    size: file.size,
    mime_type: file.mimeType ?? null,
    created_at: now,
  }));

  db.insert(issueFiles).values(rows).run();
  return rows;
}

/** Все файлы задачи (в порядке загрузки; внутри одной секунды — по имени). */
export async function listByIssue(
  db: Db,
  issueId: string,
): Promise<IssueFile[]> {
  return db
    .select()
    .from(issueFiles)
    .where(eq(issueFiles.issue_id, issueId))
    .orderBy(asc(issueFiles.created_at), asc(issueFiles.name))
    .all();
}

/** Файлы, привязанные к конкретной итерации. */
export async function listByIteration(
  db: Db,
  iterationId: string,
): Promise<IssueFile[]> {
  return db
    .select()
    .from(issueFiles)
    .where(eq(issueFiles.iteration_id, iterationId))
    .orderBy(asc(issueFiles.created_at), asc(issueFiles.name))
    .all();
}

/**
 * rel_path файлов, доступных прогону итерации: привязанные к этой итерации
 * плюс общезадачные (`iteration_id IS NULL`). Порядок детерминирован (по
 * created_at/имени) — промпт строится побайтово одинаково.
 */
export async function listAttachableRelPaths(
  db: Db,
  issueId: string,
  iterationId: string,
): Promise<string[]> {
  return db
    .select({ rel_path: issueFiles.rel_path })
    .from(issueFiles)
    .where(
      and(
        eq(issueFiles.issue_id, issueId),
        or(
          isNull(issueFiles.iteration_id),
          eq(issueFiles.iteration_id, iterationId),
        ),
      ),
    )
    .orderBy(asc(issueFiles.created_at), asc(issueFiles.name))
    .all()
    .map((row) => row.rel_path);
}

/** Строка файла по id или undefined. */
export async function getById(
  db: Db,
  fileId: string,
): Promise<IssueFile | undefined> {
  return db.select().from(issueFiles).where(eq(issueFiles.id, fileId)).get();
}

/** Удаляет строку и возвращает её (для удаления файла с диска); undefined — нет. */
export async function deleteById(
  db: Db,
  fileId: string,
): Promise<IssueFile | undefined> {
  const row = db
    .select()
    .from(issueFiles)
    .where(eq(issueFiles.id, fileId))
    .get();
  if (!row) {
    return undefined;
  }
  db.delete(issueFiles).where(eq(issueFiles.id, fileId)).run();
  return row;
}