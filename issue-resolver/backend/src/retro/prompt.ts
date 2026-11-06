import { readFileSync } from 'node:fs';
import { dbPathFromEnv } from '../db/client';
import { renderPlaceholders } from '../prompt-render';
import {
  DEFAULT_RETRO_PROMPT_PATH,
  DEFAULT_RETRO_SESSION_LIMIT,
  RETRO_REPO_ROOT,
  retroMemoryDir,
  retroPromptDate,
  retroSessionsRoot,
  retroSkillPath,
  retroWritingSkillPath,
} from './config';
import type { RetroRunDeps } from './types';

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
  return renderPlaceholders(template, values);
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