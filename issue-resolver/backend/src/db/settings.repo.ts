import { eq } from 'drizzle-orm';
import type { Db } from './client';
import { settings } from './schema';
import { nowIso } from './rows';

export function getSetting(db: Db, key: string): string | undefined {
  const row = db.select().from(settings).where(eq(settings.key, key)).get();
  return row?.value;
}

export function setSetting(db: Db, key: string, value: string): void {
  const now = nowIso();
  db.insert(settings)
    .values({ key, value, created_at: now, updated_at: now })
    .onConflictDoUpdate({
      target: settings.key,
      set: { value, updated_at: now },
    })
    .run();
}