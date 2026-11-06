import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderPlaceholders } from '../../prompt-render';

const PROMPTS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', 'prompts');

const _cache = new Map<string, { mtimeMs: number; size: number; body: string }>();

export function readPrompt(filename: string): string {
  const path = join(PROMPTS_DIR, filename);
  const { mtimeMs, size } = statSync(path);
  const cached = _cache.get(filename);
  if (cached !== undefined && cached.mtimeMs === mtimeMs && cached.size === size) {
    return cached.body;
  }
  const raw = readFileSync(path, 'utf-8');
  const body = raw.replace(/^#\s+Prompt:.*\n\n?/, '');
  _cache.set(filename, { mtimeMs, size, body });
  return body;
}

const PR_SKILL_PATHS = [join(homedir(), '.agents', 'skills', 'pr', 'SKILL.md')];

export function prSkillBlock(): string {
  for (const path of PR_SKILL_PATHS) {
    if (!existsSync(path)) continue;
    return readFileSync(path, 'utf-8')
      .replace(/^---\n[\s\S]*?\n---\n?/, '')
      .trim();
  }
  return '';
}

export function render(template: string, values: Record<string, string>): string {
  return renderPlaceholders(template, values)
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}