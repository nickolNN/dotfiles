import { randomUUID } from 'node:crypto';
import type {
  CreateTagRequest,
  RunInstructionsStatus,
  UpdateTagRequest,
} from '@issue-resolver/shared';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { createDb } from '../src/db/client';
import type { Db } from '../src/db/client';
import { repositories } from '../src/db/schema';
import {
  insertTag,
  updateTag,
  updateTagRunInstructions,
} from '../src/db/tags.repo';

const TAGS_ROUTE = '/issue-resolver/api/v1/tags';
const OLD_INSTRUCTIONS = '# Workspace\nproxy on :8081';

function makeDb(): Db {
  return createDb(':memory:');
}

/** Строка `repositories` с уже сгенерированной инструкцией (статус по умолчанию). */
function seedRepo(
  db: Db,
  url: string,
  status: RunInstructionsStatus = 'generated',
): string {
  const id = randomUUID();
  const now = new Date().toISOString();
  db.insert(repositories)
    .values({
      id,
      url,
      run_instructions: `## Run\nold instructions for ${url}`,
      run_instructions_status: status,
      created_at: now,
      updated_at: now,
    })
    .run();
  return id;
}

/** Строка `repositories` как её видит движок: статус + текст. */
function repoRunInstructions(db: Db, id: string) {
  const row = db
    .select({
      instructions: repositories.run_instructions,
      status: repositories.run_instructions_status,
      updatedAt: repositories.updated_at,
    })
    .from(repositories)
    .where(eq(repositories.id, id))
    .get();
  return row;
}

function createTag(
  db: Db,
  repoIds: string[],
  runInstructions: string | null = OLD_INSTRUCTIONS,
) {
  const input: CreateTagRequest = {
    name: 'front-set',
    run_instructions: runInstructions,
    repositories: repoIds.map((repository_id) => ({ repository_id })),
  };
  return insertTag(db, input);
}

describe('updateTag — смена тег-инструкций инвалидирует разовый анализ', () => {
  it('новый текст → репозитории тега сброшены в null/unknown', () => {
    const db = makeDb();
    const inTag = seedRepo(db, 'https://github.com/acme/shell');
    const outside = seedRepo(db, 'https://github.com/acme/other');
    const tag = createTag(db, [inTag]);

    const updated = updateTag(db, tag.id, {
      run_instructions: '# Workspace\nproxy on :9090',
    });

    expect(updated?.run_instructions).toBe('# Workspace\nproxy on :9090');
    expect(repoRunInstructions(db, inTag)).toMatchObject({
      instructions: null,
      status: 'unknown',
    });
    // Репозиторий вне тега не тронут.
    expect(repoRunInstructions(db, outside)).toMatchObject({
      status: 'generated',
    });
  });

  it('тот же текст → ничего не инвалидируется', () => {
    const db = makeDb();
    const repoId = seedRepo(db, 'https://github.com/acme/shell');
    const tag = createTag(db, [repoId]);

    updateTag(db, tag.id, { run_instructions: OLD_INSTRUCTIONS });

    expect(repoRunInstructions(db, repoId)).toMatchObject({
      status: 'generated',
    });
  });

  it('правка только имени/описания → ничего не инвалидируется', () => {
    const db = makeDb();
    const repoId = seedRepo(db, 'https://github.com/acme/shell');
    const tag = createTag(db, [repoId]);

    updateTag(db, tag.id, { name: 'renamed', description: 'note' });

    expect(repoRunInstructions(db, repoId)).toMatchObject({
      status: 'generated',
    });
  });

  it('смена текста + замена списка репозиториев → инвалидируется новый состав', () => {
    const db = makeDb();
    const removed = seedRepo(db, 'https://github.com/acme/old-repo');
    const added = seedRepo(db, 'https://github.com/acme/new-repo');
    const tag = createTag(db, [removed]);

    const input: UpdateTagRequest = {
      run_instructions: '# Workspace\nv2',
      repositories: [{ repository_id: added }],
    };
    updateTag(db, tag.id, input);

    expect(repoRunInstructions(db, added)).toMatchObject({
      instructions: null,
      status: 'unknown',
    });
    // Отсоединённый репозиторий остаётся как был.
    expect(repoRunInstructions(db, removed)).toMatchObject({
      status: 'generated',
    });
  });

  it('сброс текста (run_instructions: "") не инвалидирует status второй раз', () => {
    const db = makeDb();
    const repoId = seedRepo(db, 'https://github.com/acme/shell');
    const tag = createTag(db, [repoId]);

    updateTag(db, tag.id, { run_instructions: '' });

    expect(repoRunInstructions(db, repoId)).toMatchObject({
      instructions: null,
      status: 'unknown',
    });
    expect(updateTag(db, tag.id, {})?.run_instructions).toBe('');
  });

  it('updateTagRunInstructions (обратная запись агента) НЕ инвалидирует', () => {
    const db = makeDb();
    const repoId = seedRepo(db, 'https://github.com/acme/shell');
    const tag = createTag(db, [repoId]);

    updateTagRunInstructions(db, tag.id, {
      instructions: '# Workspace\nwritten by agent',
      status: 'generated',
    });

    expect(repoRunInstructions(db, repoId)).toMatchObject({
      status: 'generated',
    });
  });

  it('PUT /tags/:id с новым текстом инвалидирует через HTTP', async () => {
    const db = makeDb();
    const repoId = seedRepo(db, 'https://github.com/acme/shell');
    const tag = createTag(db, [repoId]);
    const app = buildApp(db);

    const response = await app.inject({
      method: 'PUT',
      url: `${TAGS_ROUTE}/${tag.id}`,
      payload: { run_instructions: '# Workspace from UI\nport :9100' },
    });
    await app.close();

    expect(response.statusCode).toBe(200);
    expect(repoRunInstructions(db, repoId)).toMatchObject({
      instructions: null,
      status: 'unknown',
    });
  });
});