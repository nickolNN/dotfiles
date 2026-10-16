import { eq } from 'drizzle-orm';
import type { Db } from './client';
import { settings } from './schema';

/** Значение настройки по ключу или undefined, если её нет. */
export function getSetting(db: Db, key: string): string | undefined {
  const row = db.select().from(settings).where(eq(settings.key, key)).get();
  return row?.value;
}

/** Записывает настройку (upsert), сохраняя исходный created_at. */
export function setSetting(db: Db, key: string, value: string): void {
  const now = new Date().toISOString();
  db.insert(settings)
    .values({ key, value, created_at: now, updated_at: now })
    .onConflictDoUpdate({
      target: settings.key,
      set: { value, updated_at: now },
    })
    .run();
}