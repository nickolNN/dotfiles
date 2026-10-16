import { z } from 'zod';

export const PIPELINE_STEPS = [
  'refine',
  'resolve',
  'review',
  'test',
  'pr',
] as const;

/** Частичная карта «шаг → id модели»: ключи строго из PIPELINE_STEPS. */
const stepModelsSchema = z.record(z.enum(PIPELINE_STEPS), z.string());

/** Уровень размышления pi: словарь CLI-флага `--thinking`. */
const thinkingLevelSchema = z.enum([
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
]);

/** Частичная карта «шаг → уровень размышления»; ключи из PIPELINE_STEPS. */
const stepThinkingLevelsSchema = z
  .record(z.enum(PIPELINE_STEPS), thinkingLevelSchema)
  .optional();

const repoLocationSchema = z
  .string()
  .refine((value) => z.string().url().safeParse(value).success, {
    message: 'repository_url должен быть URL',
  });

/**
 * Схема тела POST /issue-resolver/api/v1/issues.
 * Кросс-полевое правило: title обязателен, если не указан jira_issue_url.
 */
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
            // Приоритет у repo_id, но хотя бы одно из двух должно быть задано.
            if (!repository.repo_id && !repository.repository_url) {
              ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message: 'repo_id или repository_url обязателен',
                path: ['repo_id'],
              });
            }
            // base_branch необязателен только при repo_id (берётся defaultBranch).
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
    pipeline_steps: z.array(z.enum(PIPELINE_STEPS)).optional(),
    model: z.string().optional(),
    step_models: stepModelsSchema.optional(),
    bootstrapper_model: z.string().optional(),
    thinking_level: thinkingLevelSchema.optional(),
    step_thinking_levels: stepThinkingLevelsSchema,
  })
  .refine(
    (data) => Boolean(data.title?.trim()) || Boolean(data.jira_issue_url),
    {
      message: 'title обязателен, если не указан jira_issue_url',
      path: ['title'],
    },
  );

/** Схема тела POST /issue-resolver/api/v1/issues/:id/iterations. */
export const createIterationRequestSchema = z.object({
  context: z.string().min(1),
  review_context: z.string().optional(),
  is_review_need: z.boolean().optional(),
  steps: z.array(z.enum(PIPELINE_STEPS)).optional(),
  /** ID репозиториев, для которых включён create_mr (выбирается из секции pr-шага). */
  pr_repository_ids: z.array(z.string()).optional(),
  model: z.string().optional(),
  step_models: stepModelsSchema.optional(),
  bootstrapper_model: z.string().optional(),
  thinking_level: thinkingLevelSchema.optional(),
  step_thinking_levels: stepThinkingLevelsSchema,
});

/** Схема тела POST /issue-resolver/api/v1/repos/validate. */
export const validateReposRequestSchema = z.object({
  urls: z.array(z.string().url()).min(1, 'хотя бы один URL обязателен').max(20),
});

/** Схема тела POST /issue-resolver/api/v1/issues/validate-jira. */
export const validateJiraUrlSchema = z.object({
  url: z.string().url('url должен быть валидным URL'),
});

/** Схема тела POST/PUT /issue-resolver/api/v1/repositories. */
export const createRepoRequestSchema = z.object({
  url: z.string().trim().url('url должен быть валидным URL'),
});

/** Схема тела POST /issue-resolver/api/v1/tags. */
export const createTagRequestSchema = z.object({
  name: z.string().min(1, 'name обязателен'),
  description: z.string().optional(),
  repositories: z
    .array(
      z.object({
        repository_id: z.string().uuid(),
        bootstrap_enabled: z.boolean().optional().default(true),
      }),
    )
    .min(1, 'хотя бы один репозиторий обязателен'),
});

/** Схема тела PUT /issue-resolver/api/v1/tags/:id. */
export const updateTagRequestSchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().optional(),
  repositories: z
    .array(
      z.object({
        repository_id: z.string().uuid(),
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