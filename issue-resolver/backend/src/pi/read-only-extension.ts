const EXECUTING_COMMANDS = new Set([
  'npm',
  'pnpm',
  'pnpx',
  'yarn',
  'yarnpkg',
  'bun',
  'bunx',
  'npx',
  'corepack',
  'deno',
  'node',
  'nodejs',
  'tsx',
  'ts-node',
  'tsc',
  'vite',
  'vitest',
  'jest',
  'mocha',
  'ava',
  'tap',
  'playwright',
  'cypress',
  'eslint',
  'stylelint',
  'prettier',
  'biome',
  'oxlint',
  'webpack',
  'rollup',
  'esbuild',
  'swc',
  'turbo',
  'nx',
  'lerna',
  'make',
  'cmake',
  'ninja',
  'gradle',
  'gradlew',
  'mvn',
  'go',
  'cargo',
  'rustc',
  'dotnet',
  'java',
  'javac',
  'gcc',
  'cc',
  'clang',
  'python',
  'python3',
  'pip',
  'pip3',
  'poetry',
  'uv',
  'pytest',
  'tox',
  'ruby',
  'bundle',
  'bundler',
  'rake',
  'rspec',
  'gem',
  'php',
  'composer',
  'phpunit',
  'bash',
  'sh',
  'zsh',
  'dash',
  'fish',
  'eval',
  'source',
  'sudo',
  'su',
  'docker',
  'podman',
  'docker-compose',
  'kubectl',
  'helm',
  'agent-browser',
  'chromium',
  'chromium-browser',
  'google-chrome',
  'firefox',
  'curl',
  'wget',
  'rm',
  'mv',
  'cp',
  'install',
  'touch',
  'mkdir',
  'rmdir',
  'chmod',
  'chown',
  'ln',
  'tee',
  'truncate',
  'dd',
  'xargs',
  'sleep',
]);

const GIT_MUTATING = new Set([
  'add',
  'am',
  'apply',
  'bisect',
  'checkout',
  'cherry-pick',
  'clean',
  'clone',
  'commit',
  'config',
  'fetch',
  'filter-branch',
  'gc',
  'init',
  'merge',
  'mv',
  'notes',
  'prune',
  'pull',
  'push',
  'rebase',
  'reset',
  'restore',
  'revert',
  'rm',
  'stash',
  'submodule',
  'switch',
  'tag',
  'update-ref',
  'worktree',
]);

const GIT_INJECTION_ARGS = ['-c', '--config-env', '--exec-path'];

const WRAPPERS = new Set([
  'sudo',
  'nohup',
  'env',
  'command',
  'builtin',
  'time',
  'nice',
  'ionice',
  'stdbuf',
]);

const DURATION_WRAPPERS = new Set(['timeout']);

const INSPECTORS = new Set([
  'awk',
  'basename',
  'cat',
  'cmp',
  'column',
  'cut',
  'diff',
  'dirname',
  'du',
  'file',
  'find',
  'git',
  'grep',
  'head',
  'jq',
  'ls',
  'nl',
  'od',
  'readlink',
  'realpath',
  'rg',
  'sed',
  'sort',
  'stat',
  'tail',
  'tr',
  'tree',
  'uniq',
  'wc',
  'xxd',
]);

const LINT_RUNNERS = new Set([
  'eslint',
  'stylelint',
  'prettier',
  'biome',
  'oxlint',
  'dprint',
  'markdownlint',
  'markdownlint-cli2',
  'ruff',
  'flake8',
  'pylint',
  'mypy',
  'pyright',
  'tsc',
  'golangci-lint',
  'rubocop',
  'shellcheck',
  'hadolint',
  'yamllint',
  'phpcs',
]);

const PACKAGE_RUNNERS = new Set([
  'npm',
  'pnpm',
  'pnpx',
  'yarn',
  'yarnpkg',
  'bun',
  'bunx',
  'npx',
]);

const RUN_SUBCOMMANDS = new Set(['run', 'run-script', 'exec']);

const MUTATING_LINT_ARG = /^--(fix|write|apply|update)(=|$)|^-w$|^--fmt$|^fmt$/;

const SUBSTITUTION = /\$\(|<\(|>\(|`/;

const REDIRECTION = /(>>?)\s*([^\s;&|]+)/g;

const HARMLESS_TARGET = /^\/dev\/(null|stdout|stderr|fd\/\d+)$/;

const EXECUTING_TOOL_NAMES = new Set(['ast_grep_replace', 'agent-browser']);

const EXECUTING_TOOL_PATTERNS = [
  /^browser/i,
  /chrome_devtools/i,
  /playwright/i,
  /puppeteer/i,
  /__browser/i,
];

export interface ToolCallLike {
  toolName: string;
  input?: unknown;
}

export interface BlockDecision {
  block: true;
  reason: string;
}

export interface ReadOnlyPi {
  on(
    event: 'tool_call',
    handler: (event: ToolCallLike) => BlockDecision | undefined,
  ): void;
}

interface Command {
  name: string;
  args: string[];
  text: string;
  path: string | null;
}

type Verdict = string | null | undefined;

function commandOf(segment: string): Command | null {
  let words = segment.trim().split(/\s+/).filter(Boolean);
  for (;;) {
    while (words.length > 0 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0] ?? '')) {
      words = words.slice(1);
    }
    if (words.length === 0) return null;
    const head = (words[0] ?? '').replace(/^[({!]+/, '');
    if (DURATION_WRAPPERS.has(head) && words.length > 1) {
      words = words.slice(2);
      continue;
    }
    if (WRAPPERS.has(head)) {
      words = words.slice(1);
      continue;
    }
    return {
      name: head.split('/').pop() ?? head,
      args: words.slice(1),
      text: words.join(' '),
      path: head.includes('/') ? head : null,
    };
  }
}

function clip(text: string): string {
  return text.length > 70 ? `${text.slice(0, 70)}…` : text;
}

function gitRule(command: Command): Verdict {
  if (command.name !== 'git') return undefined;
  const injects = command.args.some(
    (arg) =>
      arg.startsWith('!') ||
      GIT_INJECTION_ARGS.some(
        (flag) => arg === flag || arg.startsWith(`${flag}=`),
      ),
  );
  if (injects) return 'git config injection';
  const sub = command.args.find((arg) => !arg.startsWith('-'));
  if (sub === undefined) return null;
  if (GIT_MUTATING.has(sub)) return `git ${sub}`;
  const namesBranch = command.args.some(
    (arg) => !arg.startsWith('-') && arg !== 'branch',
  );
  if (sub === 'branch' && namesBranch) return 'git branch <name>';
  return null;
}

function pathRule(command: Command): Verdict {
  if (command.path === null) return undefined;
  if (INSPECTORS.has(command.name) || LINT_RUNNERS.has(command.name)) {
    return undefined;
  }
  return `script ${clip(command.text)}`;
}

function lintInvocation(command: Command): { name: string; args: string[] } | null {
  if (LINT_RUNNERS.has(command.name)) {
    return { name: command.name, args: command.args };
  }
  if (!PACKAGE_RUNNERS.has(command.name)) return null;
  const plain = command.args
    .map((arg, index) => ({ arg, index }))
    .filter(({ arg }) => !arg.startsWith('-'));
  const first = plain[0];
  if (first === undefined) return null;
  const target = RUN_SUBCOMMANDS.has(first.arg) ? plain[1] : first;
  if (target === undefined || !LINT_RUNNERS.has(target.arg)) return null;
  return { name: target.arg, args: command.args.slice(target.index + 1) };
}

function lintRule(command: Command): Verdict {
  const target = lintInvocation(command);
  if (target === null) return undefined;
  const mutating = command.args.find((arg) => MUTATING_LINT_ARG.test(arg));
  if (mutating !== undefined) return `${command.name} ${mutating}`;
  if (target.name === 'tsc' && !target.args.includes('--noEmit')) {
    return 'tsc without --noEmit';
  }
  return null;
}

function sedRule(command: Command): Verdict {
  if (command.name !== 'sed') return undefined;
  const inPlace = command.args.some(
    (arg) =>
      arg === '-i' || arg.startsWith('--in-place') || /^-[a-zA-Z]*i/.test(arg),
  );
  return inPlace ? 'sed -i' : undefined;
}

function findRule(command: Command): Verdict {
  if (command.name !== 'find') return undefined;
  const executes = command.args.some(
    (arg) =>
      arg === '-exec' ||
      arg === '-execdir' ||
      arg === '-delete' ||
      arg === '-ok',
  );
  return executes ? 'find -exec' : undefined;
}

const BASH_RULES: Array<(command: Command) => Verdict> = [
  gitRule,
  pathRule,
  lintRule,
  sedRule,
  findRule,
];

function isHarmlessTarget(target: string): boolean {
  return target.startsWith('&') || HARMLESS_TARGET.test(target);
}

function redirectViolation(segment: string): string | null {
  const withoutSingleQuotes = segment.replace(/'[^']*'/g, "''");
  if (SUBSTITUTION.test(withoutSingleQuotes)) return 'command substitution';
  const withoutQuotes = withoutSingleQuotes.replace(/"[^"]*"/g, '""');
  for (const match of withoutQuotes.matchAll(REDIRECTION)) {
    const target = match[2] ?? '';
    if (!isHarmlessTarget(target)) return `write to ${target}`;
  }
  return null;
}

function segmentViolation(segment: string): string | null {
  const redirect = redirectViolation(segment);
  if (redirect !== null) return redirect;
  const command = commandOf(segment);
  if (command === null) return null;
  for (const rule of BASH_RULES) {
    const verdict = rule(command);
    if (verdict !== undefined) return verdict;
  }
  return EXECUTING_COMMANDS.has(command.name) ? clip(command.text) : null;
}

export function readOnlyViolation(command: string): string | null {
  for (const segment of command.split(/&&|\|\||[;|\n]/)) {
    const violation = segmentViolation(segment);
    if (violation !== null) return violation;
  }
  return null;
}

export function executingTool(toolName: string): boolean {
  if (EXECUTING_TOOL_NAMES.has(toolName)) return true;
  return EXECUTING_TOOL_PATTERNS.some((pattern) => pattern.test(toolName));
}

export default function readOnlyGuard(pi: ReadOnlyPi): void {
  pi.on('tool_call', (event) => {
    const tool = executingTool(event.toolName);
    if (tool) {
      return {
        block: true,
        reason:
          `review is read-only: the ${event.toolName} tool runs code and is ` +
          'blocked here. Name the scenario in `summary` for the `test` step.',
      };
    }
    if (event.toolName !== 'bash') return undefined;
    const input = event.input as { command?: unknown } | undefined;
    const command = typeof input?.command === 'string' ? input.command : '';
    const violation = readOnlyViolation(command);
    if (violation === null) return undefined;
    return {
      block: true,
      reason:
        `review is read-only: "${violation}" runs code and is blocked here. ` +
        'Nothing to run in this step — name the scenario in `summary` for the ' +
        '`test` step instead.',
    };
  });
}