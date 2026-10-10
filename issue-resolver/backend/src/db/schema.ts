import type {
  DesiredResult,
  PipelineStep,
  StepModels,
  StepRunStatus,
  TaskStatus,
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
  container_name: text('container_name'),
  source: text('source'),
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