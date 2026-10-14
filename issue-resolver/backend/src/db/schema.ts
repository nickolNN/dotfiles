import type {
  DesiredResult,
  PipelineStep,
  RepoConnectionStatus,
  RepoPlatform,
  RunInstructionsStatus,
  SessionEvent,
  StepModels,
  StepRunStatus,
  StepThinkingLevels,
  TaskStatus,
  ThinkingLevel,
} from '@issue-resolver/shared';
import { integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

export const issues = sqliteTable('issues', {
  id: text('id').primaryKey(),
  title: text('title').notNull(),
  description: text('description').notNull().default(''),
  desired_result: text('desired_result')
    .$type<DesiredResult>()
    .notNull()
    .default('md'),
  jira_issue_url: text('jira_issue_url'),
  pipeline_steps: text('pipeline_steps', { mode: 'json' })
    .$type<PipelineStep[]>()
    .notNull(),
  step_models: text('step_models', { mode: 'json' }).$type<StepModels>(),
  thinking_level: text('thinking_level').$type<ThinkingLevel>(),
  step_thinking_levels: text('step_thinking_levels', { mode: 'json' }).$type<
    StepThinkingLevels
  >(),
  container_name: text('container_name'),
  source: text('source'),
  /** Порт запущенного dev-сервера задачи (null — не запущен). */
  dev_server_port: integer('dev_server_port'),
  /** PID процесса dev-сервера задачи (null — не запущен). */
  dev_server_pid: integer('dev_server_pid'),
  status: text('status').$type<TaskStatus>().notNull(),
  created_at: text('created_at').notNull(),
  updated_at: text('updated_at').notNull(),
});

export const issueRepositories = sqliteTable(
  'issue_repositories',
  {
    id: text('id').primaryKey(),
    issue_id: text('issue_id').notNull(),
    repository_url: text('repository_url').notNull(),
    branch_name: text('branch_name').notNull(),
    create_mr: integer('create_mr', { mode: 'boolean' }).notNull().default(false),
    /** false — репозиторий клонируется, но install/анализ запуска пропускаются. */
    bootstrap_enabled: integer('bootstrap_enabled', { mode: 'boolean' })
      .notNull()
      .default(true),
    created_at: text('created_at').notNull(),
    updated_at: text('updated_at').notNull(),
  },
  (table) => ({
    uniqueRepository: uniqueIndex(
      'issue_repositories_issue_id_repository_url_branch_name_unique',
    ).on(table.issue_id, table.repository_url, table.branch_name),
  }),
);

export const iterations = sqliteTable(
  'iterations',
  {
    id: text('id').primaryKey(),
    issue_id: text('issue_id').notNull(),
    number: integer('number').notNull(),
    context: text('context').notNull().default(''),
    review_context: text('review_context').notNull().default(''),
    is_review_need: integer('is_review_need', { mode: 'boolean' })
      .notNull()
      .default(false),
    steps: text('steps', { mode: 'json' }).$type<PipelineStep[]>().notNull(),
    model: text('model'),
    step_models: text('step_models', { mode: 'json' }).$type<StepModels>(),
    thinking_level: text('thinking_level').$type<ThinkingLevel>(),
    step_thinking_levels: text('step_thinking_levels', { mode: 'json' }).$type<
      StepThinkingLevels
    >(),
    status: text('status').$type<TaskStatus>().notNull(),
    created_at: text('created_at').notNull(),
    updated_at: text('updated_at').notNull(),
  },
  (table) => ({
    uniqueNumber: uniqueIndex('iterations_issue_id_number_unique').on(
      table.issue_id,
      table.number,
    ),
  }),
);

/**
 * Сохранённые репозитории (отдельная сущность с CRUD). `connection_status` —
 * итог последней валидации; метаданные обнуляются при ошибке. Ветки не
 * хранятся (запрашиваются live).
 */
export const repositories = sqliteTable('repositories', {
  id: text('id').primaryKey(),
  url: text('url').notNull(),
  platform: text('platform').$type<RepoPlatform>(),
  full_name: text('full_name'),
  default_branch: text('default_branch'),
  clone_url: text('clone_url'),
  language: text('language'),
  description: text('description'),
  is_private: integer('is_private', { mode: 'boolean' }),
  connection_status: text('connection_status')
    .$type<RepoConnectionStatus>()
    .notNull()
    .default('unknown'),
  last_validated_at: text('last_validated_at'),
  /** Право токена на запись (последняя успешная валидация). */
  write_access: integer('write_access', { mode: 'boolean' })
    .notNull()
    .default(false),
  run_instructions: text('run_instructions'),
  run_instructions_status: text('run_instructions_status')
    .$type<RunInstructionsStatus>()
    .notNull()
    .default('unknown'),
  created_at: text('created_at').notNull(),
  updated_at: text('updated_at').notNull(),
});

/** Теги: именованные наборы сохранённых репозиториев. */
export const tags = sqliteTable('tags', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  description: text('description'),
  run_instructions: text('run_instructions'),
  run_instructions_status: text('run_instructions_status')
    .$type<RunInstructionsStatus>()
    .notNull()
    .default('unknown'),
  created_at: text('created_at').notNull(),
  updated_at: text('updated_at').notNull(),
});

/** Связь тега с сохранённым репозиторием (many-to-many). */
export const tagRepositories = sqliteTable(
  'tag_repositories',
  {
    id: text('id').primaryKey(),
    tag_id: text('tag_id')
      .notNull()
      .references(() => tags.id, { onDelete: 'cascade' }),
    repository_id: text('repository_id')
      .notNull()
      .references(() => repositories.id, { onDelete: 'cascade' }),
    bootstrap_enabled: integer('bootstrap_enabled', { mode: 'boolean' })
      .notNull()
      .default(true),
    created_at: text('created_at').notNull(),
  },
  (table) => ({
    uniqueTagRepo: uniqueIndex('tag_repositories_tag_id_repository_id_unique').on(
      table.tag_id,
      table.repository_id,
    ),
  }),
);

/** Загруженные файлы задачи/итерации; rel_path — от корня рабочей папки. */
export const issueFiles = sqliteTable('issue_files', {
  id: text('id').primaryKey(),
  issue_id: text('issue_id')
    .notNull()
    .references(() => issues.id, { onDelete: 'cascade' }),
  iteration_id: text('iteration_id').references(() => iterations.id, {
    onDelete: 'set null',
  }),
  name: text('name').notNull(),
  rel_path: text('rel_path').notNull(),
  size: integer('size').notNull(),
  mime_type: text('mime_type'),
  created_at: text('created_at').notNull(),
});

export const stepRuns = sqliteTable(
  'step_runs',
  {
    id: text('id').primaryKey(),
    iteration_id: text('iteration_id')
      .notNull()
      .references(() => iterations.id, { onDelete: 'cascade' }),
    step: text('step').$type<PipelineStep>().notNull(),
    attempt: integer('attempt').notNull(),
    status: text('status').$type<StepRunStatus>().notNull(),
    context: text('context').notNull(),
    feedback: text('feedback'),
    /**
     * Инкрементально дозалитые события сессии, пока шаг в работе и строки
     * `step_outputs` ещё нет (в первую очередь вопросы агента). На финише шага
     * полный набор событий уходит в `step_outputs.events` — это источник истины,
     * а здесь остаётся копия «живых» событий, переживающая перезагрузку страницы.
     */
    events: text('events', { mode: 'json' })
      .$type<SessionEvent[]>()
      .notNull()
      .default([]),
    created_at: text('created_at').notNull(),
    updated_at: text('updated_at').notNull(),
  },
  (table) => ({
    uniqueAttempt: uniqueIndex('step_runs_iteration_id_step_attempt_unique').on(
      table.iteration_id,
      table.step,
      table.attempt,
    ),
  }),
);

export const questionAnswers = sqliteTable(
  'question_answers',
  {
    id: text('id').primaryKey(),
    iteration_id: text('iteration_id')
      .notNull()
      .references(() => iterations.id, { onDelete: 'cascade' }),
    question_id: text('question_id').notNull(),
    // Строковый ответ (select/input/editor) либо флаги confirm-вопроса.
    value: text('value'),
    confirmed: integer('confirmed', { mode: 'boolean' }),
    cancelled: integer('cancelled', { mode: 'boolean' }),
    created_at: text('created_at').notNull(),
    updated_at: text('updated_at').notNull(),
  },
  (table) => ({
    uniqueQuestion: uniqueIndex(
      'question_answers_iteration_id_question_id_unique',
    ).on(table.iteration_id, table.question_id),
  }),
);

export const stepOutputs = sqliteTable('step_outputs', {
  id: text('id').primaryKey(),
  step_run_id: text('step_run_id')
    .notNull()
    .references(() => stepRuns.id, { onDelete: 'cascade' })
    .unique(),
  // Текстовая JSON-строка отчёта шага (см. shared StepOutput.report: string).
  report: text('report').notNull(),
  stdout: text('stdout').notNull().default(''),
  stderr: text('stderr').notNull().default(''),
  // JSON-массив структурированных событий сессии (shared SessionEvent[]).
  events: text('events').notNull().default('[]'),
  // JSON-статистика pi-сессии (shared SessionStats) или NULL.
  stats: text('stats'),
  screenshots_dir: text('screenshots_dir'),
  created_at: text('created_at').notNull(),
  updated_at: text('updated_at').notNull(),
});