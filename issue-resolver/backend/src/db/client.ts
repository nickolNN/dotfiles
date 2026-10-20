import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import * as schema from './schema';

export const DEFAULT_DB_PATH = resolve(
  import.meta.dirname,
  '../../data/issue-resolver.db',
);

/**
 * Путь БД из env: при заданном `ISSUE_RESOLVER_DATA_DIR` — 
 * `<DATA_DIR>/issue-resolver.db`, иначе DEFAULT_DB_PATH (текущее поведение).
 * Общий DATA_DIR двигает БД, workspaces и originals-кэш вместе.
 */
export const dbPathFromEnv = (env: NodeJS.ProcessEnv): string => {
  const dataDir = env.ISSUE_RESOLVER_DATA_DIR;
  return dataDir ? join(dataDir, 'issue-resolver.db') : DEFAULT_DB_PATH;
};

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
  thinking_level TEXT,
  step_thinking_levels TEXT,
  container_name TEXT,
  source TEXT,
  tag_id TEXT REFERENCES tags(id) ON DELETE SET NULL,
  dev_server_port INTEGER,
  dev_server_pid INTEGER,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS repositories (
  id TEXT PRIMARY KEY,
  url TEXT NOT NULL,
  platform TEXT,
  full_name TEXT,
  default_branch TEXT,
  clone_url TEXT,
  language TEXT,
  description TEXT,
  is_private INTEGER,
  connection_status TEXT NOT NULL DEFAULT 'unknown',
  last_validated_at TEXT,
  write_access INTEGER NOT NULL DEFAULT 0,
  run_instructions TEXT,
  run_instructions_status TEXT NOT NULL DEFAULT 'unknown',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tags (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  run_instructions TEXT,
  run_instructions_status TEXT NOT NULL DEFAULT 'unknown',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tag_repositories (
  id TEXT PRIMARY KEY,
  tag_id TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  repository_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  bootstrap_enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS tag_repositories_tag_id_repository_id_unique
  ON tag_repositories(tag_id, repository_id);

CREATE TABLE IF NOT EXISTS issue_repositories (
  id TEXT PRIMARY KEY,
  issue_id TEXT NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  repository_url TEXT NOT NULL,
  branch_name TEXT NOT NULL,
  create_mr INTEGER NOT NULL DEFAULT 0,
  bootstrap_enabled INTEGER NOT NULL DEFAULT 1,
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
  thinking_level TEXT,
  step_thinking_levels TEXT,
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
  events TEXT NOT NULL DEFAULT '[]',
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

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL DEFAULT '',
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
  if (!columns.has('thinking_level')) {
    sqlite.exec('ALTER TABLE iterations ADD COLUMN thinking_level TEXT');
  }
  if (!columns.has('step_thinking_levels')) {
    sqlite.exec('ALTER TABLE iterations ADD COLUMN step_thinking_levels TEXT');
  }
  if (!columns.has('worker_count')) {
    sqlite.exec('ALTER TABLE iterations ADD COLUMN worker_count INTEGER');
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
  if (!columns.has('bootstrap_enabled')) {
    sqlite.exec(
      'ALTER TABLE issue_repositories ADD COLUMN bootstrap_enabled INTEGER NOT NULL DEFAULT 1',
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
  if (!columns.has('thinking_level')) {
    sqlite.exec('ALTER TABLE issues ADD COLUMN thinking_level TEXT');
  }
  if (!columns.has('step_thinking_levels')) {
    sqlite.exec('ALTER TABLE issues ADD COLUMN step_thinking_levels TEXT');
  }
  if (!columns.has('desired_result')) {
    sqlite.exec(
      "ALTER TABLE issues ADD COLUMN desired_result TEXT NOT NULL DEFAULT 'md'",
    );
  }
  if (!columns.has('dev_server_port')) {
    sqlite.exec('ALTER TABLE issues ADD COLUMN dev_server_port INTEGER');
  }
  if (!columns.has('dev_server_pid')) {
    sqlite.exec('ALTER TABLE issues ADD COLUMN dev_server_pid INTEGER');
  }
  if (!columns.has('tag_id')) {
    sqlite.exec('ALTER TABLE issues ADD COLUMN tag_id TEXT REFERENCES tags(id) ON DELETE SET NULL');
  }
}

function ensureRepositoriesColumns(sqlite: Database.Database): void {
  const columns = new Set(
    (sqlite.pragma('table_info(repositories)') as { name: string }[]).map(
      (column) => column.name,
    ),
  );
  if (!columns.has('url')) {
    sqlite.exec("ALTER TABLE repositories ADD COLUMN url TEXT NOT NULL DEFAULT ''");
  }
  if (!columns.has('platform')) {
    sqlite.exec('ALTER TABLE repositories ADD COLUMN platform TEXT');
  }
  if (!columns.has('full_name')) {
    sqlite.exec('ALTER TABLE repositories ADD COLUMN full_name TEXT');
  }
  if (!columns.has('default_branch')) {
    sqlite.exec('ALTER TABLE repositories ADD COLUMN default_branch TEXT');
  }
  if (!columns.has('clone_url')) {
    sqlite.exec('ALTER TABLE repositories ADD COLUMN clone_url TEXT');
  }
  if (!columns.has('language')) {
    sqlite.exec('ALTER TABLE repositories ADD COLUMN language TEXT');
  }
  if (!columns.has('description')) {
    sqlite.exec('ALTER TABLE repositories ADD COLUMN description TEXT');
  }
  if (!columns.has('is_private')) {
    sqlite.exec('ALTER TABLE repositories ADD COLUMN is_private INTEGER');
  }
  if (!columns.has('connection_status')) {
    sqlite.exec(
      "ALTER TABLE repositories ADD COLUMN connection_status TEXT NOT NULL DEFAULT 'unknown'",
    );
  }
  if (!columns.has('last_validated_at')) {
    sqlite.exec('ALTER TABLE repositories ADD COLUMN last_validated_at TEXT');
  }
  if (!columns.has('write_access')) {
    sqlite.exec(
      'ALTER TABLE repositories ADD COLUMN write_access INTEGER NOT NULL DEFAULT 0',
    );
  }
  if (!columns.has('run_instructions')) {
    sqlite.exec('ALTER TABLE repositories ADD COLUMN run_instructions TEXT');
  }
  if (!columns.has('run_instructions_status')) {
    sqlite.exec(
      "ALTER TABLE repositories ADD COLUMN run_instructions_status TEXT NOT NULL DEFAULT 'unknown'",
    );
  }
  if (!columns.has('created_at')) {
    sqlite.exec("ALTER TABLE repositories ADD COLUMN created_at TEXT NOT NULL DEFAULT ''");
  }
  if (!columns.has('updated_at')) {
    sqlite.exec("ALTER TABLE repositories ADD COLUMN updated_at TEXT NOT NULL DEFAULT ''");
  }
}

function ensureStepRunColumns(sqlite: Database.Database): void {
  const columns = new Set(
    (sqlite.pragma('table_info(step_runs)') as { name: string }[]).map(
      (column) => column.name,
    ),
  );
  if (!columns.has('events')) {
    sqlite.exec(
      "ALTER TABLE step_runs ADD COLUMN events TEXT NOT NULL DEFAULT '[]'",
    );
  }
}

/* Таблица settings создаётся свежей, доводить ALTER-ами пока нечего. */
function ensureSettingsColumns(_sqlite: Database.Database): void {}

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
  ensureStepRunColumns(sqlite);
  ensureStepOutputColumns(sqlite);
  ensureRepositoriesColumns(sqlite);
  ensureSettingsColumns(sqlite);

  return drizzle(sqlite, { schema });
}