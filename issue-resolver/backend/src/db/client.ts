import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import * as schema from './schema';

export const DEFAULT_DB_PATH = resolve(
  import.meta.dirname,
  '../../data/issue-resolver.db',
);

/**
 * DDL совпадает с src/db/schema.ts. drizzle-kit-миграции в этом срезе нет,
 * поэтому таблицы создаются идемпотентно при открытии БД.
 */
const DDL = `
CREATE TABLE IF NOT EXISTS issues (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  desired_result TEXT NOT NULL DEFAULT 'md',
  jira_issue_url TEXT,
  pipeline_steps TEXT NOT NULL,
  step_models TEXT,
  container_name TEXT,
  source TEXT,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS issue_repositories (
  id TEXT PRIMARY KEY,
  issue_id TEXT NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  repository_url TEXT NOT NULL,
  branch_name TEXT NOT NULL,
  create_mr INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS issue_repositories_issue_id_repository_url_branch_name_unique
  ON issue_repositories(issue_id, repository_url, branch_name);

CREATE TABLE IF NOT EXISTS iterations (
  id TEXT PRIMARY KEY,
  issue_id TEXT NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  number INTEGER NOT NULL,
  context TEXT NOT NULL DEFAULT '',
  review_context TEXT NOT NULL DEFAULT '',
  is_review_need INTEGER NOT NULL DEFAULT 0,
  steps TEXT NOT NULL,
  model TEXT,
  step_models TEXT,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS iterations_issue_id_number_unique
  ON iterations(issue_id, number);

CREATE TABLE IF NOT EXISTS step_runs (
  id TEXT PRIMARY KEY,
  iteration_id TEXT NOT NULL REFERENCES iterations(id) ON DELETE CASCADE,
  step TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  status TEXT NOT NULL,
  context TEXT NOT NULL,
  feedback TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS step_runs_iteration_id_step_attempt_unique
  ON step_runs(iteration_id, step, attempt);

CREATE TABLE IF NOT EXISTS question_answers (
  id TEXT PRIMARY KEY,
  iteration_id TEXT NOT NULL REFERENCES iterations(id) ON DELETE CASCADE,
  question_id TEXT NOT NULL,
  value TEXT,
  confirmed INTEGER,
  cancelled INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS question_answers_iteration_id_question_id_unique
  ON question_answers(iteration_id, question_id);

CREATE TABLE IF NOT EXISTS issue_files (
  id TEXT PRIMARY KEY,
  issue_id TEXT NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  iteration_id TEXT REFERENCES iterations(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  rel_path TEXT NOT NULL,
  size INTEGER NOT NULL,
  mime_type TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS issue_files_issue_id_idx
  ON issue_files(issue_id);

CREATE INDEX IF NOT EXISTS issue_files_iteration_id_idx
  ON issue_files(iteration_id);

CREATE TABLE IF NOT EXISTS step_outputs (
  id TEXT PRIMARY KEY,
  step_run_id TEXT NOT NULL UNIQUE REFERENCES step_runs(id) ON DELETE CASCADE,
  report TEXT NOT NULL,
  stdout TEXT NOT NULL DEFAULT '',
  stderr TEXT NOT NULL DEFAULT '',
  events TEXT NOT NULL DEFAULT '[]',
  stats TEXT,
  screenshots_dir TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`;

export type Db = BetterSQLite3Database<typeof schema>;

/**
 * Догоняет уже существующие БД: `CREATE TABLE IF NOT EXISTS` не добавляет
 * новые колонки в созданную ранее таблицу, поэтому доводим их ALTER-ами.
 * Идемпотентно — повторный запуск ничего не делает. DDL — литералы, без
 * интерполяции извне.
 */
function ensureIterationColumns(sqlite: Database.Database): void {
  const columns = new Set(
    (sqlite.pragma('table_info(iterations)') as { name: string }[]).map(
      (column) => column.name,
    ),
  );
  if (!columns.has('review_context')) {
    sqlite.exec(
      "ALTER TABLE iterations ADD COLUMN review_context TEXT NOT NULL DEFAULT ''",
    );
  }
  if (!columns.has('is_review_need')) {
    sqlite.exec(
      'ALTER TABLE iterations ADD COLUMN is_review_need INTEGER NOT NULL DEFAULT 0',
    );
  }
  if (!columns.has('step_models')) {
    sqlite.exec('ALTER TABLE iterations ADD COLUMN step_models TEXT');
  }
}

function ensureIssueRepositoryColumns(sqlite: Database.Database): void {
  const columns = new Set(
    (sqlite.pragma('table_info(issue_repositories)') as { name: string }[]).map(
      (column) => column.name,
    ),
  );
  if (!columns.has('create_mr')) {
    sqlite.exec(
      'ALTER TABLE issue_repositories ADD COLUMN create_mr INTEGER NOT NULL DEFAULT 0',
    );
  }
}

function ensureIssueColumns(sqlite: Database.Database): void {
  const columns = new Set(
    (sqlite.pragma('table_info(issues)') as { name: string }[]).map(
      (column) => column.name,
    ),
  );
  if (!columns.has('source')) {
    sqlite.exec('ALTER TABLE issues ADD COLUMN source TEXT');
  }
  if (!columns.has('description')) {
    sqlite.exec(
      "ALTER TABLE issues ADD COLUMN description TEXT NOT NULL DEFAULT ''",
    );
  }
  if (!columns.has('step_models')) {
    sqlite.exec('ALTER TABLE issues ADD COLUMN step_models TEXT');
  }
  if (!columns.has('desired_result')) {
    sqlite.exec(
      "ALTER TABLE issues ADD COLUMN desired_result TEXT NOT NULL DEFAULT 'md'",
    );
  }
}

function ensureStepOutputColumns(sqlite: Database.Database): void {
  const columns = new Set(
    (sqlite.pragma('table_info(step_outputs)') as { name: string }[]).map(
      (column) => column.name,
    ),
  );
  if (!columns.has('stdout')) {
    sqlite.exec(
      "ALTER TABLE step_outputs ADD COLUMN stdout TEXT NOT NULL DEFAULT ''",
    );
  }
  if (!columns.has('stderr')) {
    sqlite.exec(
      "ALTER TABLE step_outputs ADD COLUMN stderr TEXT NOT NULL DEFAULT ''",
    );
  }
  if (!columns.has('events')) {
    sqlite.exec(
      "ALTER TABLE step_outputs ADD COLUMN events TEXT NOT NULL DEFAULT '[]'",
    );
  }
  if (!columns.has('stats')) {
    sqlite.exec('ALTER TABLE step_outputs ADD COLUMN stats TEXT');
  }
}

export function createDb(file: string = DEFAULT_DB_PATH): Db {
  if (file !== ':memory:') {
    mkdirSync(dirname(file), { recursive: true });
  }

  const sqlite = new Database(file);
  sqlite.pragma('foreign_keys = ON');
  sqlite.exec(DDL);
  ensureIterationColumns(sqlite);
  ensureIssueColumns(sqlite);
  ensureIssueRepositoryColumns(sqlite);
  ensureStepOutputColumns(sqlite);

  return drizzle(sqlite, { schema });
}