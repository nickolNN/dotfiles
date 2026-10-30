import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { Db } from '../src/db/client';
import { createDb } from '../src/db/client';
import { repositories } from '../src/db/schema';
import {
  getRepositoryByUrl,
  updateRepositoryRunInstructions,
} from '../src/db/repositories.repo';

const NOW = '2026-06-01T00:00:00.000Z';
const BROWSE_URL = 'https://b.yadro.com/projects/KOS/repos/metromost_web/browse';
const CLONE_URL = 'https://b.yadro.com/scm/kos/metromost_web.git';

function seed(patch?: Partial<typeof repositories.$inferInsert>) {
  const db = createDb(':memory:');
  db.insert(repositories)
    .values({
      id: randomUUID(),
      url: BROWSE_URL,
      platform: 'bitbucket',
      full_name: 'KOS/metromost_web',
      clone_url: CLONE_URL,
      run_instructions: null,
      run_instructions_status: 'unknown',
      created_at: NOW,
      updated_at: NOW,
      ...patch,
    })
    .run();
  return db;
}

function rowByUrl(db: Db, url: string) {
  return db
    .select()
    .from(repositories)
    .where(eq(repositories.url, url))
    .get();
}

describe('repositories repo: run instructions lookup', () => {
  it('находит репозиторий по clone-URL, когда в реестре лежит browse-URL', () => {
    const db = seed();
    const saved = getRepositoryByUrl(db, CLONE_URL);
    expect(saved?.url).toBe(BROWSE_URL);
    expect(saved?.cloneUrl).toBe(CLONE_URL);
  });

  it('находит по browse-URL, когда clone_url не заполнен', () => {
    const db = seed({ clone_url: null });
    expect(getRepositoryByUrl(db, BROWSE_URL)?.url).toBe(BROWSE_URL);
    expect(getRepositoryByUrl(db, CLONE_URL)?.url).toBe(BROWSE_URL);
  });

  it('не находит чужой репозиторий и возвращает undefined для пустоты', () => {
    const db = seed();
    expect(
      getRepositoryByUrl(db, 'https://b.yadro.com/scm/kos/metromost_desktop.git'),
    ).toBeUndefined();
    expect(getRepositoryByUrl(db, '')).toBeUndefined();
  });

  it('не склеивает одноимённые репозитории разных проектов', () => {
    const db = seed();
    db.insert(repositories)
      .values({
        id: randomUUID(),
        url: 'https://b.yadro.com/projects/OTHER/repos/metromost_web/browse',
        clone_url: 'https://b.yadro.com/scm/other/metromost_web.git',
        run_instructions: null,
        run_instructions_status: 'unknown',
        created_at: NOW,
        updated_at: NOW,
      })
      .run();

    expect(getRepositoryByUrl(db, CLONE_URL)?.url).toBe(BROWSE_URL);
    expect(
      getRepositoryByUrl(db, 'https://b.yadro.com/scm/other/metromost_web.git')
        ?.url,
    ).toBe('https://b.yadro.com/projects/OTHER/repos/metromost_web/browse');
  });

  it('сопоставляет ssh-form с https-записью реестра', () => {
    const db = seed({ clone_url: null });
    expect(getRepositoryByUrl(db, 'git@b.yadro.com:kos/metromost_web.git')?.url).toBe(
      BROWSE_URL,
    );
  });
});

describe('repositories repo: updateRepositoryRunInstructions', () => {
  it('пишет инструкции в строку с browse-URL при вызове по clone-URL', () => {
    const db = seed();
    const updated = updateRepositoryRunInstructions(db, CLONE_URL, {
      instructions: 'pnpm install && ./DEV_SERVER.sh',
      status: 'generated',
    });

    expect(updated).toBe(true);
    const row = rowByUrl(db, BROWSE_URL);
    expect(row?.run_instructions_status).toBe('generated');
    expect(row?.run_instructions).toBe('pnpm install && ./DEV_SERVER.sh');
  });

  it('оставляет чужую строку нетронутой и отвечает false при отсутствии пары', () => {
    const db = seed();
    const updated = updateRepositoryRunInstructions(
      db,
      'https://b.yadro.com/scm/kos/other_repo.git',
      { instructions: null, status: 'failed' },
    );

    expect(updated).toBe(false);
    expect(rowByUrl(db, BROWSE_URL)?.run_instructions_status).toBe('unknown');
  });

  it('обновляет обе записи, если один и тот же репозиторий сохранён дважды', () => {
    const db = seed();
    db.insert(repositories)
      .values({
        id: randomUUID(),
        url: CLONE_URL,
        clone_url: null,
        run_instructions: null,
        run_instructions_status: 'unknown',
        created_at: NOW,
        updated_at: NOW,
      })
      .run();

    expect(
      updateRepositoryRunInstructions(db, CLONE_URL, {
        instructions: 'npm start',
        status: 'failed',
      }),
    ).toBe(true);

    const statuses = db
      .select({ status: repositories.run_instructions_status })
      .from(repositories)
      .all();
    expect(statuses).toHaveLength(2);
    expect(statuses.every((item) => item.status === 'failed')).toBe(true);
  });

  it('сбрасывает инструкции в null при провальном прогоне', () => {
    const db = seed({
      run_instructions: 'старые инструкции',
      run_instructions_status: 'generated',
    });

    updateRepositoryRunInstructions(db, CLONE_URL, {
      instructions: null,
      status: 'failed',
    });

    const row = rowByUrl(db, BROWSE_URL);
    expect(row?.run_instructions).toBeNull();
    expect(row?.run_instructions_status).toBe('failed');
  });
});
