import { PipelineStep } from '@issue-resolver/shared';
import { describe, expect, it, vi } from 'vitest';
import readOnlyGuard, {
  executingTool,
  readOnlyViolation,
  type BlockDecision,
  type ToolCallLike,
} from '../src/pi/read-only-extension';
import { readOnlyExtensionPath, sessionArgs } from '../src/pi/rpc-spawn';
import { readOnlyStep } from '../src/pi/tool-policy';

function decide(toolName: string, input?: unknown): BlockDecision | undefined {
  let handler: ((event: ToolCallLike) => BlockDecision | undefined) | undefined;
  readOnlyGuard({
    on: (_event, registered) => {
      handler = registered;
    },
  });
  if (handler === undefined) throw new Error('no tool_call handler registered');
  return handler({ toolName, input });
}

describe('read-only guard: код не исполняется', () => {
  it.each([
    'npx vitest run',
    'npx vitest run src/a.test.ts 2>&1 | tail -25',
    'npm run build',
    'pnpm test',
    'yarn build',
    'cd /repo && npx tsc --build',
    'timeout 120 npx vite build',
    'PORT=5100 npm run dev',
    'sudo npm ci',
    'bash pw-browsers.sh app',
    'sh -c "npx vitest"',
    'node -e "require(\'fs\').writeFileSync(\'x\', \'1\')"',
    'python3 -c "import json"',
    'make check',
    'docker compose up',
    'agent-browser open http://localhost:5100',
    'curl -s http://localhost:5100/',
    'git checkout -- src/app.ts',
    'git add -A',
    'git stash',
    'git branch review-fixes',
    'sed -i s/a/b/ src/app.ts',
    'find . -name "*.ts" -delete',
    'rm -rf build',
    'sleep 2',
  ])('блокирует %s', (command) => {
    expect(readOnlyViolation(command)).not.toBeNull();
  });
});

describe('read-only guard: обходы через шелл', () => {
  it.each([
    './scripts/check.sh',
    './run-tests',
    '/home/agent/workspace/repo/tools/lint.sh',
    'echo $(npx vitest run)',
    'echo `npx vite build`',
    'diff <(npx vitest run) /dev/null',
    'echo hi > src/app.ts',
    'echo hi >> src/app.ts',
    'cat foo > src/app.ts',
    'git -c alias.x=!npm run test x',
    'git --config-env=x=y status',
    'git --exec-path=/tmp status',
  ])('блокирует %s', (command) => {
    expect(readOnlyViolation(command)).not.toBeNull();
  });

  it.each([
    'git status --porcelain',
    'git diff origin/dev...HEAD -- src',
    'git log --oneline -6',
    'git show 1234abcd:src/app.ts',
    'git branch -a',
    'git blame src/app.ts',
    'cat src/app.ts',
    'grep -n ">" src/app.ts',
    'sed -n 120,260p src/app.ts',
    'rg -l "useEffect" src',
    'find src -name "*.tsx"',
    'ls -la 2>/dev/null',
    'wc -l src/app.ts',
    'jq .build scripts package.json',
    'head -40 iterations/1/.review.md',
    'grep -c "TODO" src/app.ts > /dev/null',
  ])('пропускает чтение: %s', (command) => {
    expect(readOnlyViolation(command)).toBeNull();
  });
});

describe('read-only guard: линтеры разрешены без записи', () => {
  it.each([
    'npx eslint src/app.ts',
    'eslint --no-cache src/app.ts src/lib.ts',
    'pnpm exec eslint src',
    'npx prettier --check src/app.ts',
    'prettier --check .',
    'biome check src',
    'stylelint "src/**/*.css"',
    'dprint check',
    'npx tsc --noEmit',
    'npx tsc --noEmit -p tsconfig.json',
    'pnpm exec eslint --fix-dry-run .',
    'npx mypy src',
  ])('пропускает: %s', (command) => {
    expect(readOnlyViolation(command)).toBeNull();
  });

  it.each([
    'npx eslint --fix src',
    'eslint --fix .',
    'prettier --write src',
    'biome format --write src',
    'dprint fmt',
    'npx tsc --build',
    'npx tsc',
    'npm run lint',
    'npm run lint:js -- --quiet',
    'yarn lint:css',
    'npm run test',
    'npm run build',
    'npm test',
    'npx vitest run',
    'pnpm dlx eslint .',
    'npm install eslint',
  ])('блокирует: %s', (command) => {
    expect(readOnlyViolation(command)).not.toBeNull();
  });
});

describe('read-only guard: запись результата остаётся', () => {
  it.each([
    'write',
    'edit',
    'read',
    'codemode',
    'grep',
    'glob',
    'mcp__web_search__full_web_search',
    'mcp__figma_desktop__get_design_context',
  ])('%s не блокируется', (toolName) => {
    expect(decide(toolName, { path: 'src/app.ts', content: 'x' })).toBeUndefined();
  });

  it.each([
    'ast_grep_replace',
    'agent-browser',
    'browser_snapshot',
    'mcp__chrome_devtools__navigate',
    'mcp__playwright__click',
    'mcp__puppeteer__page',
  ])('%s блокируется — он исполняет код', (toolName) => {
    expect(decide(toolName, { url: 'http://localhost:5100' })?.block).toBe(true);
  });

  it('codemode как точка входа не обходит гейт: вложенный bash — тот же tool_call', () => {
    expect(decide('codemode')).toBeUndefined();
    expect(decide('bash', { command: 'touch /tmp/pwned' })?.block).toBe(true);
  });

  it('bash с исполняющей командой блокируется с объяснением', () => {
    const decision = decide('bash', { command: 'npx vitest run' });
    expect(decision?.block).toBe(true);
    expect(decision?.reason).toContain('read-only');
    expect(decision?.reason).toContain('test');
  });

  it('executingTool знает имена и шаблоны', () => {
    expect(executingTool('ast_grep_replace')).toBe(true);
    expect(executingTool('mcp__chrome_devtools__evaluate')).toBe(true);
    expect(executingTool('write')).toBe(false);
  });
});

describe('read-only подключается только review-шагу', () => {
  it('только review объявлен read-only', () => {
    expect(readOnlyStep(PipelineStep.review)).toBe(true);
    for (const step of [
      PipelineStep.refine,
      PipelineStep.resolve,
      PipelineStep.test,
      PipelineStep.pr,
    ]) {
      expect(readOnlyStep(step)).toBe(false);
    }
  });

  it('readOnly добавляет расширение в аргументы сессии, остальные шаги его не видят', () => {
    const path = readOnlyExtensionPath();
    expect(path).not.toBeNull();
    expect(sessionArgs({ readOnly: true })).toContain('--extension');
    expect(sessionArgs({ readOnly: true })).toContain(path);
    expect(sessionArgs({})).not.toContain('--extension');
  });

  it('без файла расширения спавн не состоится — гейт не деградирует до лога', async () => {
    vi.resetModules();
    vi.doMock('node:fs', () => ({ existsSync: () => false }));
    try {
      const fresh = await import('../src/pi/rpc-spawn');
      expect(() => fresh.sessionArgs({ readOnly: true })).toThrow(
        /guard extension/,
      );
    } finally {
      vi.doUnmock('node:fs');
      vi.resetModules();
    }
  });
});