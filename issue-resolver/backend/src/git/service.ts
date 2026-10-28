import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const DEFAULT_GIT_TIMEOUT_MS = 300_000;

export const gitTimeoutMs = (): number => {
  const raw = Number(process.env.GIT_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_GIT_TIMEOUT_MS;
};

const DEFAULT_DEV_SERVER_TIMEOUT_MS = 30_000;

export const devServerTimeoutMs = (): number => {
  const raw = Number(process.env.DEV_SERVER_PORT_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_DEV_SERVER_TIMEOUT_MS;
};

export interface GitExecOptions {
  cwd?: string;
  maxBuffer: number;
  windowsHide: boolean;
  timeout: number;
}

export type GitExecFile = (
  file: string,
  args: string[],
  options: GitExecOptions,
) => Promise<{ stdout: string; stderr: string }>;

const defaultGitExecFile: GitExecFile = async (file, args, options) => {
  const { stdout, stderr } = await execFileAsync(file, args, options);
  return { stdout: String(stdout), stderr: String(stderr) };
};

export const DEFAULT_ORIGINALS_ROOT = '/tmp/issue-resolver/originals';

export const originalsRootFromEnv = (env: NodeJS.ProcessEnv): string => {
  const dataDir = env.ISSUE_RESOLVER_DATA_DIR;
  return dataDir ? path.join(dataDir, 'originals') : DEFAULT_ORIGINALS_ROOT;
};

function maskCredentialArgs(args: string[]): string[] {
  return args.map((arg) =>
    arg.startsWith('credential.helper=')
      ? arg.replace(/password=[^;"]+/, 'password=***')
      : arg,
  );
}

function describeGitError(
  error: unknown,
  timeoutMs: number,
  args: string[],
): Error {
  const detail = error as { killed?: boolean; signal?: string | null } | null;
  if (detail?.killed) {
    return new Error(
      `git ${maskCredentialArgs(args).join(' ')} timed out after ${timeoutMs}ms` +
        (detail.signal ? ` (signal ${detail.signal})` : '') +
        ` — увеличить таймаут: GIT_TIMEOUT_MS`,
    );
  }
  return error instanceof Error ? error : new Error(String(error));
}

function isNothingToCommitError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /nothing (added )?to commit/i.test(message);
}

export interface GitPrepareInput {
  repoUrls: string[];
  baseBranches: string[];
  workspacePath: string;
  onRepoProgress?: (repoUrl: string, status: 'running' | 'done') => void;
}

export interface GitPrepareResult {
  repoWorkspaces: { repoUrl: string; path: string; branch: string }[];
}

export interface GitCommitInput {
  repoPath: string;
  branchName: string;
  commitMessage: string;
  squashBase?: string;
}

export interface GitCommitResult {
  pushed: boolean;
  branchName: string;
}

export interface DevServerStartResult {
  port: number | null;
  message?: string;
}

export interface InstallCommand {
  file: string;
  args: string[];
}

export function detectInstallCommand(repoPath: string): InstallCommand | null {
  if (existsSync(path.join(repoPath, 'package-lock.json'))) {
    return { file: 'npm', args: ['ci'] };
  }
  if (existsSync(path.join(repoPath, 'pnpm-lock.yaml'))) {
    return { file: 'pnpm', args: ['install'] };
  }
  if (existsSync(path.join(repoPath, 'yarn.lock'))) {
    return { file: 'yarn', args: ['install'] };
  }
  if (
    existsSync(path.join(repoPath, 'bun.lock')) ||
    existsSync(path.join(repoPath, 'bun.lockb'))
  ) {
    return { file: 'bun', args: ['install'] };
  }
  if (existsSync(path.join(repoPath, 'package.json'))) {
    return { file: 'npm', args: ['install'] };
  }
  if (existsSync(path.join(repoPath, 'go.mod'))) {
    return { file: 'go', args: ['mod', 'download'] };
  }
  return null;
}

export function parseRunCommand(
  instructions: string | null,
): InstallCommand | null {
  if (!instructions) return null;
  const heading = /^##[ \t]*(?:run|запуск)(?=[\s:(]|$)/im.exec(instructions);
  if (!heading) return null;

  const rest = instructions.slice(heading.index + heading[0].length);
  const nextHeading = /^##\s/m.exec(rest);
  const section = nextHeading ? rest.slice(0, nextHeading.index) : rest;

  const fences = [...section.matchAll(/```[^\n]*\n([\s\S]*?)```/g)];
  const raw =
    fences.length > 0
      ? fences.map((match) => match[1]).join('\n')
      : section;

  const command = raw
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .filter((line) => !line.startsWith('#'))
    .map((line) => line.replace(/^cd\s+[^&]*&&\s*/, '').trim())
    .filter((line) => line.length > 0 && !/^cd(\s|$)/.test(line))
    .join(' && ');

  return command.length > 0 ? { file: 'sh', args: ['-c', command] } : null;
}

export function extractPort(text: string): number | null {
  const patterns = [
    /(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]):(\d{2,5})/i,
    /--port[=\s]+(\d{2,5})/i,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (match) {
      const port = Number(match[1]);
      if (Number.isInteger(port) && port > 0 && port <= 65535) return port;
    }
  }
  return null;
}

export interface GitService {
  prepare(input: GitPrepareInput): Promise<GitPrepareResult>;
  installDependencies(repoPaths: string[]): Promise<void>;
  commitAndPush(input: GitCommitInput): Promise<GitCommitResult>;
  changeDigest(repoPaths: string[]): Promise<RepoChangeDigest[]>;
  startDevServer(
    repoPath: string,
    instructions: string | null,
  ): Promise<DevServerStartResult>;
}

export interface RepoChangeDigest {
  repoPath: string;
  changedFiles: string[];
  diffSummary: string;
  omittedFiles: number;
}

const repoName = (repoUrl: string): string => {
  const clean = repoUrl.replace(/\/+$/, '').replace(/\.git$/, '');
  const segment = clean.split(/[\\/]/).pop();
  return segment && segment.length > 0 ? segment : 'repo';
};

const sha256 = (value: string): string =>
  createHash('sha256').update(value).digest('hex');

export const gitCachePath = (
  originalsRoot: string,
  repoUrl: string,
): string =>
  path.join(
    originalsRoot,
    `${repoName(repoUrl)}-${sha256(repoUrl).slice(0, 4)}`,
  );

const rmIndexLock = async (repoPath: string): Promise<void> => {
  await rm(path.join(repoPath, '.git', 'index.lock'), { force: true });
};

const CHANGE_DIGEST_MAX_FILES = 120;

export class FakeGitService implements GitService {
  readonly prepares: GitPrepareInput[] = [];
  readonly commits: GitCommitInput[] = [];
  readonly dependenciesInstalled: string[][] = [];
  readonly devServersStarted: { repoPath: string; instructions: string | null }[] =
    [];
  devServerResult: DevServerStartResult = { port: 5173 };
  private pendingError: Error | null = null;

  failNextWith(err: Error): void {
    this.pendingError = err;
  }

  async prepare(input: GitPrepareInput): Promise<GitPrepareResult> {
    this.throwIfPending();
    this.prepares.push(input);
    return {
      repoWorkspaces: input.repoUrls.map((repoUrl, index) => {
        input.onRepoProgress?.(repoUrl, 'running');
        input.onRepoProgress?.(repoUrl, 'done');
        return {
          repoUrl,
          path: `${input.workspacePath}/${repoName(repoUrl)}`,
          branch: input.baseBranches[index] ?? 'main',
        };
      }),
    };
  }

  async installDependencies(repoPaths: string[]): Promise<void> {
    this.throwIfPending();
    this.dependenciesInstalled.push([...repoPaths]);
  }

  async startDevServer(
    repoPath: string,
    instructions: string | null,
  ): Promise<DevServerStartResult> {
    this.throwIfPending();
    this.devServersStarted.push({ repoPath, instructions });
    return this.devServerResult;
  }

  async commitAndPush(input: GitCommitInput): Promise<GitCommitResult> {
    this.throwIfPending();
    this.commits.push(input);
    return { pushed: true, branchName: input.branchName };
  }

  changeDigests: RepoChangeDigest[] = [];
  readonly digestCalls: string[][] = [];
  private digestError: Error | null = null;

  failDigestWith(err: Error): void {
    this.digestError = err;
  }

  async changeDigest(repoPaths: string[]): Promise<RepoChangeDigest[]> {
    this.digestCalls.push([...repoPaths]);
    if (this.digestError) {
      const error = this.digestError;
      this.digestError = null;
      throw error;
    }
    return repoPaths.map(
      (repoPath, index) =>
        this.changeDigests[index] ?? {
          repoPath,
          changedFiles: [],
          diffSummary: '',
          omittedFiles: 0,
        },
    );
  }

  private throwIfPending(): void {
    if (this.pendingError) {
      const err = this.pendingError;
      this.pendingError = null;
      throw err;
    }
  }
}

export class GitCliService implements GitService {
  constructor(
    private readonly originalsRoot = DEFAULT_ORIGINALS_ROOT,
    private readonly exec: GitExecFile = defaultGitExecFile,
    private readonly timeoutMs: number = gitTimeoutMs(),
    private readonly devServerTimeout: number = devServerTimeoutMs(),
  ) {}

  private async git(args: string[], cwd?: string): Promise<string> {
    try {
      const { stdout } = await this.exec('git', args, {
        cwd,
        maxBuffer: 16 * 1024 * 1024,
        windowsHide: true,
        timeout: this.timeoutMs,
      });
      return stdout;
    } catch (error) {
      throw describeGitError(error, this.timeoutMs, args);
    }
  }

  async prepare(input: GitPrepareInput): Promise<GitPrepareResult> {
    await mkdir(input.workspacePath, { recursive: true });
    const repoWorkspaces: GitPrepareResult['repoWorkspaces'] = [];

    for (let i = 0; i < input.repoUrls.length; i += 1) {
      const repoUrl = input.repoUrls[i];
      const baseBranch = input.baseBranches[i] ?? 'main';
      input.onRepoProgress?.(repoUrl, 'running');

      const name = repoName(repoUrl);
      const repoPath = path.join(input.workspacePath, name);

      if (existsSync(path.join(repoPath, '.git'))) {
        repoWorkspaces.push({ repoUrl, path: repoPath, branch: baseBranch });
        input.onRepoProgress?.(repoUrl, 'done');
        continue;
      }

      const cachePath = gitCachePath(this.originalsRoot, repoUrl);

      if (!existsSync(cachePath)) {
        await mkdir(this.originalsRoot, { recursive: true });
        await this.git(['clone', '--bare', repoUrl, cachePath]);
      } else {
        await this.git([
          '-C',
          cachePath,
          'fetch',
          '--prune',
          'origin',
          '+refs/heads/*:refs/heads/*',
        ]).catch(() => undefined);
      }

      await this.git(['clone', '--branch', baseBranch, cachePath, repoPath]);
      await this.git(['-C', repoPath, 'remote', 'set-url', 'origin', repoUrl]);
      await this.git(['-C', repoPath, 'config', 'core.longpaths', 'true']);
      await rmIndexLock(repoPath);
      await this.git(['-C', repoPath, 'pull', '--ff-only', 'origin', baseBranch]);

      repoWorkspaces.push({ repoUrl, path: repoPath, branch: baseBranch });
      input.onRepoProgress?.(repoUrl, 'done');
    }

    return { repoWorkspaces };
  }

  async installDependencies(repoPaths: string[]): Promise<void> {
    for (const repoPath of repoPaths) {
      const command = detectInstallCommand(repoPath);
      if (!command) {
        continue;
      }
      if (
        command.file !== 'go' &&
        existsSync(path.join(repoPath, 'node_modules'))
      ) {
        continue;
      }
      try {
        await this.exec(command.file, command.args, {
          cwd: repoPath,
          maxBuffer: 16 * 1024 * 1024,
          windowsHide: true,
          timeout: gitTimeoutMs(),
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(
          `dependency install failed (${command.file} ${command.args.join(' ')}) in ${repoPath}: ${message}`,
        );
      }
    }
  }

  async startDevServer(
    repoPath: string,
    instructions: string | null,
  ): Promise<DevServerStartResult> {
    const command = parseRunCommand(instructions);
    if (!command) {
      return {
        port: null,
        message: 'команда запуска не найдена в RUN_INSTRUCTIONS.md',
      };
    }

    return new Promise<DevServerStartResult>((resolve) => {
      let settled = false;
      let output = '';
      const finish = (result: DevServerStartResult): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(result);
      };
      const timer = setTimeout(
        () =>
          finish({
            port: null,
            message: 'таймаут ожидания порта dev-сервера',
          }),
        this.devServerTimeout,
      );
      timer.unref?.();

      let child: ReturnType<typeof spawn>;
      try {
        child = spawn(command.file, command.args, {
          cwd: repoPath,
          detached: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch (error) {
        finish({
          port: null,
          message: error instanceof Error ? error.message : String(error),
        });
        return;
      }

      const preset = extractPort([command.file, ...command.args].join(' '));
      if (preset !== null) {
        child.unref();
        finish({ port: preset });
        return;
      }

      const onData = (chunk: Buffer | string): void => {
        output = `${output}${String(chunk)}`.slice(-4096);
        const port = extractPort(output);
        if (port !== null) {
          child.unref();
          finish({ port });
        }
      };
      child.stdout?.on('data', onData);
      child.stderr?.on('data', onData);
      child.on('error', (error) =>
        finish({ port: null, message: error.message }),
      );
      child.on('exit', (code) =>
        finish({
          port: null,
          message: `dev-сервер завершился с кодом ${code}`,
        }),
      );
    });
  }

  async changeDigest(repoPaths: string[]): Promise<RepoChangeDigest[]> {
    return Promise.all(
      repoPaths.map(async (repoPath) => {
        const digest: RepoChangeDigest = {
          repoPath,
          changedFiles: [],
          diffSummary: '',
          omittedFiles: 0,
        };
        let status: string;
        try {
          status = await this.git([
            '-C',
            repoPath,
            'status',
            '--porcelain=v1',
            '-uall',
          ]);
        } catch {
          return digest;
        }
        const entries = status
          .split('\n')
          .map((line) => line.trimEnd())
          .filter((line) => line.length > 0);
        digest.omittedFiles = Math.max(
          0,
          entries.length - CHANGE_DIGEST_MAX_FILES,
        );
        digest.changedFiles = entries
          .slice(0, CHANGE_DIGEST_MAX_FILES)
          .map((line) => line.slice(3));
        try {
          const stat = await this.git(['-C', repoPath, 'diff', '--stat', '--no-color']);
          const lines = stat
            .split('\n')
            .map((line) => line.trimEnd())
            .filter((line) => line.length > 0);
          digest.diffSummary = lines[lines.length - 1] ?? '';
        } catch {
        }
        return digest;
      }),
    );
  }

  async commitAndPush(input: GitCommitInput): Promise<GitCommitResult> {
    await rmIndexLock(input.repoPath);
    await this.git(['-C', input.repoPath, 'checkout', '-B', input.branchName]);
    if (input.squashBase) {
      await this.git(['-C', input.repoPath, 'reset', '--soft', input.squashBase]);
    }
    await this.git(['-C', input.repoPath, 'add', '-A']);
    const identity = [
      '-c',
      `user.name=${process.env.GIT_AUTHOR_NAME || 'issue-resolver'}`,
      '-c',
      `user.email=${process.env.GIT_AUTHOR_EMAIL || 'issue-resolver@localhost'}`,
    ];
    try {
      await this.git([
        '-C',
        input.repoPath,
        ...identity,
        'commit',
        '--no-verify',
        '-m',
        input.commitMessage,
      ]);
    } catch (error) {
      if (!isNothingToCommitError(error)) throw error;
    }

    const token =
      process.env.GITHUB_TOKEN ||
      process.env.GITLAB_TOKEN ||
      process.env.BITBUCKET_TOKEN ||
      '';
    const pushArgs = [
      '-C',
      input.repoPath,
      'push',
      '--set-upstream',
      'origin',
      input.branchName,
    ];
    if (input.squashBase) {
      pushArgs.push('--force');
    }
    if (token) {
      pushArgs.unshift(
        '-c',
        `credential.helper=!f() { echo "password=${token}"; echo "username=x-access-token"; }; f`,
      );
    }
    await this.git(pushArgs);
    return { pushed: true, branchName: input.branchName };
  }
}