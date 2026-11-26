#!/usr/bin/env node
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const SESSIONS = process.env.PI_SESSIONS_DIR ?? '/home/agent/.pi/agent/sessions';

const LENS_TOOLS = new Set([
  'symbol_search',
  'read_symbol',
  'read_enclosing',
  'module_report',
  'project_report',
  'lsp_navigation',
  'lens_diagnostics',
  'ast_grep_search',
  'ast_grep_replace',
  'ast_grep_outline',
]);

const SKILL_PATH = /skills\/([^/]+)\/SKILL\.md/;
const SKILL_TOOL = 'skill';
const NESTED_SKILL =
  /(?:tools\.skill|tools\[["']skill["']\])\s*\(\s*\{\s*id:\s*["']([^"']+)["']/g;

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : (process.argv[index + 1] ?? fallback);
}

const days = Number(arg('days', '1'));
const since = Date.parse(arg('since', '')) || Date.now() - days * 86_400_000;

function files(directory, found = []) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files(path, found);
    else if (entry.name.endsWith('.jsonl')) found.push(path);
  }
  return found;
}

function records(path) {
  const lines = readFileSync(path, 'utf8').split('\n').filter(Boolean);
  const parsed = [];
  for (const line of lines) {
    try {
      parsed.push(JSON.parse(line));
    } catch {}
  }
  return parsed;
}

function userText(record) {
  const message = record.message;
  if (message?.role !== 'user') return '';
  if (typeof message.content === 'string') return message.content;
  return (message.content ?? [])
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join(' ');
}

const steps = new Map();

for (const path of files(SESSIONS)) {
  const stat = statSync(path);
  if (stat.mtimeMs < since) continue;
  const parsed = records(path);
  const first = parsed[0] ?? {};
  if (Date.parse(first.timestamp ?? '') < since) continue;
  const text = parsed.map(userText).find((body) => body.includes('Pipeline step: '));
  const step = text?.match(/Pipeline step: (\w+)/)?.[1];
  if (step === undefined) continue;

  const state = {
    sessions: 0,
    tools: 0,
    skills: new Set(),
    calls: 0,
    invoked: new Set(),
    lens: 0,
    agentBrowser: 0,
  };
  for (const record of parsed) {
    const message = record.message;
    if (message?.role !== 'assistant') continue;
    for (const part of message.content ?? []) {
      if (part.type !== 'toolCall') continue;
      state.tools += 1;
      const args = part.arguments ?? {};
      const blob = JSON.stringify(args);
      const target = String(args.path ?? args.file_path ?? args.filePath ?? '');
      const skill = target.match(SKILL_PATH);
      if (skill && ['read', 'write', 'edit'].includes(part.name)) {
        state.skills.add(skill[1]);
      }
      if (LENS_TOOLS.has(part.name)) state.lens += 1;
      if (part.name === SKILL_TOOL) {
        state.calls += 1;
        state.invoked.add(String(args.id ?? '?'));
      }
      if (part.name === 'codemode') {
        for (const nested of String(args.code ?? '').matchAll(NESTED_SKILL)) {
          state.calls += 1;
          state.invoked.add(nested[1]);
        }
      }
      if (/agent-browser skills|skills get /.test(blob)) state.agentBrowser += 1;
    }
  }
  state.sessions = 1;

  const total = steps.get(step) ?? {
    sessions: 0,
    tools: 0,
    skills: new Set(),
    calls: 0,
    invoked: new Set(),
    lens: 0,
    agentBrowser: 0,
    opened: 0,
  };
  total.sessions += 1;
  total.tools += state.tools;
  total.lens += state.lens;
  total.calls += state.calls;
  total.agentBrowser += state.agentBrowser;
  total.opened += state.skills.size > 0 ? 1 : 0;
  const called = state.calls > 0 ? 1 : 0;
  total.called = (total.called ?? 0) + called;
  for (const name of state.skills) total.skills.add(name);
  for (const name of state.invoked) total.invoked.add(name);
  steps.set(step, total);
}

const sinceLabel = new Date(since).toISOString().slice(0, 16).replace('T', ' ');
console.log(`sessions since ${sinceLabel}\n`);
console.log(
  ['step'.padEnd(9), 'sess', 'tools', 'read', 'calls', 'lens', 'browser', 'skills'].join(
    '\t',
  ),
);
for (const [step, state] of [...steps].sort()) {
  const skills = [...state.invoked, ...state.skills].filter((name, i, all) => all.indexOf(name) === i).join(',') || '-';
  console.log(
    [
      step.padEnd(9),
      state.sessions,
      state.tools,
      `${state.opened}/${state.sessions}`,
      `${state.calls}/${state.called ?? 0}`,
      state.lens,
      state.agentBrowser,
      skills,
    ].join('\t'),
  );
}
const all = [...steps.values()];
const sum = (key) => all.reduce((acc, state) => acc + state[key], 0);
console.log(
  `\ntotal: ${sum('sessions')} sessions, ${sum('opened')} opened a skill file, ` +
    `${sum('calls')} skill tool calls in ${sum('called')} sessions, ` +
    `${sum('lens')} lens calls, ${sum('agentBrowser')} agent-browser skill lookups`,
);