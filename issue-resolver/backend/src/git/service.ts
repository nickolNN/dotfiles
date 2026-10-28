import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * Таймаут git-операций. Дефолт 5 мин: `clone --bare` реальных репозиториев
 * легко не укладывается в минуту (aqua-com, 60 МБ — ~75 с), а по этому таймауту
 * идёт и первичный прогрев originals-кэша. Env `GIT_TIMEOUT_MS`.
 */
const DEFAULT_GIT_TIMEOUT_MS = 300_000;

/** Таймаут git-операций: env `GIT_TIMEOUT_MS` (default 300000). */
export const gitTimeoutMs = (): number => {
  const raw = Number(process.env.GIT_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_GIT_TIMEOUT_MS;
};

const DEFAULT_DEV_SERVER_TIMEOUT_MS = 30_000;

/** Ожидание порта dev-сервера: env `DEV_SERVER_PORT_TIMEOUT_MS` (default 30000). */
export const devServerTimeoutMs = (): number => {
  const raw = Number(process.env.DEV_SERVER_PORT_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_DEV_SERVER_TIMEOUT_MS;
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
/** Маскирует токен в credential-helper аргументе (безопасность логов). */
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

/**
 * A commit against an empty index is not a failure — publish still pushes the
 * branch. Matches git's stderr wording, including "nothing added to commit but
 * untracked files present".
 */
function isNothingToCommitError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /nothing (added )?to commit/i.test(message);
}

export interface GitPrepareInput {
  repoUrls: string[];
  baseBranches: string[];
  workspacePath: string;
  /**
   * Прогресс по каждому репозиторию: `running` перед клонированием,
   * `done` — после. Позволяет вызывающему слою публиковать
   * `workspace_progress` без знания внутреннего порядка git-операций.
   */
  onRepoProgress?: (repoUrl: string, status: 'running' | 'done') => void;
}

export interface GitPrepareResult {
  repoWorkspaces: { repoUrl: string; path: string; branch: string }[];
}

export interface GitCommitInput {
  repoPath: string;
  branchName: string;
  commitMessage: string;
  /**
   * Если задан — мягкий reset (--soft) до этого ref перед коммитом.
   * Все коммиты на ветке сквошатся в один. Ref должен существовать
   * локально (обычно base-ветка: `master`, `main`).
   */
  squashBase?: string;
}

export interface GitCommitResult {
  pushed: boolean;
  branchName: string;
}

/** Итог запуска dev-сервера: найденный порт либо причина, почему его нет. */
export interface DevServerStartResult {
  /** Порт сервера или null, если команда не найдена/сервер не поднялся. */
  port: number | null;
  /** Причина, когда `port === null` (для прогресса со статусом `warning`). */
  message?: string;
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
 * Команда запуска dev-сервера из Markdown-инструкции (`RUN_INSTRUCTIONS.md`).
 *
 * Берём секцию `## Run`/`## Запуск`, из неё — fenced bash-блок (или весь текст
 * секции), выбрасываем комментарии и строки `cd …` (рабочий cwd задаётся
 * вызывающим кодом), остальные строки соединяем через `&&`. Нет секции или
 * команд → null.
 */
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
    // cwd задаёт вызывающий код: снимаем `cd <dir> && …`, чисто `cd` отсеем ниже.
    .map((line) => line.replace(/^cd\s+[^&]*&&\s*/, '').trim())
    .filter((line) => line.length > 0 && !/^cd(\s|$)/.test(line))
    .join(' && ');

  return command.length > 0 ? { file: 'sh', args: ['-c', command] } : null;
}

/** Первый порт из вывода dev-сервера (`localhost:5173`, `--port 3000` и т.п.). */
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

/**
 * Подготовка рабочих копий репозиториев и публикация результата.
 * Реализации: in-memory fake для юнит-тестов и CLI-обёртка над `git`.
 */
export interface GitService {
  prepare(input: GitPrepareInput): Promise<GitPrepareResult>;
  installDependencies(repoPaths: string[]): Promise<void>;
  commitAndPush(input: GitCommitInput): Promise<GitCommitResult>;
  /**
   * Компактный снимок рабочей копии для промпта агента (см. `RepoChangeDigest`):
   * какие файлы изменены и сколько в них строк. Движок считает его перед каждым
   * шагом, чтобы агент не тратил ходы на `git status`/`git diff --stat` ради
   * первоначальной ориентации. Read-only; сбой git — пустой дайджест, а не
   * ошибка шага.
   */
  changeDigest(repoPaths: string[]): Promise<RepoChangeDigest[]>;
  /**
   * Поднимает dev-сервер репозитория в фоне и по выводу пытается определить
   * его порт. Сбой — не ошибка подготовки: возвращает `{ port: null, message }`.
   */
  startDevServer(
    repoPath: string,
    instructions: string | null,
  ): Promise<DevServerStartResult>;
}

/** Дайджест состояния одной рабочей копии для промпта агента. */
export interface RepoChangeDigest {
  /** Путь рабочей копии (он же и идентификатор репозитория в промпте). */
  repoPath: string;
  /**
   * Относительные пути затронутых файлов (`git status --porcelain`): полный
   * список того, что менял предыдущий шаг, включая untracked.
   */
  changedFiles: string[];
  /**
   * Итоговая строка `git diff --stat` (`N files changed, X insertions(+),
   * Y deletions(-)`) — масштаб изменений без дублирования списка файлов.
   * Пустая, когда diff нет (только untracked).
   */
  diffSummary: string;
  /** Сколько файлов скрыто потолком дайджеста (0 — ничего не обрезано). */
  omittedFiles: number;
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
 * Потолок числа файлов в дайджесте состояния: сверх него в промпт идут только
 * счётчики, а агент добирает `git status` сам (он видит `omittedFiles`).
 */
const CHANGE_DIGEST_MAX_FILES = 120;

/**
 * In-memory-реализация для тестов: не делает реальных git-вызовов, но помнит
 * входные аргументы и умеет притвориться падающей через `failNextWith`.
 */
export class FakeGitService implements GitService {
  readonly prepares: GitPrepareInput[] = [];
  readonly commits: GitCommitInput[] = [];
  /** Аргументы каждого вызова installDependencies (копия массива путей). */
  readonly dependenciesInstalled: string[][] = [];
  /** Аргументы каждого вызова startDevServer (путь + инструкции). */
  readonly devServersStarted: { repoPath: string; instructions: string | null }[] =
    [];
  /** Результат `startDevServer` по умолчанию; тесты могут переопределить. */
  devServerResult: DevServerStartResult = { port: 5173 };
  private pendingError: Error | null = null;

  /** Следующая операция (prepare/commitAndPush) отклонится этой ошибкой. */
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

  /**
   * Дайджест рабочей копии: тесты задают его полем `changeDigests` (по одному
   * на репозиторий в порядке `repoPaths`) и видят сами вызовы в `digestCalls`.
   * `failNextWith` его НЕ ломает: дайджест — read-only best-effort-хелпер, а
   * «следующая операция» в смысле этого фейка означает prepare/commit-push.
   * Отдельный путь отказа — `failDigestWith`.
   */
  changeDigests: RepoChangeDigest[] = [];
  readonly digestCalls: string[][] = [];
  private digestError: Error | null = null;

  /** Следующий `changeDigest` отклонится этой ошибкой (путь best-effort). */
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

      // Идемпотентность: уже склонированную рабочую копию не переклонируем —
      // повтор итерации работает с тем же кодом, что и первая.
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
      input.onRepoProgress?.(repoUrl, 'done');
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

  /**
   * Фоновый запуск dev-сервера. Команда берётся из `RUN_INSTRUCTIONS.md`
   * (`parseRunCommand`), порт ищется в stdout/stderr (`extractPort`). Процесс
   * остаётся жить после ответа; ошибки не пробрасываются — только `message`.
   */
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

      // Порт может быть уже задан флагом (`--port 5173`) — не ждём вывода.
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

  /**
   * Снимок рабочей копии для промпта: имена изменённых файлов + `--stat`.
   * Read-only и best-effort: любой сбой git даёт пустой дайджест — ориентация
   * в задаче не стоит упавшего шага. Потолок `CHANGE_DIGEST_MAX_FILES` держит
   * промпт в разумных пределах на моллах файлов (см. `omittedFiles`).
   */
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
        // Из porcelain берём только путь: флаг состояния агенту не нужен,
        // а ` -> ` у переименованных файлов оставляем целиком.
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
          // Нет diff (только untracked) — остаётся пустым.
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
    // Identity via `-c`, not the user's config: an agent container has no
    // global user.name/user.email, and `git commit` then dies with "Author
    // identity unknown". The failure used to be swallowed below, so a branch
    // with zero commits was pushed and GitHub answered 422 on MR creation.
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
      // A no-op commit is expected: the push still has to run.
      if (!isNothingToCommitError(error)) throw error;
    }

    // Push with token from env (GitHub/GitLab/Bitbucket) — без него git
    // пытается читать username с терминала и падает «No such device».
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
      // Сквош до origin/<base> создаёт новый коммит, не являющийся потомком
      // существующей remote-ветки. Без --force push будет rejected как
      // non-fast-forward (см. тест-кейс «повторный push в ту же feature-ветку»).
      pushArgs.push('--force');
    }
    if (token) {
      // Inline credential helper: username=x-access-token для GitHub,
      // остальные хосты тоже принимают такой формат.
      pushArgs.unshift(
        '-c',
        `credential.helper=!f() { echo "password=${token}"; echo "username=x-access-token"; }; f`,
      );
    }
    await this.git(pushArgs);
    return { pushed: true, branchName: input.branchName };
  }
}