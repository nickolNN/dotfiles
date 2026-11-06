export const DDL = `
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
  test_credentials TEXT,
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

export const STEP_RUN_UNIQUE_INDEXES = `
CREATE UNIQUE INDEX IF NOT EXISTS step_runs_iteration_step_attempt_unique
  ON step_runs(iteration_id, step, attempt) WHERE iteration_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS step_runs_issue_step_attempt_unique
  ON step_runs(issue_id, step, attempt) WHERE iteration_id IS NULL;
`;
