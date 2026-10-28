import type {
  DesiredResult,
  Iteration,
  PipelineStep,
  SSEEvent,
  SessionEvent,
  SessionStats,
  StepModels,
  StepRunStatus,
  StepRunWithLog,
  StepThinkingLevels,
  TaskStatus,
  ThinkingLevel,
} from '@issue-resolver/shared';
import {
  SESSION_HEARTBEAT_MS,
  SESSION_STALE_MS,
  SessionAddress,
  extractIssueKeyFromUrl,
  extractRepoNameFromUrl,
  stepRunStatusFromResult,
} from '@issue-resolver/shared';
import { and, asc, desc, eq } from 'drizzle-orm';
import { spawn } from 'node:child_process';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { copyFile, mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Db } from '../db/client';
import { startAgentSession } from '../pi/agent-session';
import {
  resolveAgentStallTimeoutMs,
  withAgentStallGuard,
} from './timeout';
import { issueSessionDir, sessionDisplayName } from '../pi/session-paths';
import { soloRunExcludeTools } from '../pi/tool-policy';
import { stallRecoveries } from '../pi/stall-recovery';
import { STEP_SYSTEM_APPEND } from './prompts';
import { renderReportArtifacts } from './report-render';
import { capSessionEvents } from '../pi/session-events-cap';
import { allocateDevPort, releaseIssueDevPorts } from '../port-allocator';
import { listAttachableRelPaths } from '../db/issue-files.repo';
import {
  getRepositoryByUrl,
  updateRepositoryRunInstructions,
} from '../db/repositories.repo';
import { getTag, updateTagRunInstructions } from '../db/tags.repo';
import { issueRepositories, issues, iterations } from '../db/schema';
import {
  appendStepRunEvent,
  createStepOutput,
  createStepRun,
  listStepRunsByIssue,
  listStepRunsWithLog,
  updateStepRun,
} from '../db/step-runs.repo';
import type { ContainerController } from '../docker/controller';
import type { GitPrepareResult, GitService } from '../git/service';
import type { PiRunner } from '../pi/runner';
import {
  runTarget,
  type StepSessionRegistry,
} from '../pi/session-registry';
import type { MrClient } from '../pr/mr';
import type { SseHub } from '../sse/hub';
import type {
  DevOpsFactory,
  RunInstructionsPort,
  RunIterationResult,
  StepRunStore,
} from '../workflow/engine';
import { prepareWorkspace, runIteration } from '../workflow/engine';
import type { IterationTerminalOutcome } from '../workflow/engine';
import type { WorkspaceProgress } from '../workflow/engine';
import { buildStepPrompt } from '../workflow/prompts';
import {
  ALL_RESULT_ARTIFACTS,
  DEFAULT_WORKSPACE_ROOT,
  iterationResultDirFor,
  workspaceContainerDirFor,
  workspaceHostDirFor,
} from '../workspace/paths';

const DEV_SERVER_SCRIPT = 'DEV_SERVER.sh';

const INFRA_FILES = ['RUN_INSTRUCTIONS.md', DEV_SERVER_SCRIPT];

const ENGINE_FILES = [
  '.issue-step-result.json',
  '.issue-worker-result-*.json',
  '.issue-stage-*.json',
];

const EXCLUDED_FROM_MR = [...INFRA_FILES, ...ENGINE_FILES];

function excludeInfraFiles(workspaceDir: string, repoName: string): void {
  const excludePath = join(workspaceDir, repoName, '.git', 'info', 'exclude');
  try {
    const current = existsSync(excludePath)
      ? readFileSync(excludePath, 'utf8')
      : '';
    const known = new Set(current.split('\n'));
    const missing = EXCLUDED_FROM_MR.filter((name) => !known.has(`/${name}`));
    if (missing.length === 0) return;
    mkdirSync(dirname(excludePath), { recursive: true });
    appendFileSync(
      excludePath,
      `${missing.map((name) => `/${name}`).join('\n')}\n`,
    );
  } catch (error) {
    console.error('failed to exclude infra files from git', error);
  }
}

function startRepoDevServer(
  workspaceDir: string,
  repoName: string,
): number | null {
  const repoDir = join(workspaceDir, repoName);
  const scriptPath = join(repoDir, DEV_SERVER_SCRIPT);
  if (!existsSync(scriptPath)) return null;
  try {
    const child = spawn(scriptPath, [], {
      cwd: repoDir,
      detached: true,
      stdio: 'ignore',
    });
    child.on('error', (error) => {
      console.error('failed to start DEV_SERVER.sh', error);
    });
    child.unref();
    return child.pid ?? null;
  } catch (error) {
    console.error('failed to spawn DEV_SERVER.sh', error);
    return null;
  }
}

async function stopDevServerProcess(pid: number): Promise<void> {
  const tryKill = (target: number, sig: NodeJS.Signals): boolean => {
    try {
      process.kill(target, sig);
      return true;
    } catch {
      return false;
    }
  };
  const signal = (sig: NodeJS.Signals): void => {
    if (tryKill(-pid, sig)) return;
    tryKill(pid, sig);
  };

  signal('SIGTERM');
  await new Promise((resolve) => setTimeout(resolve, 500));
  signal('SIGKILL');
}

export interface IterationRunDeps {
  container: ContainerController;
  git: GitService;
  pi: PiRunner;
  sse: SseHub;
  mr: MrClient;
  control: StepSessionRegistry;
  local?: boolean;
  devopsModel?: string;
  devopsThinkingLevel?: ThinkingLevel;
  devopsTimeoutMs?: number;
  devopsFactory?: DevOpsFactory;
  workspaceRoot?: string;
  mrToken?: string;
}

export interface RunIssueIterationInput {
  issue: {
    id: string;
    title: string;
    pipelineSteps: PipelineStep[];
    description?: string;
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
    worker_count?: number;
  };
  repositories: {
    repository_url: string;
    base_branch: string;
    create_mr?: boolean;
    bootstrap_enabled?: boolean;
  }[];
  repoWorkspaces: GitPrepareResult['repoWorkspaces'];
  model?: string;
  step_models?: StepModels;
  thinking_level?: ThinkingLevel;
  step_thinking_levels?: StepThinkingLevels;
  mrToken?: string;
}

function dbStepRunStore(db: Db): StepRunStore {
  return {
    createStepRun: (input) => createStepRun(db, input),
    updateStepRun: (id, patch) => updateStepRun(db, id, patch),
    appendStepRunEvent: (id, event) => appendStepRunEvent(db, id, event),
    createStepOutput: (input) => createStepOutput(db, input),
  };
}

function dbRunInstructionsStore(db: Db): RunInstructionsPort {
  return {
    getStatus: (url) => getRepositoryByUrl(db, url)?.runInstructionsStatus,
    getInstructions: (url) => getRepositoryByUrl(db, url)?.runInstructions ?? null,
    saveGenerated: (url, instructions) =>
      updateRepositoryRunInstructions(db, url, {
        instructions,
        status: 'generated',
      }),
    saveFailed: (url) =>
      updateRepositoryRunInstructions(db, url, {
        instructions: null,
        status: 'failed',
      }),
  };
}

async function fetchJiraText(
  workspaceRoot: string,
  issueId: string,
  jiraIssueUrl: string | null,
): Promise<string | null> {
  if (!jiraIssueUrl) return null;
  const key = extractIssueKeyFromUrl(jiraIssueUrl);
  if (!key) return null;
  const wsDir = workspaceHostDirFor(workspaceRoot, issueId);
  const mdPath = join(wsDir, 'jira', `${key}.md`);
  try {
    return await readFile(mdPath, 'utf8');
  } catch {
    return null;
  }
}

const MAX_PREVIOUS_OUTCOME_CHARS = 4000;

interface PreviousResolveSummary {
  status: string;
  summary: string;
}

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

async function readResultDocument(
  workspaceRoot: string,
  issueId: string,
  _desiredResult?: DesiredResult,
): Promise<string | null> {
  const path = join(workspaceHostDirFor(workspaceRoot, issueId), 'report.md');
  try {
    return await readFile(path, 'utf8');
  } catch {
    return null;
  }
}

async function snapshotIterationResult(
  workspaceRoot: string,
  issueId: string,
  iterationId: string,
): Promise<void> {
  const targetDir = iterationResultDirFor(workspaceRoot, issueId, iterationId);
  for (const artifact of ALL_RESULT_ARTIFACTS) {
    const source = join(
      workspaceHostDirFor(workspaceRoot, issueId),
      artifact.filename,
    );
    try {
      await mkdir(targetDir, { recursive: true });
      await copyFile(source, join(targetDir, artifact.filename));
    } catch (error) {
      console.warn('attachment copy failed', {
        file: artifact.filename,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

export async function refreshLatestResultSnapshot(
  db: Db,
  workspaceRoot: string | undefined,
  issueId: string,
): Promise<void> {
  const latest = db
    .select({ id: iterations.id })
    .from(iterations)
    .where(
      and(
        eq(iterations.issue_id, issueId),
        eq(iterations.status, 'completed'),
      ),
    )
    .orderBy(desc(iterations.number))
    .get();
  if (!latest) return;
  await snapshotIterationResult(
    workspaceRoot ?? DEFAULT_WORKSPACE_ROOT,
    issueId,
    latest.id,
  );
}

function stepOutcome(run: StepRunWithLog): 'ok' | 'fail' | 'timeout' {
  if (run.status === 'success') {
    return 'ok';
  }
  const haystack = `${run.stderr}\n${run.report ?? ''}`.toLowerCase();
  if (haystack.includes('timeout') || haystack.includes('timed out')) {
    return 'timeout';
  }
  return 'fail';
}

export function renderIterationReport(params: {
  title: string;
  number: number;
  status: string;
  startedAt: string;
  finishedAt: string;
  runs: StepRunWithLog[];
}): string {
  const { title, number, status, startedAt, finishedAt, runs } = params;
  const lines: string[] = [
    `# Задача: ${title}`,
    `# Итерация #${number}`,
    '',
    `**Статус:** ${status}`,
    `**Начало:** ${startedAt}`,
    `**Конец:** ${finishedAt}`,
    '',
    '## Шаги',
    '',
  ];

  for (const run of runs) {
    if (run.report === null) {
      continue;
    }
    lines.push(
      `### ${run.step} (попытка ${run.attempt})`,
      '',
      `**Статус:** ${stepOutcome(run)}`,
      '',
      run.report,
      '',
      '---',
      '',
    );
  }

  return lines.join('\n');
}

async function writeIterationReport(
  db: Db,
  deps: IterationRunDeps,
  input: RunIssueIterationInput,
  status: TaskStatus,
): Promise<void> {
  try {
    const workspaceRoot = deps.workspaceRoot ?? DEFAULT_WORKSPACE_ROOT;
    const workspaceHostDir = workspaceHostDirFor(workspaceRoot, input.issue.id);
    const runs = await listStepRunsWithLog(db, input.iteration.id);
    const row = db
      .select()
      .from(iterations)
      .where(eq(iterations.id, input.iteration.id))
      .get();
    const content = renderIterationReport({
      title: input.issue.title,
      number: input.iteration.number,
      status,
      startedAt: row?.created_at ?? '',
      finishedAt: row?.updated_at ?? new Date().toISOString(),
      runs,
    });
    mkdirSync(workspaceHostDir, { recursive: true });
    writeFileSync(
      join(workspaceHostDir, `report-${input.iteration.number}.md`),
      content,
      'utf8',
    );
  } catch (error) {
    console.error('failed to write iteration report', error);
  }
}

function documentPlaceholder(): string {
  return '(result document not found)';
}

function composePreviousOutcome(
  previousNumber: number,
  report: PreviousResolveSummary | null,
  document: string | null,
): string {
  const status = report?.status ?? 'unknown';
  const summary = report?.summary.trim() || '(no summary)';
  const documentNote =
    document !== null
      ? document.slice(0, MAX_PREVIOUS_OUTCOME_CHARS)
      : documentPlaceholder();

  return [
    `Previous iteration #${previousNumber} (status ${status}): ${summary}.`,
    'Result document:',
    documentNote,
  ].join('\n');
}

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
  );

  return composePreviousOutcome(
    currentNumber - 1,
    report,
    document,
  );
}

export interface PrepareIssueWorkspaceDeps {
  container: ContainerController;
  git: GitService;
  sse: SseHub;
  local?: boolean;
  devopsFactory?: DevOpsFactory;
  devopsModel?: string;
  devopsThinkingLevel?: ThinkingLevel;
  devopsTimeoutMs?: number;
  workspaceRoot?: string;
  control?: StepSessionRegistry;
}

export async function prepareIssueWorkspace(
  db: Db,
  deps: PrepareIssueWorkspaceDeps,
  input: {
    issueId: string;
    iterationId: string;
    repositories: Array<{
      repository_url: string;
      base_branch: string;
      bootstrap_enabled?: boolean;
    }>;
  },
): Promise<GitPrepareResult['repoWorkspaces']> {
  const repos = input.repositories;
  const workspaceDir = workspaceHostDirFor(
    deps.workspaceRoot ?? DEFAULT_WORKSPACE_ROOT,
    input.issueId,
  );
  const clonesReady =
    repos.length > 0 &&
    repos.every((repo) =>
      existsSync(
        join(workspaceDir, extractRepoNameFromUrl(repo.repository_url), '.git'),
      ),
    );
  const needPrepare = repos.length > 0 && !clonesReady;

  if (!needPrepare) {
    const dir = deps.local
      ? workspaceHostDirFor(
          deps.workspaceRoot ?? DEFAULT_WORKSPACE_ROOT,
          input.issueId,
        )
      : workspaceContainerDirFor(input.issueId);
    repos.forEach((repo) =>
      excludeInfraFiles(workspaceDir, extractRepoNameFromUrl(repo.repository_url)),
    );
    return repos.map((repo) => ({
      repoUrl: repo.repository_url,
      path: join(dir, extractRepoNameFromUrl(repo.repository_url)),
      branch: repo.base_branch,
    }));
  }

  const devRepo = deps.devopsFactory
    ? repos.find((repo) => repo.bootstrap_enabled !== false)
    : undefined;
  const devServerPort = devRepo
    ? await allocateDevPort(input.issueId)
    : undefined;

  const issueRow = db
    .select({ tag_id: issues.tag_id })
    .from(issues)
    .where(eq(issues.id, input.issueId))
    .get();
  const tag = issueRow?.tag_id ? getTag(db, issueRow.tag_id) : undefined;
  const tagInstructions: string | null = tag?.run_instructions ?? null;

  const reposNames =
    tag
      ? tag.repositories
          .map((tr) => extractRepoNameFromUrl(tr.repository.url))
          .join(', ')
      : input.repositories
          .map((r) => extractRepoNameFromUrl(r.repository_url))
          .join(', ');

  const reposRequireDevServer =
    tag
      ? tag.repositories
          .filter((tr) => tr.bootstrap_enabled)
          .map((tr) => extractRepoNameFromUrl(tr.repository.url))
          .join(', ')
      : input.repositories
          .filter((r) => r.bootstrap_enabled !== false)
          .map((r) => extractRepoNameFromUrl(r.repository_url))
          .join(', ');

  const reposInstructions = tag
    ? tag.repositories
        .map((tr) => {
          const name = extractRepoNameFromUrl(tr.repository.url);
          const instr = tr.repository.runInstructions?.trim();
          return `### ${name}\n${instr || '(no instructions)'}`;
        })
        .join('\n\n')
    : null;

  const prepareDeps = {
    container: deps.container,
    git: deps.git,
    workspaceRoot: deps.workspaceRoot,
    local: deps.local,
    devopsModel: deps.devopsModel,
    devopsThinkingLevel: deps.devopsThinkingLevel,
    devopsTimeoutMs: deps.devopsTimeoutMs,
    devServerPort,
    issueId: input.issueId,
    iterationId: input.iterationId,
    control: deps.control,
    tagInstructions,
    reposNames: reposNames || null,
    reposRequireDevServer: reposRequireDevServer || null,
    reposInstructions,
    ...(deps.devopsFactory
      ? { devops: deps.devopsFactory }
      : {}),
    runInstructions: dbRunInstructionsStore(db),
    onDevOpsStdout: (_repo: string, chunk: string): void =>
      deps.sse.publish({
        type: 'log',
        issueId: input.issueId,
        iterationId: input.iterationId,
        stepRunId: SessionAddress.forIssueRun(
          input.issueId,
          'devops',
        ).toString(),
        stream: 'stdout',
        data: chunk,
        ts: new Date().toISOString(),
      }),
    onDevOpsStderr: (_repo: string, chunk: string): void =>
      deps.sse.publish({
        type: 'log',
        issueId: input.issueId,
        iterationId: input.iterationId,
        stepRunId: SessionAddress.forIssueRun(
          input.issueId,
          'devops',
        ).toString(),
        stream: 'stderr',
        data: chunk,
        ts: new Date().toISOString(),
      }),
  };

  const publishWorkspaceProgress = (progress: WorkspaceProgress): void => {
    deps.sse.publish({
      type: 'workspace_progress',
      issueId: input.issueId,
      data: JSON.stringify(progress),
      ts: new Date().toISOString(),
    });
  };

  const prepStart = new Date().toISOString();
  db.update(issues)
    .set({ status: 'preparing', updated_at: prepStart })
    .where(eq(issues.id, input.issueId))
    .run();

  try {
    const prepared = await prepareWorkspace(
      prepareDeps,
      { id: input.issueId },
      repos,
      publishWorkspaceProgress,
    );

    repos.forEach((repo) =>
      excludeInfraFiles(workspaceDir, extractRepoNameFromUrl(repo.repository_url)),
    );

    if (devServerPort !== undefined && devRepo) {
      const repoName = extractRepoNameFromUrl(devRepo.repository_url);
      const pid = startRepoDevServer(workspaceDir, repoName);
      if (pid !== null) {
        db.update(issues)
          .set({ dev_server_port: devServerPort, dev_server_pid: pid })
          .where(eq(issues.id, input.issueId))
          .run();
      } else {
        releaseIssueDevPorts(input.issueId);
      }
    }

    if (issueRow?.tag_id) {
      const workspaceInstructionsPath = join(workspaceDir, 'WORKSPACE_INSTRUCTIONS.md');
      if (existsSync(workspaceInstructionsPath)) {
        const wsInstructions = readFileSync(workspaceInstructionsPath, 'utf-8');
        if (wsInstructions.trim()) {
          updateTagRunInstructions(db, issueRow.tag_id, {
            instructions: wsInstructions,
            status: 'generated',
          });
        }
      }
    }

    return prepared;
  } catch (error) {
    releaseIssueDevPorts(input.issueId);
    console.error('workspace preparation failed', error);
    const failedAt = new Date().toISOString();
    const message = error instanceof Error ? error.message : String(error);
    db.update(iterations)
      .set({ status: 'failed', updated_at: failedAt })
      .where(eq(iterations.id, input.iterationId))
      .run();
    db.update(issues)
      .set({ status: 'failed', updated_at: failedAt })
      .where(eq(issues.id, input.issueId))
      .run();
    deps.sse.publish({
      type: 'iteration_status',
      issueId: input.issueId,
      iterationId: input.iterationId,
      data: JSON.stringify({
        iterationId: input.iterationId,
        status: 'failed',
        needsInput: false,
        error: message,
      }),
      ts: failedAt,
    });
    throw error;
  }
}

async function upsertMergeRequestsFromResultJson(
  db: Db,
  workspaceRoot: string,
  issueId: string,
): Promise<void> {
  const resultPath = join(
    workspaceHostDirFor(workspaceRoot, issueId),
    'result.json',
  );
  let text: string;
  try {
    text = readFileSync(resultPath, 'utf8');
  } catch {
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return;
  }
  const list = (parsed as { merge_requests?: unknown } | null)?.merge_requests;
  if (!Array.isArray(list) || list.length === 0) return;

  interface MrEntry {
    repository_url: string;
    url: string;
    title?: string;
    message?: string;
  }
  const newMrs: MrEntry[] = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const mr = item as Record<string, unknown>;
    const url = typeof mr.url === 'string' ? mr.url.trim() : '';
    if (!url) continue;
    newMrs.push({
      repository_url: typeof mr.repository_url === 'string' ? mr.repository_url : '',
      url,
      ...(typeof mr.title === 'string' ? { title: mr.title } : {}),
      ...(typeof mr.message === 'string' ? { message: mr.message } : {}),
    });
  }
  if (newMrs.length === 0) return;

  const currentRow = db
    .select({ merge_requests: issues.merge_requests })
    .from(issues)
    .where(eq(issues.id, issueId))
    .get();
  const existing: MrEntry[] = currentRow?.merge_requests ?? [];
  const byUrl = new Map<string, MrEntry>();
  for (const mr of existing) byUrl.set(mr.url ?? '', mr);
  for (const mr of newMrs) byUrl.set(mr.url ?? '', mr);

  db.update(issues)
    .set({ merge_requests: [...byUrl.values()], updated_at: new Date().toISOString() })
    .where(eq(issues.id, issueId))
    .run();
}

const REPORT_ARTIFACTS = ['report.md', 'report.html'] as const;
const AUTHORED_REPORT_FILES = ['report.md', 'report.json'] as const;

export interface ReportArchiveResult {
  dir: string | null;
  files: string[];
}

export function archiveReportArtifacts(
  workspaceRoot: string | undefined,
  issueId: string,
): ReportArchiveResult {
  const wsRoot = workspaceRoot ?? DEFAULT_WORKSPACE_ROOT;
  const issueDir = workspaceHostDirFor(wsRoot, issueId);
  const files = REPORT_ARTIFACTS.filter((name) =>
    existsSync(join(issueDir, name)),
  );
  if (files.length === 0) return { dir: null, files: [] };

  const stamp = new Date().toISOString();
  let dir = join(issueDir, 'reports', stamp);
  for (let n = 1; existsSync(dir); n += 1) {
    dir = join(issueDir, 'reports', `${stamp}-${n}`);
  }
  mkdirSync(dir, { recursive: true });
  for (const name of files) {
    renameSync(join(issueDir, name), join(dir, name));
  }
  return { dir, files };
}

function describeReportArtifacts(issueDir: string): string {
  return REPORT_ARTIFACTS.map((name) => {
    const path = join(issueDir, name);
    try {
      return `${path} (${statSync(path).size}B)`;
    } catch {
      return `${path} (absent)`;
    }
  }).join(', ');
}

function reportArtifactsPresent(issueDir: string): {
  md: boolean;
  html: boolean;
} {
  const present = (name: string): boolean => {
    try {
      return statSync(join(issueDir, name)).size > 0;
    } catch {
      return false;
    }
  };
  return { md: present('report.md'), html: present('report.html') };
}

async function persistReportRun(
  db: Db,
  stepRunId: string,
  input: {
    status: StepRunStatus;
    feedback: string | null;
    stdout: string;
    stderr: string;
    events: SessionEvent[];
    stats: SessionStats | null;
    artifacts: { md: boolean; html: boolean };
  },
): Promise<void> {
  try {
    await updateStepRun(db, stepRunId, {
      status: input.status,
      feedback: input.feedback,
    });
    await createStepOutput(db, {
      stepRunId,
      report: JSON.stringify({ artifacts: input.artifacts }),
      stdout: input.stdout,
      stderr: input.stderr,
      events: input.events,
      stats: input.stats,
    });
  } catch (error) {
    console.error('report run persistence failed', { stepRunId, error });
  }
}

const MODEL_ID_PATTERNS: RegExp[] = [
  /provider\d*\//i,
  /\*\*Model:\*\*/i,
  /\bmodel:\s*`?[a-z0-9._-]+\/[a-z0-9._-]+/i,
  /(?<=[`/:])(?:deepseek|claude|gpt|qwen|llama)[-.\w]*/i,
  /\b(?:deepseek|claude|gpt|qwen|llama)[-.\w]*(?=[`/:])/i,
];

function detectModelLeak(issueDir: string, model?: string): string[] {
  const needles = new Set<string>();
  if (model) {
    needles.add(model);
    const bare = model.includes('/')
      ? model.slice(model.lastIndexOf('/') + 1)
      : '';
    if (bare.length >= 6) needles.add(bare);
  }

  const warnings: string[] = [];
  for (const name of AUTHORED_REPORT_FILES) {
    let text: string;
    try {
      text = readFileSync(join(issueDir, name), 'utf8');
    } catch {
      continue;
    }
    const exact = [...needles].find((needle) => text.includes(needle));
    if (exact) {
      warnings.push(`model id leaked into ${name}`);
      continue;
    }
    if (MODEL_ID_PATTERNS.some((pattern) => pattern.test(text))) {
      warnings.push(`model-like id leaked into ${name}`);
    }
  }
  return warnings;
}

const PREVIOUS_REPORT_PATH =
  /(?:[^\s"'`\\]*\/)?(?:reports|\.iteration-results)\/[^\s"'`\\]+\/report\.(?:md|html)/;

function anchoredPreviousReportPath(event: SessionEvent): string | null {
  if (event.type !== 'tool_use') return null;
  const match = PREVIOUS_REPORT_PATH.exec(JSON.stringify(event.args ?? ''));
  return match ? match[0] : null;
}

export type ReportRunDeps = Pick<
  IterationRunDeps,
  'pi' | 'sse' | 'control' | 'workspaceRoot'
> & {
  db: Db;
};

const activeReportRuns = new Set<string>();

export const REPORT_RUN_HEARTBEAT_MS = SESSION_HEARTBEAT_MS;

export const REPORT_RUN_STALE_MS = SESSION_STALE_MS;

const lastReportOutcome = new Map<string, 'failed'>();

export function isReportRunActive(issueId: string): boolean {
  return activeReportRuns.has(issueId);
}

export function lastReportFailed(issueId: string): boolean {
  return lastReportOutcome.get(issueId) === 'failed';
}

const reportWarnings = new Map<string, string[]>();

const observedReportModel = new Map<string, string>();

export function observedModelFor(issueId: string): string | undefined {
  return observedReportModel.get(issueId);
}

export function reportWarningsFor(issueId: string, hostDir?: string): string[] {
  const live = reportWarnings.get(issueId) ?? [];
  if (!hostDir) return live;
  const flagged = new Set(live.map((warning) => warningFile(warning)));
  const derived = detectModelLeak(
    hostDir,
    observedReportModel.get(issueId),
  ).filter((warning) => !flagged.has(warningFile(warning)));
  return [...live, ...derived];
}

function warningFile(warning: string): string | null {
  const match = /leaked into (.+)$/.exec(warning);
  return match ? match[1] : null;
}

export function reportModelFor(
  db: Db,
  issueId: string,
  iterationId?: string,
): string | undefined {
  const issue = db
    .select({ step_models: issues.step_models })
    .from(issues)
    .where(eq(issues.id, issueId))
    .get();
  const explicit = issue?.step_models?.report;
  if (explicit) return explicit;

  const iteration = iterationId
    ? db
        .select({ model: iterations.model })
        .from(iterations)
        .where(eq(iterations.id, iterationId))
        .get()
    : db
        .select({ model: iterations.model })
        .from(iterations)
        .where(
          and(
            eq(iterations.issue_id, issueId),
            eq(iterations.status, 'completed'),
          ),
        )
        .orderBy(desc(iterations.number))
        .get();
  return iteration?.model ?? undefined;
}

export function reportThinkingLevelFor(
  db: Db,
  issueId: string,
): ThinkingLevel | undefined {
  const issue = db
    .select({ step_thinking_levels: issues.step_thinking_levels })
    .from(issues)
    .where(eq(issues.id, issueId))
    .get();
  return issue?.step_thinking_levels?.report;
}

export interface RunReportAgentInput {
  issueId: string;
  containerName: string;
  hostDir: string;
  prompt: string;
  model?: string;
  thinkingLevel?: ThinkingLevel;
  trigger?: 'post-iteration' | 'manual';
  origin?: string | null;
}

function reportStepStatusEvent(
  issueId: string,
  reportRunId: string,
  status: StepRunStatus | 'running',
  model?: string,
): SSEEvent {
  return {
    type: 'step_status',
    issueId,
    stepRunId: reportRunId,
    data:
      status === 'running'
        ? JSON.stringify({ status, step: 'report', model: model ?? null })
        : status,
    ts: new Date().toISOString(),
  };
}

export async function runReportAgent(
  deps: ReportRunDeps,
  input: RunReportAgentInput,
): Promise<void> {
  const reportRunId = SessionAddress.forIssueRun(
    input.issueId,
    'report',
  ).toString();

  if (isReportRunActive(input.issueId)) {
    console.error('report agent skipped: run already active', {
      issueId: input.issueId,
      trigger: input.trigger ?? 'unknown',
    });
    return;
  }

  let stepRunId: string;
  try {
    const previous = await listStepRunsByIssue(deps.db, input.issueId);
    const stepRun = await createStepRun(deps.db, {
      issueId: input.issueId,
      iterationId: null,
      step: 'report',
      attempt: previous.filter((run) => run.step === 'report').length + 1,
      context: input.trigger ?? 'report',
    });
    await updateStepRun(deps.db, stepRun.id, { status: 'running' });
    stepRunId = stepRun.id;
  } catch (error) {
    console.error('report run record failed', {
      issueId: input.issueId,
      error,
    });
    return;
  }

  let archive: ReportArchiveResult;
  try {
    archive = archiveReportArtifacts(deps.workspaceRoot, input.issueId);
  } catch (error) {
    console.error('report artifacts archive failed', {
      issueId: input.issueId,
      error,
    });
    lastReportOutcome.set(input.issueId, 'failed');
    deps.sse.publish(
      reportStepStatusEvent(input.issueId, reportRunId, 'failed'),
    );
    await persistReportRun(deps.db, stepRunId, {
      status: 'failed',
      feedback: `archive failed: ${error instanceof Error ? error.message : String(error)}`,
      stdout: '',
      stderr: '',
      events: [],
      stats: null,
      artifacts: { md: false, html: false },
    });
    return;
  }

  const startedAt = Date.now();
  console.log(
    `report agent started: issue=${input.issueId} trigger=${input.trigger ?? 'unknown'}${input.origin ? ` origin=${input.origin}` : ''} archived=${archive.dir ?? 'none'} files=[${archive.files.join(', ')}] at=${new Date(startedAt).toISOString()}`,
  );
  deps.sse.publish(
    reportStepStatusEvent(input.issueId, reportRunId, 'running', input.model),
  );
  activeReportRuns.add(input.issueId);

  let status: StepRunStatus = 'failed';
  let failure: unknown;
  let observedModel: string | undefined;
  let anchoredPath: string | null = null;
  const session = startAgentSession(
    {
      sse: deps.sse,
      store: {
        appendStepRunEvent: (id, event) =>
          appendStepRunEvent(deps.db, id, event),
        updateStepRun: (id, patch) => updateStepRun(deps.db, id, patch),
      },
    },
    {
      issueId: input.issueId,
      sessionId: reportRunId,
      persistStepRunId: stepRunId,
      heartbeatMs: REPORT_RUN_HEARTBEAT_MS,
      onEvent: (event) => {
        if (anchoredPath === null) {
          anchoredPath = anchoredPreviousReportPath(event);
        }
      },
    },
  );
  try {
    const reportRun = deps.pi.run(input.containerName, input.prompt, {
      cwd: input.hostDir,
      model: input.model,
      thinkingLevel: input.thinkingLevel,
      stepRunId: reportRunId,
      issueId: input.issueId,
      registry: deps.control,
      sessionDir: issueSessionDir(input.issueId),
      excludeTools: soloRunExcludeTools(),
      systemAppend: STEP_SYSTEM_APPEND,
      sessionName: sessionDisplayName({ step: 'report', issueId: input.issueId }),
      ...session.callbacks,
    });
    const stallMs = resolveAgentStallTimeoutMs();
    const result = await withAgentStallGuard(reportRun, {
      stallMs,
      label: 'report agent',
      activity: () => session.activity(),
      recover: stallRecoveries({
        control: deps.control,
        target: runTarget(reportRunId),
        graceMs: stallMs,
      }),
      onStall: () => {
        void deps.control?.send(runTarget(reportRunId), { type: 'abort_retry' });
        deps.control?.abort(reportRunId);
      },
    });
    observedModel = result.stats?.model ?? undefined;
    session.setStats(result.stats ?? null);
    const derived = result.aborted
      ? 'failed'
      : stepRunStatusFromResult(result.exitCode, result.report);
    status = derived === 'success' ? 'success' : 'failed';
    if (status === 'failed') failure = `exit status: ${derived}`;
  } catch (error) {
    failure = error;
    status = 'failed';
  } finally {
    activeReportRuns.delete(input.issueId);
    session.stop();
    if (observedModel) observedReportModel.set(input.issueId, observedModel);
    else observedReportModel.delete(input.issueId);
    const rendered = await renderReportArtifacts(input.hostDir).catch(
      (error: unknown) => ({
        ok: false,
        html: false,
        warnings: [`report page failed: ${String(error)}`],
      }),
    );
    const artifacts = reportArtifactsPresent(input.hostDir);
    if (status === 'success' && !artifacts.md) {
      status = 'failed';
      failure = 'report.md отсутствует после прогона';
    }
    if (status === 'success') {
      lastReportOutcome.delete(input.issueId);
      const warnings = [
        ...detectModelLeak(input.hostDir, observedModel ?? input.model),
        ...rendered.warnings,
        ...(anchoredPath
          ? [`anchored on previous report: ${anchoredPath}`]
          : []),
      ];
      if (warnings.length > 0) {
        reportWarnings.set(input.issueId, warnings);
        console.warn('model id leaked into report artifacts', {
          issueId: input.issueId,
          warnings,
        });
      } else {
        reportWarnings.delete(input.issueId);
      }
    } else {
      lastReportOutcome.set(input.issueId, 'failed');
    }
    const snapshot = session.snapshot();
    const truncated = snapshot.events.some(
      (event) =>
        event.type === 'notice' && event.message.includes('лимитом вывода'),
    );
    let feedback: string | null = null;
    if (status === 'failed') {
      const reason =
        failure instanceof Error ? failure.message : String(failure);
      feedback = `report failed: ${reason}`;
    } else if (!artifacts.html) {
      feedback = truncated
        ? 'report.html не собран движком: прогон оборван лимитом вывода модели (maxTokens) — ход закончился на размышлении'
        : `страница не собрана: ${rendered.warnings.join('; ') || 'report.md пуст'}`;
    }
    await persistReportRun(deps.db, stepRunId, {
      status,
      feedback,
      stdout: snapshot.stdout,
      stderr: snapshot.stderr,
      events: capSessionEvents(snapshot.events),
      stats: snapshot.stats,
      artifacts,
    });
  }

  deps.sse.publish(reportStepStatusEvent(input.issueId, reportRunId, status));
  const durationMs = Date.now() - startedAt;
  if (status === 'success') {
    console.log(
      `report agent finished: issue=${input.issueId} trigger=${input.trigger ?? 'unknown'} durationMs=${durationMs} artifacts: ${describeReportArtifacts(input.hostDir)}`,
    );
  } else {
    console.error('report agent failed', {
      issueId: input.issueId,
      durationMs,
      error: failure,
    });
  }
}

async function spawnReportAgent(
  db: Db,
  deps: IterationRunDeps,
  outcome: IterationTerminalOutcome,
): Promise<void> {
  const wsRoot = deps.workspaceRoot ?? DEFAULT_WORKSPACE_ROOT;
  const hostDir = workspaceHostDirFor(wsRoot, outcome.issueId);

  const prompt = buildStepPrompt({
    step: 'report',
    issueTitle: outcome.issueTitle,
    description: '',
    jiraText: null,
    context: `Iteration #${outcome.iterationNumber} completed with status: ${outcome.iterationStatus}.`,
    feedback: null,
    repoPaths: outcome.repoPaths,
    iterationCount: outcome.iterationCount,
    workingDir: deps.local ? hostDir : workspaceContainerDirFor(outcome.issueId),
  });

  await runReportAgent({ ...deps, db }, {
    issueId: outcome.issueId,
    containerName: outcome.containerName,
    hostDir,
    prompt,
    model: reportModelFor(db, outcome.issueId, outcome.iterationId),
    thinkingLevel:
      reportThinkingLevelFor(db, outcome.issueId) ??
      outcome.thinkingLevel,
    trigger: 'post-iteration',
  });
  try {
    await refreshLatestResultSnapshot(db, deps.workspaceRoot, outcome.issueId);
  } catch (error) {
    console.error('refresh report snapshot failed', error);
  }
}

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
    worker_count: input.iteration.worker_count,
    status: 'running',
    created_at: now,
    updated_at: now,
  };

  const repoWorkspaces = input.repoWorkspaces;

  const issueRow = db
    .select()
    .from(issues)
    .where(eq(issues.id, input.issue.id))
    .get();
  if (issueRow?.dev_server_pid) {
    await stopDevServerProcess(issueRow.dev_server_pid);
    releaseIssueDevPorts(input.issue.id);
    db.update(issues)
      .set({ dev_server_port: null, dev_server_pid: null })
      .where(eq(issues.id, input.issue.id))
      .run();

    const devRepo = input.repositories.find(
      (repo) => repo.bootstrap_enabled !== false,
    );
    if (devRepo) {
      const port = await allocateDevPort(input.issue.id);
      const workspaceDir = workspaceHostDirFor(
        deps.workspaceRoot ?? DEFAULT_WORKSPACE_ROOT,
        input.issue.id,
      );
      const pid = startRepoDevServer(
        workspaceDir,
        extractRepoNameFromUrl(devRepo.repository_url),
      );
      if (pid !== null) {
        db.update(issues)
          .set({ dev_server_port: port, dev_server_pid: pid })
          .where(eq(issues.id, input.issue.id))
          .run();
      } else {
        releaseIssueDevPorts(input.issue.id);
      }
    }
  }

  const runningAt = new Date().toISOString();
  db.update(iterations)
    .set({ status: 'running', updated_at: runningAt })
    .where(eq(iterations.id, input.iteration.id))
    .run();
  db.update(issues)
    .set({ status: 'running', updated_at: runningAt })
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
    ts: runningAt,
  });

  const jiraText = await fetchJiraText(
    deps.workspaceRoot ?? DEFAULT_WORKSPACE_ROOT,
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

  let result: RunIterationResult;
  let reportOutcome: IterationTerminalOutcome | null = null;
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
        onQuestionStatus: (status) => {
          const at = new Date().toISOString();
          db.update(issues)
            .set({ status, updated_at: at })
            .where(eq(issues.id, input.issue.id))
            .run();
          deps.sse.publish({
            type: 'iteration_status',
            issueId: input.issue.id,
            iterationId: input.iteration.id,
            data: JSON.stringify({
              iterationId: input.iteration.id,
              status,
              needsInput: status === 'question',
            }),
            ts: at,
          });
        },
        onIterationTerminal: (outcome) => {
          reportOutcome = outcome;
        },
      },
      {
        issue: input.issue,
        iteration,
        repositories: input.repositories,
        preparedRepoWorkspaces: repoWorkspaces,
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
      },
    );
  } catch (error) {
    console.error('runIteration failed', error);
    const failedAt = new Date().toISOString();
    const message = error instanceof Error ? error.message : String(error);
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
        error: message,
      }),
      ts: failedAt,
    });
    await writeIterationReport(db, deps, input, 'failed');
    void upsertMergeRequestsFromResultJson(
      db,
      deps.workspaceRoot ?? DEFAULT_WORKSPACE_ROOT,
      input.issue.id,
    ).catch((error) => console.error('upsertMergeRequests failed', error));
    return { iterationStatus: 'failed', needsInput: false };
  }

  if (result.iterationStatus === 'completed') {
    await snapshotIterationResult(
      deps.workspaceRoot ?? DEFAULT_WORKSPACE_ROOT,
      input.issue.id,
      input.iteration.id,
    );
  }

  if (reportOutcome) {
    void spawnReportAgent(db, deps, reportOutcome);
  }

  const finishedAt = new Date().toISOString();
  db.update(iterations)
    .set({ status: result.iterationStatus, updated_at: finishedAt })
    .where(eq(iterations.id, input.iteration.id))
    .run();

  const hasNextPending = db
    .select({ id: iterations.id })
    .from(iterations)
    .where(
      and(
        eq(iterations.issue_id, input.issue.id),
        eq(iterations.status, 'pending'),
      ),
    )
    .get();

  const issueStatus = hasNextPending ? 'pending' : result.iterationStatus;
  db.update(issues)
    .set({ status: issueStatus, updated_at: finishedAt })
    .where(eq(issues.id, input.issue.id))
    .run();

  void upsertMergeRequestsFromResultJson(
    db,
    deps.workspaceRoot ?? DEFAULT_WORKSPACE_ROOT,
    input.issue.id,
  ).catch((error) => console.error('upsertMergeRequests failed', error));

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

  await writeIterationReport(db, deps, input, result.iterationStatus);

  void startNextPendingIteration(db, deps, input.issue.id).catch((error) =>
    console.error(
      `[queue] startNextPendingIteration failed for issue ${input.issue.id}`,
      error,
    ),
  );

  return result;
}

async function startNextPendingIteration(
  db: Db,
  deps: IterationRunDeps,
  issueId: string,
): Promise<void> {
  const next = db
    .select()
    .from(iterations)
    .where(
      and(eq(iterations.issue_id, issueId), eq(iterations.status, 'pending')),
    )
    .orderBy(asc(iterations.number))
    .get();

  if (!next) return;

  const issue = db
    .select()
    .from(issues)
    .where(eq(issues.id, issueId))
    .get();
  if (!issue) return;

  const repositories = db
    .select()
    .from(issueRepositories)
    .where(eq(issueRepositories.issue_id, issueId))
    .all()
    .map((repository) => ({
      repository_url: repository.repository_url,
      base_branch: repository.branch_name,
      create_mr: !!repository.create_mr,
      bootstrap_enabled: repository.bootstrap_enabled ?? true,
    }));

  const prepareDeps = {
    container: deps.container,
    git: deps.git,
    sse: deps.sse,
    local: deps.local,
    control: deps.control,
    ...(deps.devopsFactory
      ? { devopsFactory: deps.devopsFactory }
      : {}),
    devopsModel: deps.devopsModel,
    devopsThinkingLevel: deps.devopsThinkingLevel,
    devopsTimeoutMs: deps.devopsTimeoutMs,
    workspaceRoot: deps.workspaceRoot,
  };

  console.error(
    `[queue] starting pending iteration ${next.id} (#${next.number}) for issue ${issueId}`,
  );

  void (async () => {
    try {
      const ws = await prepareIssueWorkspace(db, prepareDeps, {
        issueId: issue.id,
        iterationId: next.id,
        repositories,
      });
      void runIssueIteration(db, deps, {
        issue: {
          id: issue.id,
          title: issue.title,
          pipelineSteps: issue.pipeline_steps,
          description: issue.description ?? '',
          desiredResult: issue.desired_result ?? 'md',
          jiraIssueUrl: issue.jira_issue_url,
        },
        iteration: {
          id: next.id,
          issueId: issue.id,
          number: next.number,
          context: next.context,
          steps: next.steps,
          reviewContext: next.review_context ?? '',
          isReviewNeed: !!next.is_review_need,
          worker_count: next.worker_count ?? undefined,
        },
        repositories,
        repoWorkspaces: ws,
        model: next.model ?? undefined,
        step_models: next.step_models ?? undefined,
        thinking_level: next.thinking_level ?? undefined,
        step_thinking_levels: next.step_thinking_levels ?? undefined,
      }).catch((error) => console.error('run failed', error));
    } catch (error) {
      console.error('preparation failed, issue set to failed', error);
    }
  })();
}