import type {
  DesiredResult,
  Iteration,
  PipelineStep,
  RunInstructionsStatus,
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
  chmodSync,
  existsSync,
  mkdirSync,
  copyFileSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { copyFile, mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Db } from '../db/client';
import { startAgentSession } from '../pi/agent-session';
import type { AgentSession } from '../pi/agent-session';
import {
  resolveAgentStallTimeoutMs,
  withAgentStallGuard,
} from './timeout';
import { issueSessionDir, sessionDisplayName } from '../pi/session-paths';
import { soloRunExcludeTools } from '../pi/tool-policy';
import { stallRecoveries } from '../pi/stall-recovery';
import { STEP_SYSTEM_APPEND } from './prompts';
import { renderReportArtifacts } from './report-render';
import { embedReportScreenshots } from './embed-screenshots';
import { capSessionEvents } from '../pi/session-events-cap';
import { allocateDevPort, releaseIssueDevPorts, reserveDevPort } from '../port-allocator';
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
  containerNameFor,
  iterationResultDirFor,
  workspaceContainerDirFor,
  workspaceHostDirFor,
} from '../workspace/paths';
import { RUN_INSTRUCTIONS_FILE } from './devops';

const DEV_SERVER_SCRIPT = 'DEV_SERVER.sh';
const DEV_SERVER_PID_FILE = '.dev-server.pid';
const DEV_SERVER_LOG_FILE = '.dev-server.log';

const INFRA_FILES = [
  'RUN_INSTRUCTIONS.md',
  DEV_SERVER_SCRIPT,
  DEV_SERVER_PID_FILE,
  DEV_SERVER_LOG_FILE,
];

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

function devServerPidPath(workspaceDir: string, repoName: string): string {
  return join(workspaceDir, repoName, DEV_SERVER_PID_FILE);
}

export function readDevServerPid(
  workspaceDir: string,
  repoName: string,
): number | null {
  try {
    const pid = Number.parseInt(
      readFileSync(devServerPidPath(workspaceDir, repoName), 'utf8').trim(),
      10,
    );
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function writeDevServerPid(
  workspaceDir: string,
  repoName: string,
  pid: number,
): void {
  try {
    writeFileSync(devServerPidPath(workspaceDir, repoName), `${pid}\n`);
  } catch (error) {
    console.error('failed to write dev server pid file', error);
  }
}

export function clearDevServerPid(
  workspaceDir: string,
  repoName: string,
): void {
  rmSync(devServerPidPath(workspaceDir, repoName), { force: true });
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function devServerResponds(
  port: number,
  attempts = 1,
  delayMs = 500,
): Promise<boolean> {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      await fetch(`http://127.0.0.1:${port}/`, {
        signal: AbortSignal.timeout(2000),
      });
      return true;
    } catch {
      if (attempt < attempts) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }
  return false;
}

function readDevServerLogTail(
  workspaceDir: string,
  repoName: string,
  lines = 6,
): string {
  try {
    const raw = readFileSync(
      join(workspaceDir, repoName, DEV_SERVER_LOG_FILE),
      'utf8',
    );
    return raw.trim().split('\n').slice(-lines).join(' | ');
  } catch {
    return '';
  }
}

export function startRepoDevServer(
  workspaceDir: string,
  repoName: string,
  port: number,
): number | null {
  const repoDir = join(workspaceDir, repoName);
  const scriptPath = join(repoDir, DEV_SERVER_SCRIPT);
  clearDevServerPid(workspaceDir, repoName);
  if (!existsSync(scriptPath)) return null;
  try {
    const child = spawn(scriptPath, [], {
      cwd: repoDir,
      env: { ...process.env, PORT: String(port) },
      detached: true,
      stdio: 'ignore',
    });
    child.on('error', (error) => {
      console.error('failed to start DEV_SERVER.sh', error);
    });
    child.unref();
    if (child.pid) writeDevServerPid(workspaceDir, repoName, child.pid);
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
  const warnUnmatched = (
    url: string,
    status: RunInstructionsStatus,
    matched: boolean,
  ): void => {
    if (matched) return;
    console.warn(
      `run instructions not saved: no repository row matches ${JSON.stringify(url)} (status ${status})`,
    );
  };

  return {
    getStatus: (url) => getRepositoryByUrl(db, url)?.runInstructionsStatus,
    getInstructions: (url) => getRepositoryByUrl(db, url)?.runInstructions ?? null,
    saveGenerated: (url, instructions) =>
      warnUnmatched(
        url,
        'generated',
        updateRepositoryRunInstructions(db, url, {
          instructions,
          status: 'generated',
        }),
      ),
    saveFailed: (url) =>
      warnUnmatched(
        url,
        'failed',
        updateRepositoryRunInstructions(db, url, {
          instructions: null,
          status: 'failed',
        }),
      ),
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

export interface DevOpsRunRepos {
  repository_url: string;
  bootstrap_enabled?: boolean;
}

export interface DevOpsContext {
  tagInstructions: string | null;
  reposNames: string | null;
  reposRequireDevServer: string | null;
  reposInstructions: string | null;
}

export function collectDevOpsContext(
  db: Db,
  issueId: string,
  repositories: DevOpsRunRepos[],
): DevOpsContext {
  const issueRow = db
    .select({ tag_id: issues.tag_id })
    .from(issues)
    .where(eq(issues.id, issueId))
    .get();
  const tag = issueRow?.tag_id ? getTag(db, issueRow.tag_id) : undefined;

  if (tag) {
    return {
      tagInstructions: tag.run_instructions ?? null,
      reposNames:
        tag.repositories
          .map((tr) => extractRepoNameFromUrl(tr.repository.url))
          .join(', ') || null,
      reposRequireDevServer:
        tag.repositories
          .filter((tr) => tr.bootstrap_enabled)
          .map((tr) => extractRepoNameFromUrl(tr.repository.url))
          .join(', ') || null,
      reposInstructions: tag.repositories
        .map((tr) => {
          const name = extractRepoNameFromUrl(tr.repository.url);
          const instr = tr.repository.runInstructions?.trim();
          return `### ${name}\n${instr || '(no instructions)'}`;
        })
        .join('\n\n'),
    };
  }

  return {
    tagInstructions: null,
    reposNames:
      repositories
        .map((r) => extractRepoNameFromUrl(r.repository_url))
        .join(', ') || null,
    reposRequireDevServer:
      repositories
        .filter((r) => r.bootstrap_enabled !== false)
        .map((r) => extractRepoNameFromUrl(r.repository_url))
        .join(', ') || null,
    reposInstructions: null,
  };
}

const activeDevopsRuns = new Set<string>();

export function isDevopsRunActive(issueId: string): boolean {
  return activeDevopsRuns.has(issueId);
}

export const DEVOPS_RUN_HEARTBEAT_MS = SESSION_HEARTBEAT_MS;

interface DevopsSessionHandle {
  stepRunId: string;
  sessionId: string;
  startedAt: number;
  session: AgentSession;
}

async function startDevopsSession(
  db: Db,
  deps: { sse: SseHub; control?: StepSessionRegistry; devopsModel?: string },
  input: {
    issueId: string;
    iterationId?: string;
    sessionId: string;
    context: string;
    enabled: boolean;
  },
): Promise<DevopsSessionHandle | null> {
  if (!input.enabled) return null;

  const previous = await listStepRunsByIssue(db, input.issueId);
  const stepRun = await createStepRun(db, {
    issueId: input.issueId,
    iterationId: null,
    step: 'devops',
    attempt: previous.filter((run) => run.step === 'devops').length + 1,
    context: input.context,
  });
  await updateStepRun(db, stepRun.id, { status: 'running' });

  const session = startAgentSession(
    {
      sse: deps.sse,
      control: deps.control,
      store: {
        appendStepRunEvent: (id, event) =>
          appendStepRunEvent(db, id, event),
        updateStepRun: (id, patch) => updateStepRun(db, id, patch),
      },
    },
    {
      issueId: input.issueId,
      ...(input.iterationId ? { iterationId: input.iterationId } : {}),
      sessionId: input.sessionId,
      persistStepRunId: stepRun.id,
      heartbeatMs: DEVOPS_RUN_HEARTBEAT_MS,
    },
  );

  deps.sse.publish({
    type: 'step_status',
    issueId: input.issueId,
    stepRunId: input.sessionId,
    data: JSON.stringify({
      status: 'running',
      step: 'devops',
      model: deps.devopsModel ?? null,
    }),
    ts: new Date().toISOString(),
  });

  activeDevopsRuns.add(input.issueId);
  return {
    stepRunId: stepRun.id,
    sessionId: input.sessionId,
    startedAt: Date.now(),
    session,
  };
}

async function finishDevopsSession(
  db: Db,
  deps: { sse: SseHub },
  handle: DevopsSessionHandle | null,
  input: {
    issueId: string;
    status: StepRunStatus;
    summary: string;
    feedback?: string | null;
    stats?: SessionStats | null;
  },
): Promise<void> {
  if (!handle) return;
  activeDevopsRuns.delete(input.issueId);
  handle.session.stop();

  const snapshot = handle.session.snapshot();
  try {
    await updateStepRun(db, handle.stepRunId, {
      status: input.status,
      feedback: input.feedback ?? null,
    });
    await createStepOutput(db, {
      stepRunId: handle.stepRunId,
      report: JSON.stringify({
        status: input.status === 'success' ? 'pass' : 'fail',
        summary: input.summary,
      }),
      stdout: snapshot.stdout,
      stderr: snapshot.stderr,
      events: capSessionEvents(snapshot.events),
      stats: input.stats ?? snapshot.stats,
    });
  } catch (error) {
    console.error('devops run persistence failed', {
      stepRunId: handle.stepRunId,
      error,
    });
  }

  deps.sse.publish({
    type: 'step_status',
    issueId: input.issueId,
    stepRunId: handle.sessionId,
    data: input.status,
    ts: new Date().toISOString(),
  });
}

const WORKSPACE_HELPERS = ['pw-browsers.sh'];

export function installWorkspaceHelpers(workspaceDir: string): void {
  if (!existsSync(workspaceDir)) return;
  const binDir = join(
    dirname(fileURLToPath(import.meta.url)),
    '..',
    '..',
    '..',
    'bin',
  );
  for (const name of WORKSPACE_HELPERS) {
    const source = join(binDir, name);
    if (!existsSync(source)) continue;
    const target = join(workspaceDir, name);
    copyFileSync(source, target);
    chmodSync(target, 0o755);
  }
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
    installWorkspaceHelpers(workspaceDir);
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

  const {
    tagInstructions,
    reposNames,
    reposRequireDevServer,
    reposInstructions,
  } = collectDevOpsContext(db, input.issueId, input.repositories);

  const devopsRunId = SessionAddress.forIssueRun(
    input.issueId,
    'devops',
  ).toString();
  const devopsSession = await startDevopsSession(db, deps, {
    issueId: input.issueId,
    iterationId: input.iterationId,
    sessionId: devopsRunId,
    context: 'post-prepare',
    enabled: Boolean(deps.devopsFactory),
  });

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
      devopsSession?.session.callbacks.onStdout(chunk),
    onDevOpsStderr: (_repo: string, chunk: string): void =>
      devopsSession?.session.callbacks.onStderr(chunk),
    onDevOpsEvent: (_repo: string, event: SessionEvent): void =>
      devopsSession?.session.callbacks.onEvent(event),
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
    installWorkspaceHelpers(workspaceDir);

    if (devServerPort !== undefined && devRepo) {
      const repoName = extractRepoNameFromUrl(devRepo.repository_url);
      const adopted = readDevServerPid(workspaceDir, repoName);
      const pid =
        adopted !== null &&
        isProcessAlive(adopted) &&
        (await devServerResponds(devServerPort, 2, 250))
          ? adopted
          : startRepoDevServer(workspaceDir, repoName, devServerPort);
      if (pid !== null) {
        db.update(issues)
          .set({ dev_server_port: devServerPort, dev_server_pid: pid })
          .where(eq(issues.id, input.issueId))
          .run();
      } else {
        releaseIssueDevPorts(input.issueId);
      }
    }

    const tagId = db
      .select({ tag_id: issues.tag_id })
      .from(issues)
      .where(eq(issues.id, input.issueId))
      .get()?.tag_id;

    if (tagId) {
      const workspaceInstructionsPath = join(workspaceDir, 'WORKSPACE_INSTRUCTIONS.md');
      if (existsSync(workspaceInstructionsPath)) {
        const wsInstructions = readFileSync(workspaceInstructionsPath, 'utf-8');
        if (wsInstructions.trim()) {
          updateTagRunInstructions(db, tagId, {
            instructions: wsInstructions,
            status: 'generated',
          });
        }
      }
    }

    await finishDevopsSession(db, deps, devopsSession, {
      issueId: input.issueId,
      status: 'success',
      summary: 'DevOps completed during workspace preparation',
    });

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

    await finishDevopsSession(db, deps, devopsSession, {
      issueId: input.issueId,
      status: 'failed',
      summary: `Workspace preparation failed: ${message}`,
      feedback: message,
    });

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

export interface DevopsRunDeps {
  db: Db;
  sse: SseHub;
  devopsFactory: DevOpsFactory;
  control?: StepSessionRegistry;
  workspaceRoot?: string;
  local?: boolean;
  devopsModel?: string;
  devopsThinkingLevel?: ThinkingLevel;
  devopsTimeoutMs?: number;
}

export interface RunDevopsAgentInput {
  issueId: string;
  repositories: DevOpsRunRepos[];
  trigger?: string;
}

function clearDevOpsArtifacts(hostDir: string, repoName: string): void {
  const repoDir = join(hostDir, repoName);
  rmSync(join(repoDir, RUN_INSTRUCTIONS_FILE), { force: true });
  rmSync(join(repoDir, DEV_SERVER_SCRIPT), { force: true });
  rmSync(join(repoDir, DEV_SERVER_PID_FILE), { force: true });
  rmSync(join(repoDir, DEV_SERVER_LOG_FILE), { force: true });
}

export async function runDevopsAgent(
  deps: DevopsRunDeps,
  input: RunDevopsAgentInput,
): Promise<void> {
  const sessionId = SessionAddress.forIssueRun(
    input.issueId,
    'devops',
  ).toString();

  if (isDevopsRunActive(input.issueId)) {
    console.error('devops agent skipped: run already active', {
      issueId: input.issueId,
      trigger: input.trigger ?? 'manual',
    });
    return;
  }

  const handle = await startDevopsSession(deps.db, deps, {
    issueId: input.issueId,
    sessionId,
    context: input.trigger ?? 'manual',
    enabled: true,
  });
  if (!handle) return;

  const hostDir = workspaceHostDirFor(
    deps.workspaceRoot ?? DEFAULT_WORKSPACE_ROOT,
    input.issueId,
  );
  const containerDir = deps.local
    ? hostDir
    : workspaceContainerDirFor(input.issueId);
  const runStore = dbRunInstructionsStore(deps.db);
  const storedPort =
    deps.db
      .select({ port: issues.dev_server_port })
      .from(issues)
      .where(eq(issues.id, input.issueId))
      .get()?.port ?? undefined;
  let devPort = storedPort;
  let portAllocatedNow = false;

  const startedAt = Date.now();
  console.log(
    `devops agent started: issue=${input.issueId} trigger=${input.trigger ?? 'manual'} at=${new Date(startedAt).toISOString()}`,
  );

  try {
    const targets = input.repositories.filter(
      (repo) => repo.bootstrap_enabled !== false,
    );
    if (targets.length === 0) {
      await finishDevopsSession(deps.db, deps, handle, {
        issueId: input.issueId,
        status: 'failed',
        summary: 'нет репозиториев с включённым bootstrap',
        feedback: 'все репозитории исключены из сборки',
      });
      return;
    }

    const missing = targets.filter(
      (repo) =>
        !existsSync(
          join(hostDir, extractRepoNameFromUrl(repo.repository_url), '.git'),
        ),
    );
    if (missing.length > 0) {
      const names = missing
        .map((repo) => extractRepoNameFromUrl(repo.repository_url))
        .join(', ');
      await finishDevopsSession(deps.db, deps, handle, {
        issueId: input.issueId,
        status: 'failed',
        summary: 'рабочая папка не подготовлена',
        feedback: `клон отсутствует: ${names}`,
      });
      return;
    }

    const context = collectDevOpsContext(deps.db, input.issueId, targets);
    if (devPort === undefined) {
      devPort = await allocateDevPort(input.issueId);
      portAllocatedNow = true;
      deps.db
        .update(issues)
        .set({ dev_server_port: devPort })
        .where(eq(issues.id, input.issueId))
        .run();
    }
    const results: Array<{ repo: string; ok: boolean; error?: string }> = [];

    for (const repo of targets) {
      const repoName = extractRepoNameFromUrl(repo.repository_url);
      const agent = deps.devopsFactory({
        containerName: containerNameFor(input.issueId),
        hostWorkspaceDir: hostDir,
        containerWorkspaceDir: containerDir,
        issueId: input.issueId,
        stepRunId: sessionId,
        registry: deps.control,
        tagInstructions: context.tagInstructions,
        reposNames: context.reposNames,
        reposRequireDevServer: context.reposRequireDevServer,
        reposInstructions: context.reposInstructions,
        model: deps.devopsModel,
        thinkingLevel: deps.devopsThinkingLevel,
        timeoutMs: deps.devopsTimeoutMs,
        onStdout: (chunk) => handle.session.callbacks.onStdout(chunk),
        onStderr: (chunk) => handle.session.callbacks.onStderr(chunk),
        onEvent: (event) => handle.session.callbacks.onEvent(event),
      });

      clearDevOpsArtifacts(hostDir, repoName);

      const result = await agent.runDevOps(
        containerDir,
        repo.repository_url,
        repoName,
        devPort,
      );
      if (result.stats) handle.session.setStats(result.stats);

      if (result.success && result.instructions) {
        runStore.saveGenerated(repo.repository_url, result.instructions);
        results.push({ repo: repoName, ok: true });
      } else {
        runStore.saveFailed(repo.repository_url);
        results.push({
          repo: repoName,
          ok: false,
          error: result.error ?? 'не удалось собрать инструкции',
        });
      }
    }

    const entryRepo = targets[0];
    if (devPort !== undefined && entryRepo && results[0]) {
      const entryName = extractRepoNameFromUrl(entryRepo.repository_url);
      const pid = readDevServerPid(hostDir, entryName);
      const serving = pid !== null && (await devServerResponds(devPort, 5, 600));
      if (serving && pid !== null) {
        deps.db
          .update(issues)
          .set({ dev_server_port: devPort, dev_server_pid: pid })
          .where(eq(issues.id, input.issueId))
          .run();
      } else if (
        results[0].ok &&
        existsSync(join(hostDir, entryName, DEV_SERVER_SCRIPT))
      ) {
        const logTail = readDevServerLogTail(hostDir, entryName);
        results[0].ok = false;
        results[0].error = `dev server не отвечает на :${devPort}${
          logTail ? ` (${logTail})` : ''
        }`;
        clearDevServerPid(hostDir, entryName);
      }
    }

    const failed = results.filter((item) => !item.ok);
    const ok = results.length - failed.length;
    const status: StepRunStatus = failed.length === 0 ? 'success' : 'failed';
    if (portAllocatedNow && ok === 0) {
      deps.db
        .update(issues)
        .set({ dev_server_port: null })
        .where(eq(issues.id, input.issueId))
        .run();
      releaseIssueDevPorts(input.issueId);
    }
    await finishDevopsSession(deps.db, deps, handle, {
      issueId: input.issueId,
      status,
      summary: `DevOps: ${ok}/${results.length} репозиториев`,
      feedback:
        failed.length > 0
          ? failed.map((item) => `${item.repo}: ${item.error}`).join('; ')
          : null,
    });
    console.log(
      `devops agent finished: issue=${input.issueId} status=${status} durationMs=${Date.now() - startedAt}`,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await finishDevopsSession(deps.db, deps, handle, {
      issueId: input.issueId,
      status: 'failed',
      summary: `DevOps прерван: ${message}`,
      feedback: message,
    });
    console.error('devops agent failed', {
      issueId: input.issueId,
      durationMs: Date.now() - startedAt,
      error,
    });
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
const ARCHIVED_REPORT_FILES = [...REPORT_ARTIFACTS, 'report.json'] as const;
const AUTHORED_REPORT_FILES = ['report.md', 'report.json'] as const;

export interface ReportArchiveResult {
  dir: string | null;
  files: string[];
}

export function archiveReportSession(
  issueId: string,
  sessionId: string,
  targetDir: string,
): string[] {
  const dir = issueSessionDir(issueId);
  if (!dir || !existsSync(dir)) return [];
  const files = readdirSync(dir).filter((name) => name.includes(sessionId));
  if (files.length === 0) return [];
  mkdirSync(targetDir, { recursive: true });
  for (const name of files) {
    copyFileSync(join(dir, name), join(targetDir, name));
    rmSync(join(dir, name), { force: true });
  }
  return files;
}

export function archiveReportArtifacts(
  workspaceRoot: string | undefined,
  issueId: string,
): ReportArchiveResult {
  const wsRoot = workspaceRoot ?? DEFAULT_WORKSPACE_ROOT;
  const issueDir = workspaceHostDirFor(wsRoot, issueId);
  const files = ARCHIVED_REPORT_FILES.filter((name) =>
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

export async function rebuildReportPage(
  issueId: string,
  hostDir: string,
): Promise<{ ok: boolean; warnings: string[]; embed: string }> {
  const rendered = await renderReportArtifacts(hostDir).catch(
    (error: unknown) => ({
      ok: false,
      html: false,
      warnings: [`report page failed: ${String(error)}`],
    }),
  );
  const embedded = rendered.html
    ? await embedReportScreenshots(hostDir).catch((error: unknown) => ({
        ok: false,
        summary: `embed failed: ${String(error)}`,
      }))
    : { ok: true, summary: 'skipped: no page' };
  const warnings = [
    ...rendered.warnings,
    ...(embedded.ok ? [] : [`скриншоты не вшиты: ${embedded.summary}`]),
  ];
  reportWarnings.set(issueId, warnings);
  return { ok: rendered.html, warnings, embed: embedded.summary };
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
  const staleSessions = (() => {
    try {
      return archiveReportSession(
        input.issueId,
        reportRunId,
        join(
          workspaceHostDirFor(
            deps.workspaceRoot ?? DEFAULT_WORKSPACE_ROOT,
            input.issueId,
          ),
          'reports',
          new Date(startedAt).toISOString(),
          'session',
        ),
      );
    } catch (error) {
      console.error('report session archive failed', {
        issueId: input.issueId,
        error,
      });
      return [];
    }
  })();
  console.log(
    `report agent started: issue=${input.issueId} trigger=${input.trigger ?? 'unknown'}${input.origin ? ` origin=${input.origin}` : ''} archived=${archive.dir ?? 'none'} files=[${archive.files.join(', ')}] sessionReset=[${staleSessions.join(', ')}] at=${new Date(startedAt).toISOString()}`,
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
    const rebuilt = await rebuildReportPage(input.issueId, input.hostDir);
    const rendered = { html: rebuilt.ok, warnings: rebuilt.warnings };
    if (rebuilt.warnings.some((warning) => warning.startsWith('скриншоты'))) {
      console.warn('report screenshots failed', {
        issueId: input.issueId,
        summary: rebuilt.embed,
      });
    }
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
      const preferredPort = issueRow.dev_server_port ?? undefined;
      const port =
        preferredPort !== undefined &&
        (await reserveDevPort(input.issue.id, preferredPort))
          ? preferredPort
          : await allocateDevPort(input.issue.id);
      const workspaceDir = workspaceHostDirFor(
        deps.workspaceRoot ?? DEFAULT_WORKSPACE_ROOT,
        input.issue.id,
      );
      const pid = startRepoDevServer(
        workspaceDir,
        extractRepoNameFromUrl(devRepo.repository_url),
        port,
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