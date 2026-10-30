import { readFileSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  RetroRunStatus,
  SessionEvent,
  SessionStats,
  SSEEvent,
  ThinkingLevel,
} from '@issue-resolver/shared';
import type { Db } from '../db/client';
import { dbPathFromEnv } from '../db/client';
import { getRetroRun, updateRetroRun } from '../db/retro-runs.repo';
import type { PiRunOptions, PiRunner } from '../pi/runner';
import type { StepSessionRegistry } from '../pi/session-registry';
import { capSessionEvents } from '../pi/session-events-cap';
import { soloRunExcludeTools } from '../pi/tool-policy';
import type { SseHub } from '../sse/hub';

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));

export const RETRO_REPO_ROOT = join(MODULE_DIR, '..', '..', '..');

export const DEFAULT_RETRO_PROMPT_PATH = join(
  RETRO_REPO_ROOT,
  'prompts',
  'retro.md',
);

/** SSE scope id for maintenance runs; no issue is involved (`__global__` precedent). */
export const RETRO_SCOPE_ID = '__settings__';

export const DEFAULT_RETRO_TIMEOUT_MS = 20 * 60 * 1000;

export const DEFAULT_RETRO_SESSION_LIMIT = 10;

function envPath(
  env: NodeJS.ProcessEnv,
  key: string,
  fallback: string,
): string {
  const explicit = env[key]?.trim();
  return explicit ? explicit : fallback;
}

export function retroMemoryDir(env: NodeJS.ProcessEnv = process.env): string {
  return envPath(
    env,
    'PI_MEMORY_DIR',
    join(homedir(), '.pi', 'agent', 'memory'),
  );
}

export function retroSessionsRoot(
  env: NodeJS.ProcessEnv = process.env,
): string {
  return envPath(
    env,
    'PI_SESSION_DIR',
    join(
      envPath(env, 'PI_CODING_AGENT_DIR', join(homedir(), '.pi', 'agent')),
      'sessions',
    ),
  );
}

export function retroSkillPath(env: NodeJS.ProcessEnv = process.env): string {
  return envPath(
    env,
    'RETRO_SKILL_PATH',
    join(homedir(), '.agents', 'skills', 'retro', 'SKILL.md'),
  );
}

export function retroWritingSkillPath(
  env: NodeJS.ProcessEnv = process.env,
): string {
  return envPath(
    env,
    'RETRO_WRITING_SKILL_PATH',
    join(homedir(), '.agents', 'skills', 'writing-for-agents', 'SKILL.md'),
  );
}

export function retroTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const parsed = Number(env.RETRO_TIMEOUT_MS);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_RETRO_TIMEOUT_MS;
}

/** Kept outside the repository: the run row already stores the report. */
export function retroReportPath(runId: string): string {
  return join(tmpdir(), `issue-retro-${runId}.md`);
}

export function retroPromptDate(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

const PLACEHOLDERS = [
  'REPO_DIR',
  'MEMORY_DIR',
  'SESSIONS_DIR',
  'DB_PATH',
  'RETRO_SKILL',
  'WRITING_SKILL',
  'REPORT_FILE',
  'DATE',
  'SESSION_LIMIT',
  'EXTRA_INSTRUCTIONS',
] as const;

export type RetroPromptKey = (typeof PLACEHOLDERS)[number];

export type RetroPromptValues = Record<RetroPromptKey, string>;

export function renderRetroPrompt(
  template: string,
  values: RetroPromptValues,
): string {
  return PLACEHOLDERS.reduce(
    (text, key) => text.replaceAll(`{{${key}}}`, values[key]),
    template,
  );
}

export interface RetroRunDeps {
  db: Db;
  pi: PiRunner;
  sse?: SseHub;
  repoRoot?: string;
  promptPath?: string;
  memoryDir?: string;
  sessionsDir?: string;
  dbPath?: string;
  retroSkillPath?: string;
  writingSkillPath?: string;
  sessionLimit?: number;
  timeoutMs?: number;
  /** Session registry: registering the run makes it abortable via the settings page. */
  registry?: StepSessionRegistry;
  /** Per-run overrides coming from the settings modal. */
  model?: string;
  thinkingLevel?: ThinkingLevel;
  extraInstructions?: string;
}

function extraInstructionsBlock(text: string | undefined): string {
  const trimmed = text?.trim();
  if (!trimmed) return '';
  return `## Extra instructions from the operator\n\n${trimmed}\n`;
}

export function retroPromptValues(
  deps: RetroRunDeps,
  reportPath: string,
  now: Date = new Date(),
): RetroPromptValues {
  return {
    REPO_DIR: deps.repoRoot ?? RETRO_REPO_ROOT,
    MEMORY_DIR: deps.memoryDir ?? retroMemoryDir(),
    SESSIONS_DIR: deps.sessionsDir ?? retroSessionsRoot(),
    DB_PATH: deps.dbPath ?? dbPathFromEnv(process.env),
    RETRO_SKILL: deps.retroSkillPath ?? retroSkillPath(),
    WRITING_SKILL: deps.writingSkillPath ?? retroWritingSkillPath(),
    REPORT_FILE: reportPath,
    DATE: retroPromptDate(now),
    SESSION_LIMIT: String(deps.sessionLimit ?? DEFAULT_RETRO_SESSION_LIMIT),
    EXTRA_INSTRUCTIONS: extraInstructionsBlock(deps.extraInstructions),
  };
}

export function loadRetroPrompt(
  deps: RetroRunDeps,
  reportPath: string,
): string {
  const promptPath = deps.promptPath ?? DEFAULT_RETRO_PROMPT_PATH;
  const template = readFileSync(promptPath, 'utf8');
  return renderRetroPrompt(template, retroPromptValues(deps, reportPath));
}

const activeRetroRuns = new Set<string>();

export function activeRetroRunId(): string | null {
  const first = activeRetroRuns.values().next();
  return first.done ? null : first.value;
}

export function isRetroRunActive(runId: string): boolean {
  return activeRetroRuns.has(runId);
}

export type AbortRetroResult = 'aborted' | 'not_running' | 'unavailable';

/** Stops the running session; the run is marked failed by its own handler. */
export function abortRetroRun(
  deps: RetroRunDeps,
  runId: string,
): AbortRetroResult {
  if (!activeRetroRuns.has(runId)) return 'not_running';
  if (!deps.registry) return 'unavailable';
  return deps.registry.abort(runId) ? 'aborted' : 'unavailable';
}

function publish(
  deps: RetroRunDeps,
  runId: string,
  event: Pick<SSEEvent, 'type' | 'data' | 'stream'>,
): void {
  deps.sse?.publish({
    type: event.type,
    issueId: RETRO_SCOPE_ID,
    stepRunId: runId,
    ...(event.stream ? { stream: event.stream } : {}),
    data: event.data,
    ts: new Date().toISOString(),
  });
}

function publishStatus(
  deps: RetroRunDeps,
  runId: string,
  status: RetroRunStatus,
): void {
  publish(deps, runId, {
    type: 'step_status',
    data: JSON.stringify({ status, step: 'retro' }),
  });
}

function publishLog(
  deps: RetroRunDeps,
  runId: string,
  stream: 'stdout' | 'stderr',
  chunk: string,
): void {
  if (!chunk) return;
  publish(deps, runId, { type: 'log', stream, data: chunk });
}

function publishSessionEvent(
  deps: RetroRunDeps,
  runId: string,
  event: SessionEvent,
): void {
  publish(deps, runId, {
    type: 'step_event',
    data: JSON.stringify({ stepRunId: runId, event }),
  });
}

function readReport(path: string): string | null {
  try {
    const text = readFileSync(path, 'utf8').trim();
    return text.length > 0 ? text : null;
  } catch {
    return null;
  }
}

function failureText(exitCode: number, stderr: string): string {
  const tail = stderr.trim().split('\n').slice(-3).join(' ').trim();
  const code = `агент завершился с кодом ${exitCode}`;
  if (!tail) return code;
  return `${code}: ${tail}`;
}

function reportErrorText(
  exitCode: number,
  stderr: string,
  hasReport: boolean,
  aborted = false,
): string | null {
  if (aborted) return 'прогон остановлен оператором';
  if (exitCode !== 0) return failureText(exitCode, stderr);
  if (!hasReport) return 'агент завершился без отчёта: файл отчёта не создан';
  return null;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface RunRetroSessionResult {
  status: RetroRunStatus;
  report: string | null;
  error: string | null;
}

/**
 * Runs one maintenance session: memory compaction plus retro. Session events go
 * to the global SSE stream under `stepRunId = runId`; the outcome is persisted
 * in `retro_runs` and returned.
 */
export async function runRetroSession(
  deps: RetroRunDeps,
  runId: string,
): Promise<RunRetroSessionResult> {
  const reportPath = retroReportPath(runId);
  rmSync(reportPath, { force: true });
  activeRetroRuns.add(runId);
  publishStatus(deps, runId, 'running');

  let stdout = '';
  let stderr = '';
  const events: SessionEvent[] = [];
  let stats: SessionStats | null = null;

  try {
    const stored = getRetroRun(deps.db, runId);
    const effective: RetroRunDeps = {
      ...deps,
      sessionLimit:
        deps.sessionLimit ??
        stored?.session_limit ??
        DEFAULT_RETRO_SESSION_LIMIT,
    };
    const model = deps.model ?? stored?.model ?? undefined;
    if (model) effective.model = model;
    const thinking = deps.thinkingLevel ?? stored?.thinking_level ?? undefined;
    if (thinking) effective.thinkingLevel = thinking;
    const extra = deps.extraInstructions ?? stored?.instructions ?? undefined;
    if (extra) effective.extraInstructions = extra;
    const prompt = loadRetroPrompt(effective, reportPath);
    const runOptions: PiRunOptions = {
      cwd: deps.repoRoot ?? RETRO_REPO_ROOT,
      sessionId: runId,
      stepRunId: runId,
      iterationId: runId,
      sessionDir: join(deps.sessionsDir ?? retroSessionsRoot(), 'retro'),
      sessionName: `retro · ${runId.slice(0, 8)}`,
      timeoutMs: deps.timeoutMs ?? retroTimeoutMs(),
      excludeTools: soloRunExcludeTools(),
      onStdout: (chunk) => {
        stdout += chunk;
        publishLog(deps, runId, 'stdout', chunk);
      },
      onStderr: (chunk) => {
        stderr += chunk;
        publishLog(deps, runId, 'stderr', chunk);
      },
      onEvent: (event) => {
        events.push(event);
        publishSessionEvent(deps, runId, event);
      },
    };
    if (model) runOptions.model = model;
    if (thinking) runOptions.thinkingLevel = thinking;
    if (deps.registry) runOptions.registry = deps.registry;
    const result = await deps.pi.run(RETRO_SCOPE_ID, prompt, runOptions);
    stats = result.stats ?? null;

    const finalStderr = stderr || result.stderr;
    const report = readReport(reportPath);
    const aborted = result.aborted === true;
    const failed = aborted || result.exitCode !== 0 || report === null;
    updateRetroRun(deps.db, runId, {
      status: failed ? 'failed' : 'success',
      report,
      error: reportErrorText(
        result.exitCode,
        finalStderr,
        report !== null,
        aborted,
      ),
      stdout,
      stderr: finalStderr,
      events: capSessionEvents(events),
      stats,
    });
  } catch (error) {
    updateRetroRun(deps.db, runId, {
      status: 'failed',
      error: messageOf(error),
      stdout,
      stderr,
      events: capSessionEvents(events),
      stats,
    });
  } finally {
    activeRetroRuns.delete(runId);
    rmSync(reportPath, { force: true });
  }

  const run = getRetroRun(deps.db, runId);
  const status: RetroRunStatus = run?.status ?? 'failed';
  publishStatus(deps, runId, status);
  return { status, report: run?.report ?? null, error: run?.error ?? null };
}