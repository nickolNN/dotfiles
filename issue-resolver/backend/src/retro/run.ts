import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { RetroRunStatus } from '@issue-resolver/shared';
import type { SessionEvent, SessionStats } from '@issue-resolver/shared';
import { getRetroRun, updateRetroRun } from '../db/retro-runs.repo';
import type { PiRunOptions } from '../pi/runner';
import { capSessionEvents } from '../pi/session-events-cap';
import { soloRunExcludeTools } from '../pi/tool-policy';
import { markRetroRunActive, markRetroRunDone } from './active-runs';
import {
  DEFAULT_RETRO_SESSION_LIMIT,
  RETRO_REPO_ROOT,
  RETRO_SCOPE_ID,
  retroReportPath,
  retroSessionsRoot,
  retroTimeoutMs,
} from './config';
import {
  publishLog,
  publishSessionEvent,
  publishStatus,
} from './events';
import { messageOf, readReport, reportErrorText } from './outcome';
import { loadRetroPrompt } from './prompt';
import type { RetroRunDeps, RunRetroSessionResult } from './types';
import { SSEStream } from '@issue-resolver/shared';

function effectiveDeps(deps: RetroRunDeps, runId: string): RetroRunDeps {
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
  return effective;
}

function runOptionsFor(
  deps: RetroRunDeps,
  runId: string,
  sink: {
    appendStdout: (chunk: string) => void;
    appendStderr: (chunk: string) => void;
    appendEvent: (event: SessionEvent) => void;
  },
): PiRunOptions {
  const model = deps.model;
  const thinking = deps.thinkingLevel;
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
      sink.appendStdout(chunk);
      publishLog(deps, runId, SSEStream.stdout, chunk);
    },
    onStderr: (chunk) => {
      sink.appendStderr(chunk);
      publishLog(deps, runId, SSEStream.stderr, chunk);
    },
    onEvent: (event) => {
      sink.appendEvent(event);
      publishSessionEvent(deps, runId, event);
    },
  };
  if (model) runOptions.model = model;
  if (thinking) runOptions.thinkingLevel = thinking;
  if (deps.registry) runOptions.registry = deps.registry;
  return runOptions;
}

export async function runRetroSession(
  deps: RetroRunDeps,
  runId: string,
): Promise<RunRetroSessionResult> {
  const reportPath = retroReportPath(runId);
  rmSync(reportPath, { force: true });
  markRetroRunActive(runId);
  publishStatus(deps, runId, RetroRunStatus.running);

  let stdout = '';
  let stderr = '';
  const events: SessionEvent[] = [];
  let stats: SessionStats | null = null;

  try {
    const effective = effectiveDeps(deps, runId);
    const prompt = loadRetroPrompt(effective, reportPath);
    const runOptions = runOptionsFor(effective, runId, {
      appendStdout: (chunk) => {
        stdout += chunk;
      },
      appendStderr: (chunk) => {
        stderr += chunk;
      },
      appendEvent: (event) => {
        events.push(event);
      },
    });
    const result = await deps.pi.run(RETRO_SCOPE_ID, prompt, runOptions);
    stats = result.stats ?? null;

    const finalStderr = stderr || result.stderr;
    const report = readReport(reportPath);
    const aborted = result.aborted === true;
    const failed = aborted || result.exitCode !== 0 || report === null;
    updateRetroRun(deps.db, runId, {
      status: failed ? RetroRunStatus.failed : RetroRunStatus.success,
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
      status: RetroRunStatus.failed,
      error: messageOf(error),
      stdout,
      stderr,
      events: capSessionEvents(events),
      stats,
    });
  } finally {
    markRetroRunDone(runId);
    rmSync(reportPath, { force: true });
  }

  const run = getRetroRun(deps.db, runId);
  const status: RetroRunStatus = run?.status ?? RetroRunStatus.failed;
  publishStatus(deps, runId, status);
  return { status, report: run?.report ?? null, error: run?.error ?? null };
}