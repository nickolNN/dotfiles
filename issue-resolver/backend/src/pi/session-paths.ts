import { homedir } from 'node:os';
import path from 'node:path';

export function issueSessionDir(issueId: string): string | undefined {
  const mode = process.env.PI_STEP_SESSION_DIR?.trim().toLowerCase();
  if (mode === 'off' || mode === '0' || mode === 'false') return undefined;
  if (issueId.trim().length === 0) return undefined;
  return path.posix.join(sessionsRoot(), `issue-${issueId}`);
}

function sessionsRoot(): string {
  const explicit = process.env.PI_SESSION_DIR?.trim();
  if (explicit) return explicit;
  const configDir =
    process.env.PI_CODING_AGENT_DIR?.trim() ||
    path.join(homedir(), '.pi', 'agent');
  return path.posix.join(configDir, 'sessions');
}

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
