import { randomUUID } from 'node:crypto';
import type {
  CreateTagRequest,
  RunInstructionsStatus,
  Tag,
  TagRepository,
  TagRepositoryWithRepo,
  UpdateTagRequest,
} from '@issue-resolver/shared';
import { asc, eq, inArray } from 'drizzle-orm';
import type { Db } from './client';
import { toSavedRepo } from './repositories.repo';
import { repositories, tagRepositories, tags } from './schema';

type TagRow = typeof tags.$inferSelect;
type TagRepositoryRow = typeof tagRepositories.$inferSelect;
type RepositoryRow = typeof repositories.$inferSelect;

function toTagRepository(row: TagRepositoryRow): TagRepository {
  return {
    id: row.id,
    tag_id: row.tag_id,
    repository_id: row.repository_id,
    bootstrap_enabled: row.bootstrap_enabled,
    created_at: row.created_at,
  };
}

function toTagRepositoryWithRepo(
  row: TagRepositoryRow,
  repository: RepositoryRow,
): TagRepositoryWithRepo {
  return { ...toTagRepository(row), repository: toSavedRepo(repository) };
}

function toTag(row: TagRow, repositories: TagRepositoryWithRepo[]): Tag {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    run_instructions: row.run_instructions,
    run_instructions_status: row.run_instructions_status,
    repositories,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function repositoriesByTag(
  db: Db,
  tagIds: string[],
): Map<string, TagRepositoryWithRepo[]> {
  const grouped = new Map<string, TagRepositoryWithRepo[]>();
  if (tagIds.length === 0) {
    return grouped;
  }
  const rows = db
    .select({ link: tagRepositories, repo: repositories })
    .from(tagRepositories)
    .innerJoin(repositories, eq(tagRepositories.repository_id, repositories.id))
    .where(inArray(tagRepositories.tag_id, tagIds))
    .orderBy(asc(tagRepositories.created_at), asc(tagRepositories.id))
    .all();
  for (const { link, repo } of rows) {
    const list = grouped.get(link.tag_id) ?? [];
    list.push(toTagRepositoryWithRepo(link, repo));
    grouped.set(link.tag_id, list);
  }
  return grouped;
}

export function listTags(db: Db): Tag[] {
  const rows = db
    .select()
    .from(tags)
    .orderBy(asc(tags.created_at), asc(tags.id))
    .all();
  const grouped = repositoriesByTag(
    db,
    rows.map((row) => row.id),
  );
  return rows.map((row) => toTag(row, grouped.get(row.id) ?? []));
}

export function getTag(db: Db, id: string): Tag | undefined {
  const row = db.select().from(tags).where(eq(tags.id, id)).get();
  if (!row) {
    return undefined;
  }
  return toTag(row, repositoriesByTag(db, [id]).get(id) ?? []);
}

export function insertTag(db: Db, input: CreateTagRequest): Tag {
  const id = randomUUID();
  const now = new Date().toISOString();

  db.transaction((tx) => {
    tx.insert(tags)
      .values({
        id,
        name: input.name,
        description: input.description ?? null,
        run_instructions: input.run_instructions ?? null,
        run_instructions_status: input.run_instructions ? 'generated' : 'unknown',
        created_at: now,
        updated_at: now,
      })
      .run();

    if (input.repositories.length > 0) {
      tx.insert(tagRepositories)
        .values(
          input.repositories.map((repository) => ({
            id: randomUUID(),
            tag_id: id,
            repository_id: repository.repository_id,
            bootstrap_enabled: repository.bootstrap_enabled ?? true,
            created_at: now,
          })),
        )
        .run();
    }
  });

  const created = getTag(db, id);
  if (!created) {
    throw new Error('tag insert failed');
  }
  return created;
}

export function updateTag(
  db: Db,
  id: string,
  input: UpdateTagRequest,
): Tag | undefined {
  const existing = db.select().from(tags).where(eq(tags.id, id)).get();
  if (!existing) {
    return undefined;
  }
  const now = new Date().toISOString();
  const patch: { name?: string; description?: string | null; run_instructions?: string | null; run_instructions_status?: import('@issue-resolver/shared').RunInstructionsStatus; updated_at: string } =
    { updated_at: now };
  if (input.name !== undefined) {
    patch.name = input.name;
  }
  if (input.description !== undefined) {
    patch.description = input.description;
  }
  if (input.run_instructions !== undefined) {
    patch.run_instructions = input.run_instructions;
    patch.run_instructions_status = input.run_instructions ? 'generated' : 'unknown';
  }
  const nextRepositories = input.repositories;
  const instructionsChanged =
    input.run_instructions !== undefined &&
    input.run_instructions !== existing.run_instructions;

  db.transaction((tx) => {
    tx.update(tags).set(patch).where(eq(tags.id, id)).run();

    if (nextRepositories !== undefined) {
      tx.delete(tagRepositories)
        .where(eq(tagRepositories.tag_id, id))
        .run();
      if (nextRepositories.length > 0) {
        tx.insert(tagRepositories)
          .values(
            nextRepositories.map((repository) => ({
              id: randomUUID(),
              tag_id: id,
              repository_id: repository.repository_id,
              bootstrap_enabled: repository.bootstrap_enabled ?? true,
              created_at: now,
            })),
          )
          .run();
      }
    }

    if (instructionsChanged) {
      const repoIds = tx
        .select({ id: tagRepositories.repository_id })
        .from(tagRepositories)
        .where(eq(tagRepositories.tag_id, id))
        .all()
        .map((row) => row.id);
      if (repoIds.length > 0) {
        tx.update(repositories)
          .set({
            run_instructions: null,
            run_instructions_status: 'unknown',
            updated_at: now,
          })
          .where(inArray(repositories.id, repoIds))
          .run();
      }
    }
  });

  return getTag(db, id);
}

export function deleteTag(db: Db, id: string): boolean {
  const result = db.delete(tags).where(eq(tags.id, id)).run();
  return result.changes > 0;
}

export function updateTagRunInstructions(
  db: Db,
  id: string,
  patch: { instructions: string | null; status: RunInstructionsStatus },
): void {
  db.update(tags)
    .set({
      run_instructions: patch.instructions,
      run_instructions_status: patch.status,
      updated_at: new Date().toISOString(),
    })
    .where(eq(tags.id, id))
    .run();
}