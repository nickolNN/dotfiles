import { randomUUID } from 'node:crypto';
import type { Iteration, PipelineStep, StepModels, StepThinkingLevels, ThinkingLevel } from '@issue-resolver/shared';
import { DesiredResult } from '@issue-resolver/shared';
import { TaskStatus } from '@issue-resolver/shared';
import { and, eq, max } from 'drizzle-orm';
import type { Db } from '../db/client';
import type { IssueRepositorySelection } from '../db/issue-repositories.repo';
import { issues, iterations } from '../db/schema';
import {
  prepareIssueWorkspace,
  type PrepareIssueWorkspaceDeps,
} from './prepare-issue-workspace';
import { runIssueIteration } from './run-issue-iteration';
import type { IterationRunDeps, RunIssueIterationInput } from './service-contracts';
import type { DevopsModelSettings } from './run-deps';
import { nowIso } from '../db/rows';

export type IterationModels = Pick<
  DevopsModelSettings,
  'devopsModel' | 'devopsThinkingLevel'
>;

export interface IterationRunModels {
  model?: string;
  step_models?: StepModels;
  thinking_level?: ThinkingLevel;
  step_thinking_levels?: StepThinkingLevels;
}

export interface StartIterationInput {
  issue: {
    id: string;
    title: string;
    pipelineSteps: PipelineStep[];
    description: string;
    desiredResult: DesiredResult;
    jiraIssueUrl: string | null;
  };
  iteration: RunIssueIterationInput['iteration'];
  models: IterationRunModels;
  repositories: IssueRepositorySelection[];
  devops: IterationModels;
  beforePrepare?: () => void;
  markIssueFailedOnPrepareError?: boolean;
}

export interface NextIterationFields {
  issueId: string;
  context: string;
  reviewContext: string;
  isReviewNeed: boolean;
  steps: PipelineStep[];
  model?: string | null;
  step_models?: StepModels;
  thinking_level?: ThinkingLevel | null;
  step_thinking_levels?: StepThinkingLevels;
  worker_count?: number;
}

export interface CreateNextIterationInput {
  issue: StartIterationInput['issue'];
  iteration: NextIterationFields;
  repositories: IssueRepositorySelection[];
  devops: IterationModels;
  afterCreate?: (iteration: Iteration) => Promise<void>;
  beforePrepare?: () => void;
  markIssueFailedOnPrepareError?: boolean;
}

export type CreateNextIterationResult =
  | { ok: true; iteration: Iteration }
  | { ok: false; error: string };

interface IssueStartFields {
  id: string;
  title: string;
  pipeline_steps: PipelineStep[];
  description?: string | null;
  desired_result?: DesiredResult;
  jira_issue_url: string | null;
}

export function startIterationIssue(
  issue: IssueStartFields,
  pipelineSteps: PipelineStep[] = issue.pipeline_steps,
): StartIterationInput['issue'] {
  return {
    id: issue.id,
    title: issue.title,
    pipelineSteps,
    description: issue.description ?? '',
    desiredResult: issue.desired_result ?? DesiredResult.md,
    jiraIssueUrl: issue.jira_issue_url,
  };
}

export async function createNextIteration(
  db: Db,
  deps: IterationRunDeps,
  input: CreateNextIterationInput,
): Promise<CreateNextIterationResult> {
  const fields = input.iteration;
  const lastNumber =
    db
      .select({ value: max(iterations.number) })
      .from(iterations)
      .where(eq(iterations.issue_id, fields.issueId))
      .get()?.value ?? 0;

  const now = nowIso();
  const iteration: Iteration = {
    id: randomUUID(),
    issue_id: fields.issueId,
    number: lastNumber + 1,
    context: fields.context,
    review_context: fields.reviewContext,
    is_review_need: fields.isReviewNeed,
    steps: fields.steps,
    model: fields.model ?? null,
    step_models: fields.step_models,
    thinking_level: fields.thinking_level ?? null,
    step_thinking_levels: fields.step_thinking_levels,
    worker_count: fields.worker_count,
    status: TaskStatus.pending,
    created_at: now,
    updated_at: now,
  };

  const hasRunning = db
    .select({ id: iterations.id })
    .from(iterations)
    .where(
      and(
        eq(iterations.issue_id, fields.issueId),
        eq(iterations.status, TaskStatus.running),
      ),
    )
    .get();
  const hasPlanned = db
    .select({ id: iterations.id })
    .from(iterations)
    .where(
      and(
        eq(iterations.issue_id, fields.issueId),
        eq(iterations.status, TaskStatus.pending),
      ),
    )
    .get();
  if (hasPlanned) {
    return {
      ok: false,
      error: 'A pending iteration already exists — wait for it to start',
    };
  }
  const hasDraft = db
    .select({ id: iterations.id })
    .from(iterations)
    .where(
      and(
        eq(iterations.issue_id, fields.issueId),
        eq(iterations.status, TaskStatus.draft),
      ),
    )
    .get();
  if (hasDraft) {
    return {
      ok: false,
      error: 'A draft iteration already exists — edit or delete it first',
    };
  }

  if (hasRunning) {
    const draft: Iteration = { ...iteration, status: TaskStatus.draft };
    db.insert(iterations).values(draft).run();
    if (input.afterCreate) await input.afterCreate(draft);
    return { ok: true, iteration: draft };
  }

  db.insert(iterations).values(iteration).run();
  if (input.afterCreate) await input.afterCreate(iteration);

  startIteration(db, deps, {
    issue: input.issue,
    iteration: {
      id: iteration.id,
      issueId: fields.issueId,
      number: iteration.number,
      context: iteration.context,
      steps: iteration.steps,
      reviewContext: iteration.review_context,
      isReviewNeed: iteration.is_review_need,
      worker_count: iteration.worker_count,
    },
    models: {
      model: iteration.model ?? undefined,
      step_models: iteration.step_models,
      thinking_level: iteration.thinking_level ?? undefined,
      step_thinking_levels: iteration.step_thinking_levels,
    },
    repositories: input.repositories,
    devops: input.devops,
    ...(input.beforePrepare ? { beforePrepare: input.beforePrepare } : {}),
    ...(input.markIssueFailedOnPrepareError !== undefined
      ? { markIssueFailedOnPrepareError: input.markIssueFailedOnPrepareError }
      : {}),
  });

  return { ok: true, iteration };
}

export function iterationPrepareDeps(
  deps: IterationRunDeps,
  models: IterationModels,
): PrepareIssueWorkspaceDeps {
  return {
    container: deps.container,
    git: deps.git,
    sse: deps.sse,
    local: deps.local,
    ...(deps.devopsFactory ? { devopsFactory: deps.devopsFactory } : {}),
    devopsModel: models.devopsModel,
    devopsThinkingLevel: models.devopsThinkingLevel,
    devopsTimeoutMs: deps.devopsTimeoutMs,
    workspaceRoot: deps.workspaceRoot,
  };
}

export function startIteration(
  db: Db,
  deps: IterationRunDeps,
  input: StartIterationInput,
): void {
  const { issue, iteration } = input;
  void (async () => {
    try {
      input.beforePrepare?.();
      const repoWorkspaces = await prepareIssueWorkspace(
        db,
        iterationPrepareDeps(deps, input.devops),
        {
          issueId: issue.id,
          iterationId: iteration.id,
          repositories: input.repositories,
        },
      );
      void runIssueIteration(db, deps, {
        issue: {
          id: issue.id,
          title: issue.title,
          pipelineSteps: issue.pipelineSteps,
          description: issue.description,
          desiredResult: issue.desiredResult,
          jiraIssueUrl: issue.jiraIssueUrl,
        },
        iteration,
        repositories: input.repositories,
        repoWorkspaces,
        model: input.models.model,
        step_models: input.models.step_models,
        thinking_level: input.models.thinking_level,
        step_thinking_levels: input.models.step_thinking_levels,
      }).catch((error) => console.error('run failed', error));
    } catch (error) {
      console.error('preparation failed', { issueId: issue.id, error });
      if (!input.markIssueFailedOnPrepareError) return;
      try {
        db.update(issues)
          .set({ status: TaskStatus.failed, updated_at: nowIso() })
          .where(eq(issues.id, issue.id))
          .run();
        console.error('issue marked failed after prepare error', issue.id);
      } catch (updateError) {
        console.error('could not mark issue failed after prepare error', {
          issueId: issue.id,
          error: updateError,
        });
      }
    }
  })();
}