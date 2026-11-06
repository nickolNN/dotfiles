import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DDL } from './ddl';
import { runMigrations } from './migrations';
import { DEFAULT_DB_PATH } from './paths';
import * as schema from './schema';

export { DEFAULT_DB_PATH, dbPathFromEnv } from './paths';

export type Db = BetterSQLite3Database<typeof schema>;

export function createDb(file: string = DEFAULT_DB_PATH): Db {
  if (file !== ':memory:') {
    mkdirSync(dirname(file), { recursive: true });
  }

  const sqlite = new Database(file);
  sqlite.pragma('foreign_keys = ON');
  sqlite.exec(DDL);
  runMigrations(sqlite);

  return drizzle(sqlite, { schema });
}