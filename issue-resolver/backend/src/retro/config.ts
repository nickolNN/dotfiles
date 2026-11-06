import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));

export const RETRO_REPO_ROOT = join(MODULE_DIR, '..', '..', '..');

export const DEFAULT_RETRO_PROMPT_PATH = join(
  RETRO_REPO_ROOT,
  'prompts',
  'retro.md',
);

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
  return Number.isFinite(parsed) && parsed > 0
    ? parsed
    : DEFAULT_RETRO_TIMEOUT_MS;
}

export function retroReportPath(runId: string): string {
  return join(tmpdir(), `issue-retro-${runId}.md`);
}

export function retroPromptDate(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}