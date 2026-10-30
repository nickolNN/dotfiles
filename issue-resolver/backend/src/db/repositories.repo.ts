import { randomUUID } from 'node:crypto';
import {
  isSameRepository,
  type RepoConnectionStatus,
  type RepoPlatform,
  type RunInstructionsStatus,
  type SavedRepo,
} from '@issue-resolver/shared';
import { asc, eq, inArray, or, sql } from 'drizzle-orm';
import type { Db } from './client';
import { repositories } from './schema';

export interface RepositoryWrite {
  url: string;
  platform: RepoPlatform | null;
  fullName: string | null;
  defaultBranch: string | null;
  cloneUrl: string | null;
  language: string | null;
  description: string | null;
  isPrivate: boolean | null;
  connectionStatus: RepoConnectionStatus;
  lastValidatedAt: string | null;
  writeAccess: boolean;
}

function toColumns(write: RepositoryWrite) {
  return {
    url: write.url,
    platform: write.platform,
    full_name: write.fullName,
    default_branch: write.defaultBranch,
    clone_url: write.cloneUrl,
    language: write.language,
    description: write.description,
    is_private: write.isPrivate,
    connection_status: write.connectionStatus,
    last_validated_at: write.lastValidatedAt,
    write_access: write.writeAccess,
  };
}

export function toSavedRepo(row: typeof repositories.$inferSelect): SavedRepo {
  return {
    id: row.id,
    url: row.url,
    platform: row.platform ?? null,
    fullName: row.full_name,
    defaultBranch: row.default_branch,
    cloneUrl: row.clone_url,
    language: row.language,
    description: row.description,
    isPrivate: row.is_private,
    connectionStatus: row.connection_status,
    lastValidatedAt: row.last_validated_at,
    writeAccess: row.write_access,
    runInstructions: row.run_instructions,
    runInstructionsStatus: row.run_instructions_status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function listRepositories(db: Db): SavedRepo[] {
  return db
    .select()
    .from(repositories)
    .orderBy(asc(repositories.created_at), asc(sql`rowid`))
    .all()
    .map(toSavedRepo);
}

export function getRepository(db: Db, id: string): SavedRepo | undefined {
  const row = db
    .select()
    .from(repositories)
    .where(eq(repositories.id, id))
    .get();
  return row ? toSavedRepo(row) : undefined;
}

export function insertRepository(db: Db, write: RepositoryWrite): SavedRepo {
  const now = new Date().toISOString();
  const id = randomUUID();
  db.insert(repositories)
    .values({
      id,
      ...toColumns(write),
      run_instructions: null,
      run_instructions_status: 'unknown',
      created_at: now,
      updated_at: now,
    })
    .run();
  return {
    id,
    ...write,
    runInstructions: null,
    runInstructionsStatus: 'unknown',
    createdAt: now,
    updatedAt: now,
  };
}

export function updateRepository(
  db: Db,
  id: string,
  write: RepositoryWrite,
): SavedRepo | undefined {
  const now = new Date().toISOString();
  const result = db
    .update(repositories)
    .set({ ...toColumns(write), updated_at: now })
    .where(eq(repositories.id, id))
    .run();
  if (result.changes === 0) {
    return undefined;
  }
  return getRepository(db, id);
}

function findRowsByUrl(db: Db, url: string): typeof repositories.$inferSelect[] {
  if (!url.trim()) return [];

  const exact = db
    .select()
    .from(repositories)
    .where(or(eq(repositories.url, url), eq(repositories.clone_url, url)))
    .all();
  if (exact.length > 0) return exact;

  return db
    .select()
    .from(repositories)
    .all()
    .filter(
      (row) =>
        isSameRepository(row.url, url) ||
        (row.clone_url !== null && isSameRepository(row.clone_url, url)),
    );
}

export function getRepositoryByUrl(
  db: Db,
  url: string,
): SavedRepo | undefined {
  const [row] = findRowsByUrl(db, url);
  return row ? toSavedRepo(row) : undefined;
}

export function updateRepositoryRunInstructions(
  db: Db,
  url: string,
  patch: { instructions: string | null; status: RunInstructionsStatus },
): boolean {
  const ids = findRowsByUrl(db, url).map((row) => row.id);
  if (ids.length === 0) return false;

  db.update(repositories)
    .set({
      run_instructions: patch.instructions,
      run_instructions_status: patch.status,
      updated_at: new Date().toISOString(),
    })
    .where(inArray(repositories.id, ids))
    .run();
  return true;
}

export function deleteRepository(db: Db, id: string): boolean {
  const result = db.delete(repositories).where(eq(repositories.id, id)).run();
  return result.changes > 0;
}