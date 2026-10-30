import { z } from 'zod';

export const PIPELINE_STEPS = [
  'refine',
  'resolve',
  'review',
  'test',
  'pr',
] as const;

const STEP_MODEL_KEYS = [...PIPELINE_STEPS, 'report'] as const;

const stepModelsSchema = z.record(z.enum(STEP_MODEL_KEYS), z.string());

const selectedStepsSchema = z
  .array(z.enum(PIPELINE_STEPS))
  .min(1, 'выберите хотя бы один шаг пайплайна');

const thinkingLevelSchema = z.enum([
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
]);

const STEP_THINKING_KEYS = [...PIPELINE_STEPS, 'report'] as const;

const stepThinkingLevelsSchema = z
  .record(z.enum(STEP_THINKING_KEYS), thinkingLevelSchema)
  .optional();

const repoLocationSchema = z
  .string()
  .refine((value) => z.string().url().safeParse(value).success, {
    message: 'repository_url должен быть URL',
  });

export const createIssueRequestSchema = z
  .object({
    title: z.string().optional(),
    jira_issue_url: z.string().url().optional(),
    repositories: z
      .array(
        z
          .object({
            repo_id: z.string().uuid().optional(),
            repository_url: repoLocationSchema.optional(),
            base_branch: z.string().min(1).optional(),
            create_mr: z.boolean().optional(),
            bootstrap_enabled: z.boolean().default(true),
          })
          .superRefine((repository, ctx) => {
            if (!repository.repo_id && !repository.repository_url) {
              ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message: 'repo_id или repository_url обязателен',
                path: ['repo_id'],
              });
            }
            if (!repository.repo_id && !repository.base_branch) {
              ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message: 'base_branch обязателен, если не указан repo_id',
                path: ['base_branch'],
              });
            }
          }),
      )
      .optional(),
    additional_context: z.string().optional(),
    desired_result: z.enum(['md', 'html']).optional(),
    review_context: z.string().optional(),
    is_review_need: z.boolean().optional(),
    pipeline_steps: selectedStepsSchema.optional(),
    tag_id: z.string().optional(),
    model: z.string().optional(),
    step_models: stepModelsSchema.optional(),
    devops_model: z.string().optional(),
    devops_thinking_level: thinkingLevelSchema.optional(),
    thinking_level: thinkingLevelSchema.optional(),
    step_thinking_levels: stepThinkingLevelsSchema,
    worker_count: z.number().int().min(0).optional(),
    run_immediately: z.boolean().optional(),
  })
  .refine(
    (data) => Boolean(data.title?.trim()) || Boolean(data.jira_issue_url),
    {
      message: 'title обязателен, если не указан jira_issue_url',
      path: ['title'],
    },
  );

export const createIterationRequestSchema = z.object({
  context: z.string().min(1),
  review_context: z.string().optional(),
  is_review_need: z.boolean().optional(),
  steps: selectedStepsSchema.optional(),
  pr_repository_ids: z.array(z.string()).optional(),
  model: z.string().optional(),
  step_models: stepModelsSchema.optional(),
  devops_model: z.string().optional(),
  devops_thinking_level: thinkingLevelSchema.optional(),
  thinking_level: thinkingLevelSchema.optional(),
  step_thinking_levels: stepThinkingLevelsSchema,
  worker_count: z.number().int().min(0).optional(),
});

export const validateReposRequestSchema = z.object({
  urls: z.array(z.string().url()).min(1, 'хотя бы один URL обязателен').max(20),
});

export const validateJiraUrlSchema = z.object({
  url: z.string().url('url должен быть валидным URL'),
});

export const createRepoRequestSchema = z.object({
  url: z.string().trim().url('url должен быть валидным URL'),
});

export const createTagRequestSchema = z.object({
  name: z.string().min(1, 'name обязателен'),
  description: z.string().optional(),
  run_instructions: z.string().nullable().optional(),
  repositories: z
    .array(
      z.object({
        repository_id: z.string().uuid(),
        bootstrap_enabled: z.boolean().optional().default(true),
      }),
    )
    .min(1, 'хотя бы один репозиторий обязателен'),
});

export const updateHostnameRequestSchema = z.object({
  hostname: z.string().max(100, 'hostname не длиннее 100 символов'),
});

export const startRetroRunRequestSchema = z.object({
  model: z.string().max(200).optional(),
  thinking_level: thinkingLevelSchema.optional(),
  session_limit: z.number().int().min(1).max(50).optional(),
  instructions: z
    .string()
    .max(4000, 'инструкции не длиннее 4000 символов')
    .optional(),
});

export const updateTagRequestSchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().optional(),
  run_instructions: z.string().nullable().optional(),
  repositories: z
    .array(
      z.object({
        repository_id: z.string().uuid(),
        bootstrap_enabled: z.boolean().optional().default(true),
      }),
    )
    .optional(),
});

export const updateIssueRequestSchema = z.object({
  title: z.string().optional(),
  jira_issue_url: z.string().url().optional().nullable(),
  description: z.string().optional(),
  desired_result: z.enum(['md', 'html']).optional(),
  pipeline_steps: selectedStepsSchema.optional(),
  step_models: stepModelsSchema.optional(),
  thinking_level: thinkingLevelSchema.optional().nullable(),
  step_thinking_levels: stepThinkingLevelsSchema,
  devops_model: z.string().optional().nullable(),
  devops_thinking_level: thinkingLevelSchema.optional().nullable(),
  worker_count: z.number().int().min(0).optional().nullable(),
  tag_id: z.string().optional().nullable(),
  repositories: z
    .array(
      z.object({
        repo_id: z.string().uuid().optional(),
        repository_url: repoLocationSchema.optional(),
        base_branch: z.string().min(1).optional(),
        create_mr: z.boolean().optional(),
        bootstrap_enabled: z.boolean().optional().default(true),
      }),
    )
    .optional(),
});

export function formatZodError(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.join('.');
      return path ? `${path}: ${issue.message}` : issue.message;
    })
    .join('; ');
}