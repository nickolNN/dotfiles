import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const DEFAULT_GIT_TIMEOUT_MS = 60_000;

/** Таймаут git-операций: env `GIT_TIMEOUT_MS` (default 60000). */
export const gitTimeoutMs = (): number => {
  const raw = Number(process.env.GIT_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_GIT_TIMEOUT_MS;
};

/** Опции запуска git-команды, которые значимы сервису (и инъекции в тестах). */
export interface GitExecOptions {
  cwd?: string;
  maxBuffer: number;
  windowsHide: boolean;
  timeout: number;
}

/** Инъекция execFile: по умолчанию — promisify(execFile), в тестах подменяется. */
export type GitExecFile = (
  file: string,
  args: string[],
  options: GitExecOptions,
) => Promise<{ stdout: string; stderr: string }>;

const defaultGitExecFile: GitExecFile = async (file, args, options) => {
  const { stdout, stderr } = await execFileAsync(file, args, options);
  return { stdout: String(stdout), stderr: String(stderr) };
};

/** Дефолтный корень originals-кэша: bare-клоны репозиториев. */
export const DEFAULT_ORIGINALS_ROOT = '/tmp/issue-resolver/originals';

/**
 * Корень originals-кэша из env: при заданном `ISSUE_RESOLVER_DATA_DIR` — 
 * `<DATA_DIR>/originals`, иначе DEFAULT_ORIGINALS_ROOT (текущее поведение).
 */
export const originalsRootFromEnv = (env: NodeJS.ProcessEnv): string => {
  const dataDir = env.ISSUE_RESOLVER_DATA_DIR;
  return dataDir ? path.join(dataDir, 'originals') : DEFAULT_ORIGINALS_ROOT;
};

/** Таймаут git (`killed`) → понятная ошибка; прочее отдаём как есть. */
function describeGitError(
  error: unknown,
  timeoutMs: number,
  args: string[],
): Error {
  const detail = error as { killed?: boolean; signal?: string | null } | null;
  if (detail?.killed) {
    return new Error(
      `git ${args.join(' ')} timed out after ${timeoutMs}ms` +
        (detail.signal ? ` (signal ${detail.signal})` : ''),
    );
  }
  return error instanceof Error ? error : new Error(String(error));
}

export interface GitPrepareInput {
  repoUrls: string[];
  baseBranches: string[];
  workspacePath: string;
}

export interface GitPrepareResult {
  repoWorkspaces: { repoUrl: string; path: string; branch: string }[];
}

export interface GitCommitInput {
  repoPath: string;
  branchName: string;
  commitMessage: string;
}

export interface GitCommitResult {
  pushed: boolean;
  branchName: string;
}

/** Команда установки зависимостей: исполняемый файл и его аргументы. */
export interface InstallCommand {
  file: string;
  args: string[];
}

/**
 * Детерминированный манифест → команда установки зависимостей в `repoPath`.
 * Приоритет: lock-файлы JS-менеджеров → `package.json` (npm) → `go.mod` →
 * `null` (ставить нечего, отсутствие манифеста — не ошибка).
 */
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

/**
 * Подготовка рабочих копий репозиториев и публикация результата.
 * Реализации: in-memory fake для юнит-тестов и CLI-обёртка над `git`.
 */
export interface GitService {
  prepare(input: GitPrepareInput): Promise<GitPrepareResult>;
  installDependencies(repoPaths: string[]): Promise<void>;
  commitAndPush(input: GitCommitInput): Promise<GitCommitResult>;
}

const repoName = (repoUrl: string): string => {
  const clean = repoUrl.replace(/\/+$/, '').replace(/\.git$/, '');
  const segment = clean.split(/[\\/]/).pop();
  return segment && segment.length > 0 ? segment : 'repo';
};

const sha256 = (value: string): string =>
  createHash('sha256').update(value).digest('hex');

/** Путь bare-кэша originals для URL (нужен тестам для прогрева кэша). */
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

/**
 * In-memory-реализация для тестов: не делает реальных git-вызовов, но помнит
 * входные аргументы и умеет притвориться падающей через `failNextWith`.
 */
export class FakeGitService implements GitService {
  readonly prepares: GitPrepareInput[] = [];
  readonly commits: GitCommitInput[] = [];
  /** Аргументы каждого вызова installDependencies (копия массива путей). */
  readonly dependenciesInstalled: string[][] = [];
  private pendingError: Error | null = null;

  /** Следующая операция (prepare/commitAndPush) отклонится этой ошибкой. */
  failNextWith(err: Error): void {
    this.pendingError = err;
  }

  async prepare(input: GitPrepareInput): Promise<GitPrepareResult> {
    this.throwIfPending();
    this.prepares.push(input);
    return {
      repoWorkspaces: input.repoUrls.map((repoUrl, index) => ({
        repoUrl,
        path: `${input.workspacePath}/${repoName(repoUrl)}`,
        branch: input.baseBranches[index] ?? 'main',
      })),
    };
  }

  async installDependencies(repoPaths: string[]): Promise<void> {
    this.throwIfPending();
    this.dependenciesInstalled.push([...repoPaths]);
  }

  async commitAndPush(input: GitCommitInput): Promise<GitCommitResult> {
    this.throwIfPending();
    this.commits.push(input);
    return { pushed: true, branchName: input.branchName };
  }

  private throwIfPending(): void {
    if (this.pendingError) {
      const err = this.pendingError;
      this.pendingError = null;
      throw err;
    }
  }
}

/**
 * Реальная обёртка над `git` через `child_process.execFile`. Юнит-тестами не
 * покрыта (интеграция). Реализация по плану §6: originals-кэш bare-клонов,
 * `core.longpaths=true`, снятие залипшего `index.lock`, `add -A` + `commit` +
 * `push --set-upstream` (пуш выполняется даже без изменений).
 *
 * Ветку (`jira-key` или `issue-resolver/<uuid>`) выбирает вызывающий код и
 * передаёт в `GitCommitInput.branchName`.
 */
export class GitCliService implements GitService {
  constructor(
    private readonly originalsRoot = DEFAULT_ORIGINALS_ROOT,
    private readonly exec: GitExecFile = defaultGitExecFile,
    private readonly timeoutMs: number = gitTimeoutMs(),
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

      const name = repoName(repoUrl);
      const repoPath = path.join(input.workspacePath, name);

      // Идемпотентность: уже склонированную рабочую копию не переклонируем —
      // повтор итерации работает с тем же кодом, что и первая.
      if (existsSync(path.join(repoPath, '.git'))) {
        repoWorkspaces.push({ repoUrl, path: repoPath, branch: baseBranch });
        continue;
      }

      const cachePath = gitCachePath(this.originalsRoot, repoUrl);

      if (!existsSync(cachePath)) {
        await mkdir(this.originalsRoot, { recursive: true });
        await this.git(['clone', '--bare', repoUrl, cachePath]);
      } else {
        // Обновляем originals-кэш, но не падаем, если сеть недоступна.
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
      // originals-кэш мог отстать от origin — подтягиваем fast-forward.
      await this.git(['-C', repoPath, 'pull', '--ff-only', 'origin', baseBranch]);

      repoWorkspaces.push({ repoUrl, path: repoPath, branch: baseBranch });
    }

    return { repoWorkspaces };
  }

  /**
   * Разовая установка зависимостей в уже склонированных `repoPath`.
   * Идемпотентно: если `node_modules` уже есть (кроме Go), репозиторий
   * пропускается. Ненулевой exit команды установки — ошибка (init-fail).
   */
  async installDependencies(repoPaths: string[]): Promise<void> {
    for (const repoPath of repoPaths) {
      const command = detectInstallCommand(repoPath);
      if (!command) {
        continue;
      }
      // Go не создаёт node_modules: его модульный кэш общий, а повторный
      // `go mod download` дёшев и не считается переустановкой.
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

  async commitAndPush(input: GitCommitInput): Promise<GitCommitResult> {
    await rmIndexLock(input.repoPath);
    await this.git(['-C', input.repoPath, 'checkout', '-B', input.branchName]);
    await this.git(['-C', input.repoPath, 'add', '-A']);
    // «nothing to commit» — не ошибка: пуш нужен даже без изменений.
    await this.git([
      '-C',
      input.repoPath,
      'commit',
      '--no-verify',
      '-m',
      input.commitMessage,
    ]).catch(() => undefined);
    await this.git([
      '-C',
      input.repoPath,
      'push',
      '--set-upstream',
      'origin',
      input.branchName,
    ]);
    return { pushed: true, branchName: input.branchName };
  }
}