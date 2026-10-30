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

export const dbPathFromEnv = (env: NodeJS.ProcessEnv): string => {
  const dataDir = env.ISSUE_RESOLVER_DATA_DIR;
  return dataDir ? join(dataDir, 'issue-resolver.db') : DEFAULT_DB_PATH;
};

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
  merge_requests TEXT,
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
  issue_id TEXT NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  iteration_id TEXT REFERENCES iterations(id) ON DELETE CASCADE,
  step TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  status TEXT NOT NULL,
  context TEXT NOT NULL,
  feedback TEXT,
  events TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Индексы step_runs создаются после миграции (см. createDb): legacy-таблица
-- без колонки issue_id уронила бы CREATE INDEX.
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

CREATE TABLE IF NOT EXISTS retro_runs (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  model TEXT,
  instructions TEXT,
  session_limit INTEGER,
  thinking_level TEXT,
  report TEXT,
  error TEXT,
  stdout TEXT NOT NULL DEFAULT '',
  stderr TEXT NOT NULL DEFAULT '',
  events TEXT NOT NULL DEFAULT '[]',
  stats TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS retro_runs_created_at_idx
  ON retro_runs(created_at);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`;

export type Db = BetterSQLite3Database<typeof schema>;

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
  if (!columns.has('devops_model')) {
    if (columns.has('bootstrapper_model')) {
      sqlite.exec(
        'ALTER TABLE issues RENAME COLUMN bootstrapper_model TO devops_model',
      );
    } else {
      sqlite.exec('ALTER TABLE issues ADD COLUMN devops_model TEXT');
    }
  }
  if (!columns.has('devops_thinking_level')) {
    if (columns.has('bootstrapper_thinking_level')) {
      sqlite.exec(
        'ALTER TABLE issues RENAME COLUMN bootstrapper_thinking_level TO devops_thinking_level',
      );
    } else {
      sqlite.exec('ALTER TABLE issues ADD COLUMN devops_thinking_level TEXT');
    }
  }
  if (!columns.has('worker_count')) {
    sqlite.exec('ALTER TABLE issues ADD COLUMN worker_count INTEGER');
  }
  if (!columns.has('merge_requests')) {
    sqlite.exec('ALTER TABLE issues ADD COLUMN merge_requests TEXT');
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

function ensureRetroRunColumns(sqlite: Database.Database): void {
  const columns = new Set(
    (sqlite.pragma('table_info(retro_runs)') as { name: string }[]).map(
      (column) => column.name,
    ),
  );
  if (!columns.has('model')) {
    sqlite.exec('ALTER TABLE retro_runs ADD COLUMN model TEXT');
  }
  if (!columns.has('instructions')) {
    sqlite.exec('ALTER TABLE retro_runs ADD COLUMN instructions TEXT');
  }
  if (!columns.has('session_limit')) {
    sqlite.exec('ALTER TABLE retro_runs ADD COLUMN session_limit INTEGER');
  }
  if (!columns.has('thinking_level')) {
    sqlite.exec('ALTER TABLE retro_runs ADD COLUMN thinking_level TEXT');
  }
}

function ensureStepRunIssueColumn(sqlite: Database.Database): void {
  const columns = sqlite.pragma('table_info(step_runs)') as {
    name: string;
    notnull: number;
  }[];
  const byName = new Map(columns.map((column) => [column.name, column]));
  const iterationNotNull = byName.get('iteration_id')?.notnull === 1;
  if (byName.has('issue_id') && !iterationNotNull) return;

  sqlite.pragma('foreign_keys = OFF');
  try {
    sqlite.exec('BEGIN');
    sqlite.exec(`
CREATE TABLE step_runs_rebuilt (
  id TEXT PRIMARY KEY,
  issue_id TEXT NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  iteration_id TEXT REFERENCES iterations(id) ON DELETE CASCADE,
  step TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  status TEXT NOT NULL,
  context TEXT NOT NULL,
  feedback TEXT,
  events TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
)`);
    sqlite.exec(`
INSERT INTO step_runs_rebuilt
  (id, issue_id, iteration_id, step, attempt, status, context, feedback, events, created_at, updated_at)
SELECT s.id, COALESCE(i.issue_id, ''), s.iteration_id, s.step, s.attempt, s.status, s.context, s.feedback,
       COALESCE(s.events, '[]'), s.created_at, s.updated_at
FROM step_runs s LEFT JOIN iterations i ON i.id = s.iteration_id`);
    sqlite.exec('DROP TABLE step_runs');
    sqlite.exec('ALTER TABLE step_runs_rebuilt RENAME TO step_runs');
    sqlite.exec('DROP INDEX IF EXISTS step_runs_iteration_id_step_attempt_unique');
    sqlite.exec(
      'CREATE UNIQUE INDEX IF NOT EXISTS step_runs_iteration_step_attempt_unique ON step_runs(iteration_id, step, attempt) WHERE iteration_id IS NOT NULL',
    );
    sqlite.exec(
      'CREATE UNIQUE INDEX IF NOT EXISTS step_runs_issue_step_attempt_unique ON step_runs(issue_id, step, attempt) WHERE iteration_id IS NULL',
    );
    sqlite.exec('COMMIT');
  } catch (error) {
    sqlite.exec('ROLLBACK');
    throw error;
  } finally {
    sqlite.pragma('foreign_keys = ON');
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
  ensureRetroRunColumns(sqlite);
  ensureStepRunColumns(sqlite);
  ensureStepRunIssueColumn(sqlite);
  sqlite.exec(`
DROP INDEX IF EXISTS step_runs_iteration_id_step_attempt_unique;
CREATE UNIQUE INDEX IF NOT EXISTS step_runs_iteration_step_attempt_unique
  ON step_runs(iteration_id, step, attempt) WHERE iteration_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS step_runs_issue_step_attempt_unique
  ON step_runs(issue_id, step, attempt) WHERE iteration_id IS NULL;
`);
  ensureStepOutputColumns(sqlite);
  ensureRepositoriesColumns(sqlite);
  ensureSettingsColumns(sqlite);

  return drizzle(sqlite, { schema });
}