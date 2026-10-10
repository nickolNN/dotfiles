import type {
  DesiredResult,
  Iteration,
  PipelineStep,
  StepModels,
} from '@issue-resolver/shared';
import { extractIssueKeyFromUrl } from '@issue-resolver/shared';
import { and, eq } from 'drizzle-orm';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Db } from '../db/client';
import { listAttachableRelPaths } from '../db/issue-files.repo';
import { issues, iterations } from '../db/schema';
import {
  createStepOutput,
  createStepRun,
  listStepRunsWithLog,
  updateStepRun,
} from '../db/step-runs.repo';
import type { ContainerController } from '../docker/controller';
import type { GitService } from '../git/service';
import type { JiraClient } from '../jira/client';
import type { PiRunner } from '../pi/runner';
import type { StepSessionRegistry } from '../pi/session-registry';
import type { MrClient } from '../pr/mr';
import type { SseHub } from '../sse/hub';
import type { RunIterationResult, StepRunStore } from '../workflow/engine';
import { runIteration } from '../workflow/engine';
import { DEFAULT_WORKSPACE_ROOT, workspaceHostDirFor } from '../workspace/paths';

/** Порты, нужные сервису прогона итерации (совпадают с WorkflowDeps без store). */
export interface IterationRunDeps {
  container: ContainerController;
  git: GitService;
  pi: PiRunner;
  sse: SseHub;
  mr: MrClient;
  /** Реестр живых pi-сессий для steer/abort. */
  control: StepSessionRegistry;
  /** Локальный режим без Docker. */
  local?: boolean;
  /** Jira-клиент для текста задачи в refine/resolve; опционален (иначе null). */
  jira?: JiraClient;
  /** Корень host-папок задач; по умолчанию `/workspaces`. */
  workspaceRoot?: string;
}

export interface RunIssueIterationInput {
  issue: {
    id: string;
    title: string;
    pipelineSteps: PipelineStep[];
    /** Описание задачи (additional_context). */
    description?: string;
    /** Желаемый результат задачи: 'md' (report.md), 'html' (report.html) или 'pr'. */
    desiredResult?: DesiredResult;
    jiraIssueUrl?: string | null;
  };
  iteration: {
    id: string;
    issueId: string;
    number: number;
    context: string;
    steps: PipelineStep[];
    reviewContext?: string;
    isReviewNeed?: boolean;
  };
  repositories: {
    repository_url: string;
    base_branch: string;
    /** Создавать ли MR/PR для этого репозитория (per-repo). */
    create_mr?: boolean;
  }[];
  /** Общая модель-фолбек для всех шагов (обратная совместимость). */
  model?: string;
  /** Пер-шаговые модели: `step_models[step]` переопределяет `model`. */
  step_models?: StepModels;
  mrToken?: string;
}

/** Репозиторий step-runs как порт движка (сигнатуры уже совпадают). */
function dbStepRunStore(db: Db): StepRunStore {
  return {
    createStepRun: (input) => createStepRun(db, input),
    updateStepRun: (id, patch) => updateStepRun(db, id, patch),
    createStepOutput: (input) => createStepOutput(db, input),
  };
}

/**
 * Текст задачи из Jira для промпта: title + summary. Без URL/клиента, при
 * отсутствии ключа или ошибке — null (шаг не должен падать из-за Jira).
 */
async function fetchJiraText(
  deps: IterationRunDeps,
  jiraIssueUrl: string | null,
): Promise<string | null> {
  if (!jiraIssueUrl || !deps.jira) {
    return null;
  }
  const key = extractIssueKeyFromUrl(jiraIssueUrl);
  if (!key) {
    return null;
  }
  try {
    const issue = await deps.jira.fetchIssue(key);
    return [issue.title, issue.summary].filter(Boolean).join('\n') || null;
  } catch {
    return null;
  }
}

/** Максимум символов документа результата в промпте предыдущего итога. */
const MAX_PREVIOUS_OUTCOME_CHARS = 4000;

interface PreviousResolveSummary {
  status: string;
  summary: string;
}

/** status+summary из report resolve-шага; битый/пустой JSON деградирует до null. */
function parseResolveReport(raw: string | null): PreviousResolveSummary | null {
  if (!raw) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') {
      return null;
    }
    const report = parsed as { status?: unknown; summary?: unknown };
    return {
      status: typeof report.status === 'string' ? report.status : 'unknown',
      summary: typeof report.summary === 'string' ? report.summary : '',
    };
  } catch {
    return null;
  }
}

/**
 * Документ результата итерации из host-папки задачи: report.md (md) или
 * report.html (html). Для 'pr' документа нет; отсутствие/ошибка чтения — null.
 */
async function readResultDocument(
  workspaceRoot: string,
  issueId: string,
  desiredResult: DesiredResult | undefined,
): Promise<string | null> {
  if (desiredResult !== 'md' && desiredResult !== 'html') {
    return null;
  }
  const filename = desiredResult === 'md' ? 'report.md' : 'report.html';
  const path = join(workspaceHostDirFor(workspaceRoot, issueId), filename);
  try {
    return await readFile(path, 'utf8');
  } catch {
    return null;
  }
}

/** Пометка о документе результата, когда файла нет / desired_result = 'pr'. */
function documentPlaceholder(
  desiredResult: DesiredResult | undefined,
): string {
  if (desiredResult === 'md' || desiredResult === 'html') {
    return '(result document not found)';
  }
  return '(no result document for this desired result)';
}

/** Композиция блока previousOutcome для промпта (см. prompts.buildStepPrompt). */
function composePreviousOutcome(
  previousNumber: number,
  report: PreviousResolveSummary | null,
  document: string | null,
  desiredResult: DesiredResult | undefined,
): string {
  const status = report?.status ?? 'unknown';
  const summary = report?.summary.trim() || '(no summary)';
  const documentNote =
    document !== null
      ? document.slice(0, MAX_PREVIOUS_OUTCOME_CHARS)
      : documentPlaceholder(desiredResult);

  return [
    `Previous iteration #${previousNumber} (status ${status}): ${summary}.`,
    'Result document:',
    documentNote,
  ].join('\n');
}

/**
 * Итог предыдущей итерации для итерации `number > 1`: отчёт resolve-шага
 * (status+summary) плюс документ желаемого результата из воркспейса. Для
 * итерации №1 (или если предыдущей нет) — undefined.
 */
async function buildPreviousOutcome(
  db: Db,
  deps: IterationRunDeps,
  input: RunIssueIterationInput,
): Promise<string | undefined> {
  const currentNumber = input.iteration.number;
  if (currentNumber <= 1) {
    return undefined;
  }

  const previous = db
    .select()
    .from(iterations)
    .where(
      and(
        eq(iterations.issue_id, input.iteration.issueId),
        eq(iterations.number, currentNumber - 1),
      ),
    )
    .get();
  if (!previous) {
    return undefined;
  }

  const runs = await listStepRunsWithLog(db, previous.id);
  const resolveRun = runs.find((run) => run.step === 'resolve');
  const report = parseResolveReport(resolveRun?.report ?? null);
  const document = await readResultDocument(
    deps.workspaceRoot ?? DEFAULT_WORKSPACE_ROOT,
    input.issue.id,
    input.issue.desiredResult,
  );

  return composePreviousOutcome(
    currentNumber - 1,
    report,
    document,
    input.issue.desiredResult,
  );
}

/**
 * Гоняет движок конвейера и доводит результат до БД: статусы итерации/задачи
 * плюс событие iteration_status в SSE.
 */
export async function runIssueIteration(
  db: Db,
  deps: IterationRunDeps,
  input: RunIssueIterationInput,
): Promise<RunIterationResult> {
  const now = new Date().toISOString();

  const iteration: Iteration = {
    id: input.iteration.id,
    issue_id: input.iteration.issueId,
    number: input.iteration.number,
    context: input.iteration.context,
    review_context: input.iteration.reviewContext ?? '',
    is_review_need: input.iteration.isReviewNeed ?? false,
    steps: input.iteration.steps,
    status: 'running',
    created_at: now,
    updated_at: now,
  };

  // Итерация и задача переходят в running ещё до прогона конвейера.
  db.update(iterations)
    .set({ status: 'running', updated_at: now })
    .where(eq(iterations.id, input.iteration.id))
    .run();
  db.update(issues)
    .set({ status: 'running', updated_at: now })
    .where(eq(issues.id, input.issue.id))
    .run();
  deps.sse.publish({
    type: 'iteration_status',
    issueId: input.issue.id,
    iterationId: input.iteration.id,
    data: JSON.stringify({
      iterationId: input.iteration.id,
      status: 'running',
      needsInput: false,
    }),
    ts: now,
  });

  const jiraText = await fetchJiraText(deps, input.issue.jiraIssueUrl ?? null);
  const previousOutcome = await buildPreviousOutcome(db, deps, input);
  const attachmentPaths = await listAttachableRelPaths(
    db,
    input.issue.id,
    input.iteration.id,
  );

  let result: RunIterationResult;
  try {
    result = await runIteration(
      {
        container: deps.container,
        git: deps.git,
        pi: deps.pi,
        sse: deps.sse,
        store: dbStepRunStore(db),
        mr: deps.mr,
        control: deps.control,
        local: deps.local,
        workspaceRoot: deps.workspaceRoot,
      },
      {
        issue: input.issue,
        iteration,
        repositories: input.repositories,
        model: input.model,
        step_models: input.step_models,
        mrToken: input.mrToken,
        description: input.issue.description ?? '',
        jiraText,
        previousOutcome,
        attachmentPaths,
      },
    );
  } catch (error) {
    // Инфраструктурный сбой (например, git clone упал по таймауту) не должен
    // оставлять итерацию/задачу навечно в `running` — фиксируем failed.
    console.error('runIteration failed', error);
    const failedAt = new Date().toISOString();
    db.update(iterations)
      .set({ status: 'failed', updated_at: failedAt })
      .where(eq(iterations.id, input.iteration.id))
      .run();
    db.update(issues)
      .set({ status: 'failed', updated_at: failedAt })
      .where(eq(issues.id, input.issue.id))
      .run();
    deps.sse.publish({
      type: 'iteration_status',
      issueId: input.issue.id,
      iterationId: input.iteration.id,
      data: JSON.stringify({
        iterationId: input.iteration.id,
        status: 'failed',
        needsInput: false,
      }),
      ts: failedAt,
    });
    return { iterationStatus: 'failed', needsInput: false };
  }

  const finishedAt = new Date().toISOString();
  db.update(iterations)
    .set({ status: result.iterationStatus, updated_at: finishedAt })
    .where(eq(iterations.id, input.iteration.id))
    .run();
  db.update(issues)
    .set({ status: result.iterationStatus, updated_at: finishedAt })
    .where(eq(issues.id, input.issue.id))
    .run();

  deps.sse.publish({
    type: 'iteration_status',
    issueId: input.issue.id,
    iterationId: input.iteration.id,
    data: JSON.stringify({
      iterationId: input.iteration.id,
      status: result.iterationStatus,
      needsInput: result.needsInput,
    }),
    ts: finishedAt,
  });

  return result;
}