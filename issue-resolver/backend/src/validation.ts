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
        z.object({
          repository_url: repoLocationSchema,
          base_branch: z.string().min(1),
          create_mr: z.boolean().optional(),
        }),
      )
      .optional(),
    additional_context: z.string().optional(),
    desired_result: z.enum(['md', 'html', 'pr']).optional(),
    review_context: z.string().optional(),
    is_review_need: z.boolean().optional(),
    pipeline_steps: z.array(z.enum(PIPELINE_STEPS)).optional(),
    model: z.string().optional(),
    step_models: stepModelsSchema.optional(),
  })
  .refine(
    (data) => Boolean(data.title?.trim()) || Boolean(data.jira_issue_url),
    {
      message: 'title обязателен, если не указан jira_issue_url',
      path: ['title'],
    },
  )
  .refine(
    (data) =>
      data.desired_result !== 'pr' || (data.repositories?.length ?? 0) > 0,
    {
      message: 'PR требует хотя бы один репозиторий',
      path: ['desired_result'],
    },
  );

/** Схема тела POST /issue-resolver/api/v1/issues/:id/iterations. */
export const createIterationRequestSchema = z.object({
  context: z.string().min(1),
  review_context: z.string().optional(),
  is_review_need: z.boolean().optional(),
  steps: z.array(z.enum(PIPELINE_STEPS)).optional(),
  model: z.string().optional(),
  step_models: stepModelsSchema.optional(),
});

export function formatZodError(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.join('.');
      return path ? `${path}: ${issue.message}` : issue.message;
    })
    .join('; ');
}