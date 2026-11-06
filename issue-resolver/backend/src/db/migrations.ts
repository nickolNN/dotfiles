import type Database from 'better-sqlite3';
import { STEP_RUN_UNIQUE_INDEXES } from './ddl';

interface ColumnMigration {
  column: string;
  add: string;
  rename?: { from: string; sql: string };
}

function columnsOf(sqlite: Database.Database, table: string): Set<string> {
  return new Set(
    (sqlite.pragma(`table_info(${table})`) as { name: string }[]).map(
      (column) => column.name,
    ),
  );
}

function applyColumnMigrations(
  sqlite: Database.Database,
  table: string,
  migrations: readonly ColumnMigration[],
): void {
  const columns = columnsOf(sqlite, table);
  for (const migration of migrations) {
    if (columns.has(migration.column)) continue;
    if (migration.rename && columns.has(migration.rename.from)) {
      sqlite.exec(migration.rename.sql);
      continue;
    }
    sqlite.exec(migration.add);
  }
}

const ITERATION_COLUMNS: readonly ColumnMigration[] = [
  {
    column: 'review_context',
    add: "ALTER TABLE iterations ADD COLUMN review_context TEXT NOT NULL DEFAULT ''",
  },
  {
    column: 'is_review_need',
    add: 'ALTER TABLE iterations ADD COLUMN is_review_need INTEGER NOT NULL DEFAULT 0',
  },
  {
    column: 'step_models',
    add: 'ALTER TABLE iterations ADD COLUMN step_models TEXT',
  },
  {
    column: 'thinking_level',
    add: 'ALTER TABLE iterations ADD COLUMN thinking_level TEXT',
  },
  {
    column: 'step_thinking_levels',
    add: 'ALTER TABLE iterations ADD COLUMN step_thinking_levels TEXT',
  },
  {
    column: 'worker_count',
    add: 'ALTER TABLE iterations ADD COLUMN worker_count INTEGER',
  },
];

const ISSUE_COLUMNS: readonly ColumnMigration[] = [
  { column: 'source', add: 'ALTER TABLE issues ADD COLUMN source TEXT' },
  {
    column: 'description',
    add: "ALTER TABLE issues ADD COLUMN description TEXT NOT NULL DEFAULT ''",
  },
  {
    column: 'step_models',
    add: 'ALTER TABLE issues ADD COLUMN step_models TEXT',
  },
  {
    column: 'thinking_level',
    add: 'ALTER TABLE issues ADD COLUMN thinking_level TEXT',
  },
  {
    column: 'step_thinking_levels',
    add: 'ALTER TABLE issues ADD COLUMN step_thinking_levels TEXT',
  },
  {
    column: 'desired_result',
    add: "ALTER TABLE issues ADD COLUMN desired_result TEXT NOT NULL DEFAULT 'md'",
  },
  {
    column: 'dev_server_port',
    add: 'ALTER TABLE issues ADD COLUMN dev_server_port INTEGER',
  },
  {
    column: 'dev_server_pid',
    add: 'ALTER TABLE issues ADD COLUMN dev_server_pid INTEGER',
  },
  {
    column: 'tag_id',
    add: 'ALTER TABLE issues ADD COLUMN tag_id TEXT REFERENCES tags(id) ON DELETE SET NULL',
  },
  {
    column: 'devops_model',
    add: 'ALTER TABLE issues ADD COLUMN devops_model TEXT',
    rename: {
      from: 'bootstrapper_model',
      sql: 'ALTER TABLE issues RENAME COLUMN bootstrapper_model TO devops_model',
    },
  },
  {
    column: 'devops_thinking_level',
    add: 'ALTER TABLE issues ADD COLUMN devops_thinking_level TEXT',
    rename: {
      from: 'bootstrapper_thinking_level',
      sql: 'ALTER TABLE issues RENAME COLUMN bootstrapper_thinking_level TO devops_thinking_level',
    },
  },
  {
    column: 'worker_count',
    add: 'ALTER TABLE issues ADD COLUMN worker_count INTEGER',
  },
  {
    column: 'merge_requests',
    add: 'ALTER TABLE issues ADD COLUMN merge_requests TEXT',
  },
];

const ISSUE_REPOSITORY_COLUMNS: readonly ColumnMigration[] = [
  {
    column: 'create_mr',
    add: 'ALTER TABLE issue_repositories ADD COLUMN create_mr INTEGER NOT NULL DEFAULT 0',
  },
  {
    column: 'bootstrap_enabled',
    add: 'ALTER TABLE issue_repositories ADD COLUMN bootstrap_enabled INTEGER NOT NULL DEFAULT 1',
  },
];

const REPOSITORY_COLUMNS: readonly ColumnMigration[] = [
  {
    column: 'url',
    add: "ALTER TABLE repositories ADD COLUMN url TEXT NOT NULL DEFAULT ''",
  },
  { column: 'platform', add: 'ALTER TABLE repositories ADD COLUMN platform TEXT' },
  { column: 'full_name', add: 'ALTER TABLE repositories ADD COLUMN full_name TEXT' },
  {
    column: 'default_branch',
    add: 'ALTER TABLE repositories ADD COLUMN default_branch TEXT',
  },
  { column: 'clone_url', add: 'ALTER TABLE repositories ADD COLUMN clone_url TEXT' },
  { column: 'language', add: 'ALTER TABLE repositories ADD COLUMN language TEXT' },
  {
    column: 'description',
    add: 'ALTER TABLE repositories ADD COLUMN description TEXT',
  },
  { column: 'is_private', add: 'ALTER TABLE repositories ADD COLUMN is_private INTEGER' },
  {
    column: 'connection_status',
    add: "ALTER TABLE repositories ADD COLUMN connection_status TEXT NOT NULL DEFAULT 'unknown'",
  },
  {
    column: 'last_validated_at',
    add: 'ALTER TABLE repositories ADD COLUMN last_validated_at TEXT',
  },
  {
    column: 'write_access',
    add: 'ALTER TABLE repositories ADD COLUMN write_access INTEGER NOT NULL DEFAULT 0',
  },
  {
    column: 'run_instructions',
    add: 'ALTER TABLE repositories ADD COLUMN run_instructions TEXT',
  },
  {
    column: 'run_instructions_status',
    add: "ALTER TABLE repositories ADD COLUMN run_instructions_status TEXT NOT NULL DEFAULT 'unknown'",
  },
  {
    column: 'created_at',
    add: "ALTER TABLE repositories ADD COLUMN created_at TEXT NOT NULL DEFAULT ''",
  },
  {
    column: 'updated_at',
    add: "ALTER TABLE repositories ADD COLUMN updated_at TEXT NOT NULL DEFAULT ''",
  },
];

const STEP_RUN_COLUMNS: readonly ColumnMigration[] = [
  {
    column: 'events',
    add: "ALTER TABLE step_runs ADD COLUMN events TEXT NOT NULL DEFAULT '[]'",
  },
];

const STEP_OUTPUT_COLUMNS: readonly ColumnMigration[] = [
  {
    column: 'stdout',
    add: "ALTER TABLE step_outputs ADD COLUMN stdout TEXT NOT NULL DEFAULT ''",
  },
  {
    column: 'stderr',
    add: "ALTER TABLE step_outputs ADD COLUMN stderr TEXT NOT NULL DEFAULT ''",
  },
  {
    column: 'events',
    add: "ALTER TABLE step_outputs ADD COLUMN events TEXT NOT NULL DEFAULT '[]'",
  },
  { column: 'stats', add: 'ALTER TABLE step_outputs ADD COLUMN stats TEXT' },
];

const RETRO_RUN_COLUMNS: readonly ColumnMigration[] = [
  { column: 'model', add: 'ALTER TABLE retro_runs ADD COLUMN model TEXT' },
  { column: 'instructions', add: 'ALTER TABLE retro_runs ADD COLUMN instructions TEXT' },
  {
    column: 'session_limit',
    add: 'ALTER TABLE retro_runs ADD COLUMN session_limit INTEGER',
  },
  {
    column: 'thinking_level',
    add: 'ALTER TABLE retro_runs ADD COLUMN thinking_level TEXT',
  },
];

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
    sqlite.exec(STEP_RUN_UNIQUE_INDEXES);
    sqlite.exec('COMMIT');
  } catch (error) {
    sqlite.exec('ROLLBACK');
    throw error;
  } finally {
    sqlite.pragma('foreign_keys = ON');
  }
}

export function runMigrations(sqlite: Database.Database): void {
  applyColumnMigrations(sqlite, 'iterations', ITERATION_COLUMNS);
  applyColumnMigrations(sqlite, 'issues', ISSUE_COLUMNS);
  applyColumnMigrations(sqlite, 'issue_repositories', ISSUE_REPOSITORY_COLUMNS);
  applyColumnMigrations(sqlite, 'retro_runs', RETRO_RUN_COLUMNS);
  applyColumnMigrations(sqlite, 'step_runs', STEP_RUN_COLUMNS);
  ensureStepRunIssueColumn(sqlite);
  sqlite.exec('DROP INDEX IF EXISTS step_runs_iteration_id_step_attempt_unique');
  sqlite.exec(STEP_RUN_UNIQUE_INDEXES);
  applyColumnMigrations(sqlite, 'step_outputs', STEP_OUTPUT_COLUMNS);
  applyColumnMigrations(sqlite, 'repositories', REPOSITORY_COLUMNS);
}