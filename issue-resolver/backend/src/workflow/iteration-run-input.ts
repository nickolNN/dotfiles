import { eq } from 'drizzle-orm';
import type { Iteration } from '@issue-resolver/shared';
import { TaskStatus } from '@issue-resolver/shared';
import type { Db } from '../db/client';
import { getRepositoryTestCredentials } from '../db/repositories.repo';
import { listAttachableRelPaths } from '../db/issue-files.repo';
import { issues } from '../db/schema';
import { DEFAULT_WORKSPACE_ROOT } from '../workspace/paths';
import { dbStepRunStore } from './db-adapters';
import type {
  IterationTerminalOutcome,
  RunIterationInput,
  WorkflowDeps,
} from './iteration/contracts';
import { buildPreviousOutcome, fetchJiraText } from './iteration-inputs';
import { publishIterationStatus, setIssueStatus } from './iteration-status';
import type { IterationRunDeps, RunIssueIterationInput } from './service-contracts';
import { nowIso } from '../db/rows';

export function buildIterationRow(input: RunIssueIterationInput): Iteration {
  const now = nowIso();
  return {
    id: input.iteration.id,
    issue_id: input.iteration.issueId,
    number: input.iteration.number,
    context: input.iteration.context,
    review_context: input.iteration.reviewContext ?? '',
    is_review_need: input.iteration.isReviewNeed ?? false,
    steps: input.iteration.steps,
    worker_count: input.iteration.worker_count,
    status: TaskStatus.running,
    created_at: now,
    updated_at: now,
  };
}

export function buildWorkflowDeps(
  db: Db,
  deps: IterationRunDeps,
  input: RunIssueIterationInput,
  onIterationTerminal: (outcome: IterationTerminalOutcome) => void,
): WorkflowDeps {
  return {
    container: deps.container,
    git: deps.git,
    pi: deps.pi,
    sse: deps.sse,
    store: dbStepRunStore(db),
    mr: deps.mr,
    control: deps.control,
    local: deps.local,
    workspaceRoot: deps.workspaceRoot,
    onQuestionStatus: (status) => {
      const at = nowIso();
      setIssueStatus(db, input.issue.id, status, at);
      publishIterationStatus(deps, input.issue.id, input.iteration.id, status, {
        needsInput: status === TaskStatus.question,
        ts: at,
      });
    },
    onIterationTerminal,
  };
}

export async function buildRunIterationInput(
  db: Db,
  deps: IterationRunDeps,
  input: RunIssueIterationInput,
  iteration: Iteration,
): Promise<RunIterationInput> {
  const workspaceRoot = deps.workspaceRoot ?? DEFAULT_WORKSPACE_ROOT;
  const jiraText = await fetchJiraText(
    workspaceRoot,
    input.issue.id,
    input.issue.jiraIssueUrl ?? null,
  );
  const previousOutcome = await buildPreviousOutcome(db, deps, input);
  const attachmentPaths = await listAttachableRelPaths(
    db,
    input.issue.id,
    input.iteration.id,
  );
  const devServerPort =
    db
      .select({ port: issues.dev_server_port })
      .from(issues)
      .where(eq(issues.id, input.issue.id))
      .get()?.port ?? null;
  const devRepo = input.repositories.find(
    (repo) => repo.bootstrap_enabled !== false,
  );
  const credentials = devRepo
    ? getRepositoryTestCredentials(db, devRepo.repository_url)
    : null;

  return {
    issue: input.issue,
    iteration,
    repositories: input.repositories,
    preparedRepoWorkspaces: input.repoWorkspaces,
    model: input.model,
    step_models: input.step_models,
    thinking_level: input.thinking_level,
    step_thinking_levels: input.step_thinking_levels,
    mrToken: input.mrToken,
    description: input.issue.description ?? '',
    jiraText,
    previousOutcome,
    attachmentPaths,
    devServerPort,
    credentials,
  };
}