import { homedir } from 'node:os';
import path from 'node:path';

/**
 * Where a step's Pi sessions are stored.
 *
 * Pi keys its session directory by the working directory of the agent, which for
 * us is a hashed workspace path — unreadable in listings and awkward to clean up.
 * Pointing `--session-dir` at `sessions/issue-<id>` groups a task's sessions
 * under its own directory, so deleting an issue's workspace removes its sessions
 * with it.
 *
 * Disable with `PI_STEP_SESSION_DIR=off` (falls back to Pi's own layout).
 */
export function issueSessionDir(issueId: string): string | undefined {
  const mode = process.env.PI_STEP_SESSION_DIR?.trim().toLowerCase();
  if (mode === 'off' || mode === '0' || mode === 'false') return undefined;
  if (issueId.trim().length === 0) return undefined;
  return path.posix.join(sessionsRoot(), `issue-${issueId}`);
}

/** Pi's configured sessions root, honouring `PI_CODING_AGENT_DIR`. */
function sessionsRoot(): string {
  const explicit = process.env.PI_SESSION_DIR?.trim();
  if (explicit) return explicit;
  const configDir =
    process.env.PI_CODING_AGENT_DIR?.trim() ||
    path.join(homedir(), '.pi', 'agent');
  return path.posix.join(configDir, 'sessions');
}

/**
 * Display name for a session (`--name`): what the run is, in the words the team
 * already uses, so listings do not show a bare uuid.
 */
export function sessionDisplayName(params: {
  step: string;
  issueId: string;
  attempt?: number;
  suffix?: string;
}): string {
  const short = params.issueId.slice(0, 8);
  const attempt = params.attempt !== undefined ? ` · try ${params.attempt}` : '';
  const suffix = params.suffix ? ` · ${params.suffix}` : '';
  return `${params.step} · ${short}${attempt}${suffix}`;
}
