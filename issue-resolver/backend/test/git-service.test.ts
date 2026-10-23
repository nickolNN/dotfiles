import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  detectInstallCommand,
  extractPort,
  GitCliService,
  gitCachePath,
  gitTimeoutMs,
  parseRunCommand,
  type GitExecFile,
  type GitExecOptions,
} from '../src/git/service';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe('gitTimeoutMs', () => {
  it('читает GIT_TIMEOUT_MS, иначе default 300000', () => {
    const previous = process.env.GIT_TIMEOUT_MS;
    try {
      delete process.env.GIT_TIMEOUT_MS;
      expect(gitTimeoutMs()).toBe(300_000);

      process.env.GIT_TIMEOUT_MS = '1500';
      expect(gitTimeoutMs()).toBe(1500);

      process.env.GIT_TIMEOUT_MS = 'not-a-number';
      expect(gitTimeoutMs()).toBe(300_000);
    } finally {
      if (previous === undefined) delete process.env.GIT_TIMEOUT_MS;
      else process.env.GIT_TIMEOUT_MS = previous;
    }
  });
});

describe('GitCliService — таймаут git', () => {
  it('передаёт timeout и падает понятной ошибкой при зависании clone', async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), 'ir-ws-'));
    tempDirs.push(workspace);
    const seen: GitExecOptions[] = [];
    const exec: GitExecFile = (_file, _args, options) => {
      seen.push(options);
      return new Promise((_resolve, reject) => {
        setTimeout(() => {
          reject(
            Object.assign(new Error('Command failed: git clone'), {
              killed: true,
              signal: 'SIGTERM',
            }),
          );
        }, options.timeout);
      });
    };
    const service = new GitCliService(
      path.join(workspace, 'originals'),
      exec,
      40,
    );

    await expect(
      service.prepare({
        repoUrls: ['https://example.com/hang.git'],
        baseBranches: ['main'],
        workspacePath: workspace,
      }),
    ).rejects.toThrow(/timed out after 40ms/);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen[0].timeout).toBe(40);
  });

  it('таймаут fetch при тёплом кэше глушится и не рушит prepare', async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), 'ir-ws-'));
    tempDirs.push(workspace);
    const originalsRoot = path.join(workspace, 'originals');
    const repoUrl = 'https://example.com/cached.git';
    await mkdir(gitCachePath(originalsRoot, repoUrl), { recursive: true });

    const exec: GitExecFile = (_file, args, options) => {
      if (args.includes('fetch')) {
        return new Promise((_resolve, reject) => {
          setTimeout(
            () =>
              reject(
                Object.assign(new Error('fetch timed out'), { killed: true }),
              ),
            options.timeout,
          );
        });
      }
      return Promise.resolve({ stdout: '', stderr: '' });
    };
    const service = new GitCliService(originalsRoot, exec, 20);

    const result = await service.prepare({
      repoUrls: [repoUrl],
      baseBranches: ['main'],
      workspacePath: workspace,
    });

    expect(result.repoWorkspaces).toHaveLength(1);
    expect(result.repoWorkspaces[0].path).toBe(path.join(workspace, 'cached'));
  });
});

describe('detectInstallCommand — детект манифестов', () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(
      roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
    );
  });

  const repoWith = async (files: string[]): Promise<string> => {
    const dir = await mkdtemp(path.join(tmpdir(), 'ir-repo-'));
    roots.push(dir);
    await Promise.all(files.map((file) => writeFile(path.join(dir, file), '{}')));
    return dir;
  };

  it('package-lock.json → npm ci', async () => {
    expect(detectInstallCommand(await repoWith(['package-lock.json']))).toEqual({
      file: 'npm',
      args: ['ci'],
    });
  });

  it('pnpm-lock.yaml → pnpm install', async () => {
    expect(detectInstallCommand(await repoWith(['pnpm-lock.yaml']))).toEqual({
      file: 'pnpm',
      args: ['install'],
    });
  });

  it('yarn.lock → yarn install', async () => {
    expect(detectInstallCommand(await repoWith(['yarn.lock']))).toEqual({
      file: 'yarn',
      args: ['install'],
    });
  });

  it('bun.lockb → bun install', async () => {
    expect(detectInstallCommand(await repoWith(['bun.lockb']))).toEqual({
      file: 'bun',
      args: ['install'],
    });
  });

  it('package.json без lock → npm install', async () => {
    expect(detectInstallCommand(await repoWith(['package.json']))).toEqual({
      file: 'npm',
      args: ['install'],
    });
  });

  it('go.mod → go mod download', async () => {
    expect(detectInstallCommand(await repoWith(['go.mod']))).toEqual({
      file: 'go',
      args: ['mod', 'download'],
    });
  });

  it('нет манифеста → null (ставить нечего)', async () => {
    expect(detectInstallCommand(await repoWith([]))).toBeNull();
  });
});

describe('parseRunCommand', () => {
  it('достаёт команду из секции Run и выбрасывает cd/комментарии', () => {
    const md = [
      '# Setup',
      '',
      '## Install Dependencies',
      '```bash',
      'npm ci',
      '```',
      '',
      '## Run',
      '```bash',
      'cd /workspaces/issue-1/app',
      '# запуск',
      'npm run dev',
      '```',
      '',
      '## Notes',
      'что-то',
    ].join('\n');
    expect(parseRunCommand(md)).toEqual({
      file: 'sh',
      args: ['-c', 'npm run dev'],
    });
  });

  it('понимает секцию «Запуск» и однострочный cd && …', () => {
    const md = '## Запуск\n```bash\ncd app && npx vite --port 5173\n```\n';
    expect(parseRunCommand(md)).toEqual({
      file: 'sh',
      args: ['-c', 'npx vite --port 5173'],
    });
  });

  it('нет секции Run / пустая / null → null', () => {
    expect(parseRunCommand(null)).toBeNull();
    expect(parseRunCommand('# Setup\nnpm ci')).toBeNull();
    expect(parseRunCommand('## Run\n```bash\ncd x\n```')).toBeNull();
  });
});

describe('extractPort', () => {
  it('вытаскивает порт из Vite-подобного вывода и флага --port', () => {
    expect(extractPort('  ➜  Local:   http://localhost:5173/')).toBe(5173);
    expect(extractPort('ready on http://127.0.0.1:3000')).toBe(3000);
    expect(extractPort('npx vite --port 4200')).toBe(4200);
  });

  it('нет порта → null, нечисловое/вне диапазона игнорируется', () => {
    expect(extractPort('starting…')).toBeNull();
    expect(extractPort('localhost:abc')).toBeNull();
    expect(extractPort('localhost:99999')).toBeNull();
  });
});

describe('GitCliService.startDevServer', () => {
  it('нет команды запуска → { port: null, message } без spawn', async () => {
    const service = new GitCliService('/tmp/originals', () => {
      throw new Error('exec must not run');
    });
    const result = await service.startDevServer('/tmp/repo', null);
    expect(result.port).toBeNull();
    expect(result.message).toContain('RUN_INSTRUCTIONS');
  });
});

describe('GitCliService.installDependencies', () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(
      roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
    );
  });

  const tempDir = async (): Promise<string> => {
    const dir = await mkdtemp(path.join(tmpdir(), 'ir-install-'));
    roots.push(dir);
    return dir;
  };

  it('npm ci запускается, а repoPath с node_modules пропускается', async () => {
    const repo = await tempDir();
    await writeFile(path.join(repo, 'package-lock.json'), '{}');
    const calls: string[] = [];
    const exec: GitExecFile = (file, args) => {
      calls.push(`${file} ${args.join(' ')}`);
      return Promise.resolve({ stdout: '', stderr: '' });
    };
    const service = new GitCliService(
      path.join(repo, 'originals'),
      exec,
      10_000,
    );

    await service.installDependencies([repo]);
    expect(calls).toEqual(['npm ci']);

    // node_modules уже есть → повторная установка не запускается.
    await mkdir(path.join(repo, 'node_modules'), { recursive: true });
    calls.length = 0;
    await service.installDependencies([repo]);
    expect(calls).toEqual([]);
  });

  it('go mod download не пропускается при наличии node_modules', async () => {
    const repo = await tempDir();
    await writeFile(path.join(repo, 'go.mod'), 'module example.com/x');
    await mkdir(path.join(repo, 'node_modules'), { recursive: true });
    const calls: string[] = [];
    const exec: GitExecFile = (file, args) => {
      calls.push(`${file} ${args.join(' ')}`);
      return Promise.resolve({ stdout: '', stderr: '' });
    };
    const service = new GitCliService(
      path.join(repo, 'originals'),
      exec,
      10_000,
    );

    await service.installDependencies([repo]);
    expect(calls).toEqual(['go mod download']);
  });

  it('нет манифеста → команда не запускается', async () => {
    const repo = await tempDir();
    const calls: string[] = [];
    const exec: GitExecFile = (file, args) => {
      calls.push(`${file} ${args.join(' ')}`);
      return Promise.resolve({ stdout: '', stderr: '' });
    };
    const service = new GitCliService(
      path.join(repo, 'originals'),
      exec,
      10_000,
    );

    await service.installDependencies([repo]);
    expect(calls).toEqual([]);
  });

  it('ненулевой exit установки → reject (init-fail)', async () => {
    const repo = await tempDir();
    await writeFile(path.join(repo, 'package-lock.json'), '{}');
    const exec: GitExecFile = () =>
      Promise.reject(
        Object.assign(new Error('Command failed: npm ci'), { code: 1 }),
      );
    const service = new GitCliService(
      path.join(repo, 'originals'),
      exec,
      10_000,
    );

    await expect(service.installDependencies([repo])).rejects.toThrow(
      /dependency install failed \(npm ci\)/,
    );
  });
});

describe('GitCliService.commitAndPush — squash + force-push', () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(
      roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
    );
  });

  it('squashBase → push с --force (remote-ветка уже существует от предыдущего прогона)', async () => {
    const repo = await mkdtemp(path.join(tmpdir(), 'ir-force-'));
    roots.push(repo);
    await mkdir(path.join(repo, '.git'), { recursive: true });
    const execCalls: { args: string[]; cwd?: string }[] = [];
    const exec: GitExecFile = (_file, args, options) => {
      execCalls.push({ args: [...args], cwd: options.cwd });
      return Promise.resolve({ stdout: '', stderr: '' });
    };
    const service = new GitCliService(
      path.join(repo, 'originals'),
      exec,
      10_000,
    );

    await service.commitAndPush({
      repoPath: repo,
      branchName: 'feature/fix-bug-abc123',
      commitMessage: 'feat: Fix bug',
      squashBase: 'origin/main',
    });

    const pushCall = execCalls.find(
      (call) => call.args.includes('push'),
    );
    expect(pushCall).toBeDefined();
    expect(pushCall!.args).toContain('--force');
    expect(pushCall!.args).toContain('--set-upstream');
    expect(pushCall!.args).toContain('feature/fix-bug-abc123');
  });

  it('без squashBase → push БЕЗ --force (обычный fast-forward)', async () => {
    const repo = await mkdtemp(path.join(tmpdir(), 'ir-noforce-'));
    roots.push(repo);
    await mkdir(path.join(repo, '.git'), { recursive: true });
    const execCalls: { args: string[]; cwd?: string }[] = [];
    const exec: GitExecFile = (_file, args, options) => {
      execCalls.push({ args: [...args], cwd: options.cwd });
      return Promise.resolve({ stdout: '', stderr: '' });
    };
    const service = new GitCliService(
      path.join(repo, 'originals'),
      exec,
      10_000,
    );

    await service.commitAndPush({
      repoPath: repo,
      branchName: 'feature/no-squash',
      commitMessage: 'feat: No squash',
      // squashBase не задан
    });

    const pushCall = execCalls.find(
      (call) => call.args.includes('push'),
    );
    expect(pushCall).toBeDefined();
    expect(pushCall!.args).not.toContain('--force');
  });

  it('squashBase + BITBUCKET_TOKEN → push с --force и credential.helper', async () => {
    const repo = await mkdtemp(path.join(tmpdir(), 'ir-token-'));
    roots.push(repo);
    await mkdir(path.join(repo, '.git'), { recursive: true });
    const execCalls: { args: string[] }[] = [];
    const exec: GitExecFile = (_file, args) => {
      execCalls.push({ args: [...args] });
      return Promise.resolve({ stdout: '', stderr: '' });
    };
    const service = new GitCliService(
      path.join(repo, 'originals'),
      exec,
      10_000,
    );
    const prev = process.env.BITBUCKET_TOKEN;
    process.env.BITBUCKET_TOKEN = 'test-token';
    try {
      await service.commitAndPush({
        repoPath: repo,
        branchName: 'feature/token-test',
        commitMessage: 'feat: Token',
        squashBase: 'origin/main',
      });

      const pushCall = execCalls.find((call) => call.args.includes('push'));
      expect(pushCall).toBeDefined();
      // credential.helper должен быть ДО --force (pushArgs.unshift вставляет
      // -c перед остальными, а --force добавляется pushArgs.push до unshift).
      expect(pushCall!.args).toContain('--force');
      expect(
        pushCall!.args.some(
          (arg) => arg.startsWith('credential.helper=') && arg.includes('test-token'),
        ),
      ).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.BITBUCKET_TOKEN;
      else process.env.BITBUCKET_TOKEN = prev;
    }
  });
});

describe('GitCliService.prepare — идемпотентность', () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(
      roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
    );
  });

  it('повторный prepare не клонирует, install не переустанавливает зависимости', async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), 'ir-idem-'));
    roots.push(workspace);
    const repoUrl = 'https://example.com/app.git';
    const repoPath = path.join(workspace, 'app');
    await mkdir(repoPath, { recursive: true });
    await writeFile(path.join(repoPath, 'package-lock.json'), '{}');

    const calls: { file: string; args: string[] }[] = [];
    const exec: GitExecFile = async (file, args) => {
      calls.push({ file, args });
      // Фейковый clone рабочей копии создаёт .git; установка — node_modules.
      if (file === 'git' && args[0] === 'clone' && !args.includes('--bare')) {
        await mkdir(path.join(repoPath, '.git'), { recursive: true });
      }
      if (file === 'npm') {
        await mkdir(path.join(repoPath, 'node_modules'), { recursive: true });
      }
      return { stdout: '', stderr: '' };
    };
    const service = new GitCliService(
      path.join(workspace, 'originals'),
      exec,
      10_000,
    );

    const first = await service.prepare({
      repoUrls: [repoUrl],
      baseBranches: ['main'],
      workspacePath: workspace,
    });
    await service.installDependencies(first.repoWorkspaces.map((ws) => ws.path));
    expect(
      calls.some(
        (call) =>
          call.file === 'git' &&
          call.args[0] === 'clone' &&
          !call.args.includes('--bare'),
      ),
    ).toBe(true);
    expect(calls.some((call) => call.file === 'npm')).toBe(true);

    // Повтор: .git и node_modules уже на месте — ни clone, ни install.
    calls.length = 0;
    const second = await service.prepare({
      repoUrls: [repoUrl],
      baseBranches: ['main'],
      workspacePath: workspace,
    });
    await service.installDependencies(second.repoWorkspaces.map((ws) => ws.path));

    expect(second.repoWorkspaces).toEqual(first.repoWorkspaces);
    expect(calls).toEqual([]);
  });
});