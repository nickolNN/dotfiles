import { randomUUID } from 'node:crypto';
import type {
  RepoConnectionStatus,
  RepoPlatform,
  RunInstructionsStatus,
  SavedRepo,
} from '@issue-resolver/shared';
import { asc, eq } from 'drizzle-orm';
import type { Db } from './client';
import { repositories } from './schema';

/**
 * Записываемые поля валидации репозитория. `run_instructions`/
 * `run_instructions_status` сюда не входят: их пишет отдельный процесс
 * (агент-анализатор), а не валидация.
 */
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

/** Все сохранённые репозитории в порядке добавления. */
export function listRepositories(db: Db): SavedRepo[] {
  return db
    .select()
    .from(repositories)
    .orderBy(asc(repositories.created_at), asc(repositories.id))
    .all()
    .map(toSavedRepo);
}

/** Репозиторий по id или undefined. */
export function getRepository(db: Db, id: string): SavedRepo | undefined {
  const row = db
    .select()
    .from(repositories)
    .where(eq(repositories.id, id))
    .get();
  return row ? toSavedRepo(row) : undefined;
}

/** Создаёт репозиторий; `run_instructions` стартует пустым ('unknown'). */
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

/** Обновляет поля валидации; `run_instructions*` не трогает. undefined — нет id. */
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

/** Репозиторий по URL (первый совпавший) или undefined. */
export function getRepositoryByUrl(
  db: Db,
  url: string,
): SavedRepo | undefined {
  const row = db
    .select()
    .from(repositories)
    .where(eq(repositories.url, url))
    .get();
  return row ? toSavedRepo(row) : undefined;
}

/**
 * Записывает результат работы агента-анализатора: Markdown-инструкцию и её
 * статус. `instructions: null` очищает поле (статус `failed` — инструкция
 * устарела/не сгенерирована). Валидацию не трогает.
 */
export function updateRepositoryRunInstructions(
  db: Db,
  url: string,
  patch: { instructions: string | null; status: RunInstructionsStatus },
): void {
  db.update(repositories)
    .set({
      run_instructions: patch.instructions,
      run_instructions_status: patch.status,
      updated_at: new Date().toISOString(),
    })
    .where(eq(repositories.url, url))
    .run();
}

/** Удаляет репозиторий; false — строки не было. */
export function deleteRepository(db: Db, id: string): boolean {
  const result = db.delete(repositories).where(eq(repositories.id, id)).run();
  return result.changes > 0;
}