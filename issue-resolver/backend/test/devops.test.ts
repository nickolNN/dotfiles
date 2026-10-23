import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RunInstructionsStatus } from '@issue-resolver/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FakeContainerController } from '../src/docker/controller';
import { devOpsFactoryFor } from '../src/deps';
import { FakeGitService } from '../src/git/service';
import { FakePiRunner } from '../src/pi/runner';
import { RpcPiRunner } from '../src/pi/rpc-runner';
import { InMemoryStepSessionRegistry } from '../src/pi/session-registry';
import {
  PiDevOpsAgent,
  RUN_INSTRUCTIONS_FILE,
  renderDevOpsPrompt,
} from '../src/workflow/devops';
import type {
  RunInstructionsPort,
  WorkspaceProgress,
} from '../src/workflow/engine';
import { prepareWorkspace } from '../src/workflow/engine';
import { FakeDevOpsAgent } from './fixtures/fake-devops';

vi.mock('node:child_process', () => ({ spawn: vi.fn(), execFile: vi.fn() }));

import { spawn } from 'node:child_process';

const spawnMock = vi.mocked(spawn);

const REPO_URL = 'https://example.com/acme/app.git';
const repos = [{ repository_url: REPO_URL, base_branch: 'main' }];

/** In-memory-реализация порта `run_instructions*` для тестов хука. */
class FakeRunInstructionsStore implements RunInstructionsPort {
  readonly statuses = new Map<string, RunInstructionsStatus>();
  readonly instructions = new Map<string, string>();
  readonly saved: { url: string; instructions: string }[] = [];
  readonly failed: string[] = [];

  getStatus(repoUrl: string): RunInstructionsStatus | undefined {
    return this.statuses.get(repoUrl);
  }

  getInstructions(repoUrl: string): string | null {
    return this.instructions.get(repoUrl) ?? null;
  }

  saveGenerated(repoUrl: string, instructions: string): void {
    this.saved.push({ url: repoUrl, instructions });
    this.instructions.set(repoUrl, instructions);
    this.statuses.set(repoUrl, 'generated');
  }

  saveFailed(repoUrl: string): void {
    this.failed.push(repoUrl);
    this.statuses.set(repoUrl, 'failed');
  }
}

/** Git-сервис, у которого падает именно install (prepare проходит). */
class FailingInstallGitService extends FakeGitService {
  override async installDependencies(): Promise<void> {
    throw new Error('install boom');
  }
}

const roots: string[] = [];

const tempRoot = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), 'ir-devops-'));
  roots.push(root);
  return root;
};

/** Фейковый child process: EventEmitter + ручные stdout/stderr и запись stdin. */
function makeFakeChild(): EventEmitter & {
  stdin: { writable: boolean; write: (chunk: string) => boolean };
  stdout: EventEmitter;
  stderr: EventEmitter;
  killed: boolean;
  kill: (signal?: string) => boolean;
} {
  const child = new EventEmitter() as EventEmitter & {
    stdin: { writable: boolean; write: (chunk: string) => boolean };
    stdout: EventEmitter;
    stderr: EventEmitter;
    killed: boolean;
    kill: (signal?: string) => boolean;
  };
  child.stdin = { writable: true, write: () => true };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.killed = false;
  child.kill = () => {
    child.killed = true;
    return true;
  };
  return child;
}

const emit = (
  child: EventEmitter & { stdout: EventEmitter },
  event: Record<string, unknown>,
): void => {
  child.stdout.emit('data', Buffer.from(`${JSON.stringify(event)}\n`));
};

/** Закрывает RPC-сессию так, чтобы `run()` резолвился (settle + stats). */
const settle = (child: EventEmitter & { stdout: EventEmitter }): void => {
  emit(child, { type: 'agent_settled', aborted: false });
  emit(child, {
    type: 'response',
    command: 'get_session_stats',
    success: true,
    data: { sessionId: 's1' },
  });
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('prepareWorkspace — анализ run_instructions', () => {
  it('статус не generated: devops вызывается, инструкции и analyzing-прогресс сохранены', async () => {
    const store = new FakeRunInstructionsStore();
    store.statuses.set(REPO_URL, 'unknown');
    const agent = new FakeDevOpsAgent({
      success: true,
      instructions: '# Run\nnpm ci',
    });
    const factoryCalls: { containerName: string; hostWorkspaceDir: string; containerWorkspaceDir: string }[] = [];
    const progress: WorkspaceProgress[] = [];
    const root = await tempRoot();

    await prepareWorkspace(
      {
        container: new FakeContainerController(),
        git: new FakeGitService(),
        workspaceRoot: root,
        devops: (params) => {
          factoryCalls.push({
            containerName: params.containerName,
            hostWorkspaceDir: params.hostWorkspaceDir,
            containerWorkspaceDir: params.containerWorkspaceDir,
          });
          return agent;
        },
        runInstructions: store,
      },
      { id: 'issue-1' },
      repos,
      (item) => progress.push(item),
    );

    expect(agent.calls).toEqual([
      {
        workspaceDir: '/workspaces/issue-1',
        repoUrl: REPO_URL,
        repoName: 'app',
      },
    ]);
    expect(factoryCalls).toEqual([
      {
        containerName: 'issue-resolver-issue-1',
        hostWorkspaceDir: join(root, 'issue-1'),
        containerWorkspaceDir: '/workspaces/issue-1',
      },
    ]);
    expect(store.saved).toEqual([
      { url: REPO_URL, instructions: '# Run\nnpm ci' },
    ]);
    expect(progress).toContainEqual({
      step: 'devops',
      repo: 'app',
      status: 'running',
    });
    expect(progress).toContainEqual({
      step: 'devops',
      repo: 'app',
      status: 'done',
      message: 'Инструкции сохранены',
    });
    // analyzing идёт между clone и install.
    const steps = progress.map((item) => item.step);
    expect(steps.indexOf('devops')).toBeGreaterThan(steps.indexOf('cloning'));
    expect(steps.indexOf('devops')).toBeLessThan(steps.indexOf('installing'));
  });

  it('статус generated: devops не вызывается', async () => {
    const store = new FakeRunInstructionsStore();
    store.statuses.set(REPO_URL, 'generated');
    const agent = new FakeDevOpsAgent({
      success: true,
      instructions: 'unused',
    });
    const progress: WorkspaceProgress[] = [];
    const root = await tempRoot();

    await prepareWorkspace(
      {
        container: new FakeContainerController(),
        git: new FakeGitService(),
        workspaceRoot: root,
        devops: () => agent,
        runInstructions: store,
      },
      { id: 'issue-1' },
      repos,
      (item) => progress.push(item),
    );

    expect(agent.calls).toHaveLength(0);
    expect(progress.some((item) => item.step === 'devops')).toBe(false);
    expect(store.saved).toHaveLength(0);
  });

  it('фейл анализа: статус failed, прогресс analyzing error', async () => {
    const store = new FakeRunInstructionsStore();
    store.statuses.set(REPO_URL, 'failed');
    const agent = new FakeDevOpsAgent({
      success: false,
      instructions: null,
      error: 'no lockfile found',
    });
    const progress: WorkspaceProgress[] = [];
    const root = await tempRoot();

    await prepareWorkspace(
      {
        container: new FakeContainerController(),
        git: new FakeGitService(),
        workspaceRoot: root,
        devops: () => agent,
        runInstructions: store,
      },
      { id: 'issue-1' },
      repos,
      (item) => progress.push(item),
    );

    expect(store.failed).toEqual([REPO_URL]);
    expect(store.saved).toHaveLength(0);
    expect(progress).toContainEqual({
      step: 'devops',
      repo: 'app',
      status: 'error',
      message: 'no lockfile found',
    });
  });

  it('фейл install сбрасывает ранее generated инструкции в failed', async () => {
    const store = new FakeRunInstructionsStore();
    store.statuses.set(REPO_URL, 'generated');
    const root = await tempRoot();

    await expect(
      prepareWorkspace(
        {
          container: new FakeContainerController(),
          git: new FailingInstallGitService(),
          workspaceRoot: root,
          devops: () => {
            throw new Error('devops must not run for generated');
          },
          runInstructions: store,
        },
        { id: 'issue-1' },
        repos,
      ),
    ).rejects.toThrow('install boom');

    expect(store.failed).toEqual([REPO_URL]);
  });

  it('onDevOpsStdout/Stderr получают имя репозитория вместе с выводом', async () => {
    const store = new FakeRunInstructionsStore();
    store.statuses.set(REPO_URL, 'unknown');
    const agent = new FakeDevOpsAgent({
      success: true,
      instructions: '# Run',
    });
    const stdout: Array<[string, string]> = [];
    const stderr: Array<[string, string]> = [];
    const root = await tempRoot();

    await prepareWorkspace(
      {
        container: new FakeContainerController(),
        git: new FakeGitService(),
        workspaceRoot: root,
        devops: (params) => {
          // Имитируем живой вывод агента через переданные фабрике колбэки.
          params.onStdout?.('installing deps\n');
          params.onStderr?.('warning\n');
          return agent;
        },
        runInstructions: store,
        onDevOpsStdout: (repo, chunk) => stdout.push([repo, chunk]),
        onDevOpsStderr: (repo, chunk) => stderr.push([repo, chunk]),
      },
      { id: 'issue-1' },
      repos,
    );

    expect(stdout).toEqual([['app', 'installing deps\n']]);
    expect(stderr).toEqual([['app', 'warning\n']]);
  });
});

describe('prepareWorkspace — запуск dev-сервера', () => {
  const enabledRepo = [{ repository_url: REPO_URL, base_branch: 'main' }];

  it('после install поднимает dev-сервер и публикует devPort', async () => {
    const store = new FakeRunInstructionsStore();
    store.statuses.set(REPO_URL, 'generated');
    store.instructions.set(REPO_URL, '## Run\n```bash\nnpm run dev\n```');
    const git = new FakeGitService();
    const progress: WorkspaceProgress[] = [];
    const root = await tempRoot();
    const repoDir = join(root, 'issue-1', 'app');

    await prepareWorkspace(
      {
        container: new FakeContainerController(),
        git,
        workspaceRoot: root,
        devops: () => {
          throw new Error('devops must not run for generated');
        },
        runInstructions: store,
      },
      { id: 'issue-1' },
      enabledRepo,
      (item) => progress.push(item),
    );

    expect(git.devServersStarted).toEqual([
      {
        repoPath: repoDir,
        instructions: '## Run\n```bash\nnpm run dev\n```',
      },
    ]);
    expect(progress).toContainEqual({
      step: 'dev_server',
      repo: 'app',
      status: 'running',
    });
    expect(progress).toContainEqual({
      step: 'dev_server',
      repo: 'app',
      status: 'done',
      message: 'localhost:5173',
      devPort: 5173,
    });
    const steps = progress.map((item) => item.step);
    expect(steps.indexOf('dev_server')).toBeGreaterThan(steps.indexOf('installing'));
    expect(steps.indexOf('dev_server')).toBeLessThan(steps.lastIndexOf('ready'));
  });

  it('порт не найден → warning, подготовка всё равно ready', async () => {
    const store = new FakeRunInstructionsStore();
    store.statuses.set(REPO_URL, 'generated');
    const git = new FakeGitService();
    git.devServerResult = { port: null, message: 'порт не найден' };
    const progress: WorkspaceProgress[] = [];
    const root = await tempRoot();

    await prepareWorkspace(
      {
        container: new FakeContainerController(),
        git,
        workspaceRoot: root,
        runInstructions: store,
      },
      { id: 'issue-1' },
      enabledRepo,
      (item) => progress.push(item),
    );

    expect(progress).toContainEqual({
      step: 'dev_server',
      repo: 'app',
      status: 'warning',
      message: 'порт не найден',
    });
    expect(progress).toContainEqual({ step: 'ready', status: 'done' });
  });

  it('bootstrap_enabled=false → dev-сервер не запускается', async () => {
    const git = new FakeGitService();
    const progress: WorkspaceProgress[] = [];
    const root = await tempRoot();

    await prepareWorkspace(
      {
        container: new FakeContainerController(),
        git,
        workspaceRoot: root,
        runInstructions: new FakeRunInstructionsStore(),
      },
      { id: 'issue-1' },
      [{ repository_url: REPO_URL, base_branch: 'main', bootstrap_enabled: false }],
      (item) => progress.push(item),
    );

    expect(git.devServersStarted).toEqual([]);
    expect(progress.some((item) => item.step === 'dev_server')).toBe(false);
  });
});

describe('PiDevOpsAgent', () => {
  it('читает RUN_INSTRUCTIONS.md и передаёт отрендеренный промпт в pi', async () => {
    const root = await tempRoot();
    const repoDir = join(root, 'app');
    await mkdir(repoDir, { recursive: true });
    await writeFile(join(repoDir, RUN_INSTRUCTIONS_FILE), '# Install\nnpm install');
    const template = join(root, 'devops.md');
    await writeFile(template, 'DIR={{REPO_DIR}} NAME={{REPO_NAME}}');

    const pi = new FakePiRunner();
    const agent = new PiDevOpsAgent({
      pi,
      containerName: 'issue-resolver-issue-1',
      hostWorkspaceDir: root,
      promptPath: template,
    });

    const result = await agent.runDevOps('/workspaces/issue-1', REPO_URL, 'app');

    expect(result).toEqual({
      success: true,
      instructions: '# Install\nnpm install',
    });
    expect(pi.calls).toHaveLength(1);
    expect(pi.calls[0].prompt).toBe('DIR=/workspaces/issue-1/app NAME=app');
    expect(pi.calls[0].options?.cwd).toBe('/workspaces/issue-1');
  });

  // Последнее звено цепочки thinking effort, которое нельзя доказать типами:
  // опция агента должна доехать до `pi.run`, а оттуда — до argv
  // `['--thinking', level]` (явный тест argv — в rpc-runner.test.ts).
  it('пробрасывает thinkingLevel в pi.run', async () => {
    const root = await tempRoot();
    await mkdir(join(root, 'app'), { recursive: true });
    await writeFile(join(root, 'app', RUN_INSTRUCTIONS_FILE), '# Run');
    const template = join(root, 'devops.md');
    await writeFile(template, '{{REPO_DIR}}');

    const pi = new FakePiRunner();
    const agent = new PiDevOpsAgent({
      pi,
      containerName: 'issue-resolver-issue-1',
      hostWorkspaceDir: root,
      thinkingLevel: 'xhigh',
      promptPath: template,
    });

    await agent.runDevOps('/workspaces/issue-1', REPO_URL, 'app');

    expect(pi.calls).toHaveLength(1);
    expect(pi.calls[0].options?.thinkingLevel).toBe('xhigh');
  });

  // Полный путь через боевой RpcPiRunner: опция агента должна оказаться в argv
  // реального spawn, а не остаться в объекте опций.
  it('thinkingLevel доезжает до argv spawn (--thinking high)', async () => {
    const root = await tempRoot();
    await mkdir(join(root, 'app'), { recursive: true });
    await writeFile(join(root, 'app', RUN_INSTRUCTIONS_FILE), '# Run');
    const template = join(root, 'devops.md');
    await writeFile(template, '{{REPO_DIR}}');

    const child = makeFakeChild();
    spawnMock.mockReturnValue(child as unknown as ChildProcess);

    const agent = new PiDevOpsAgent({
      pi: new RpcPiRunner('resolve', 'local'),
      containerName: 'issue-resolver-issue-1',
      hostWorkspaceDir: root,
      thinkingLevel: 'high',
      promptPath: template,
    });

    const promise = agent.runDevOps('/workspaces/issue-1', REPO_URL, 'app');

    const args = spawnMock.mock.calls[0][1] as string[];
    expect(args[args.indexOf('--thinking') + 1]).toBe('high');

    settle(child);
    await promise;
    spawnMock.mockReset();
  });

  it('нет файла инструкции: success false с понятной причиной', async () => {
    const root = await tempRoot();
    await mkdir(join(root, 'app'), { recursive: true });
    const template = join(root, 'devops.md');
    await writeFile(template, '{{REPO_DIR}}');

    const agent = new PiDevOpsAgent({
      pi: new FakePiRunner(),
      containerName: 'issue-resolver-issue-1',
      hostWorkspaceDir: root,
      promptPath: template,
    });

    const result = await agent.runDevOps('/workspaces/issue-1', REPO_URL, 'app');

    expect(result.success).toBe(false);
    expect(result.instructions).toBeNull();
    expect(result.error).toContain(RUN_INSTRUCTIONS_FILE);
  });

  it('renderDevOpsPrompt заменяет все вхождения плейсхолдеров', () => {
    expect(
      renderDevOpsPrompt('{{REPO_DIR}}/{{REPO_NAME}} @ {{REPO_DIR}}', '/a', 'b'),
    ).toBe('/a/b @ /a');
  });
});

// Регрессия: раньше `devOpsFactoryFor` деструктурировал только 7 имён и молча
// терял эти пять полей — tsc такое не ловит. Проверяем на боевой фабрике.
describe('devOpsFactoryFor — проброс полей в pi.run', () => {
  it('issueId/iterationId/stepRunId/registry и tagInstructions не теряются', async () => {
    const root = await tempRoot();
    await mkdir(join(root, 'app'), { recursive: true });
    await writeFile(join(root, 'app', RUN_INSTRUCTIONS_FILE), '# Run');

    const pi = new FakePiRunner();
    const registry = new InMemoryStepSessionRegistry();
    const tagInstructions = '## Tag\nrun proxy on :8081';
    const factory = devOpsFactoryFor(pi as unknown as RpcPiRunner, 5000);

    const agent = factory({
      containerName: 'issue-resolver-issue-1',
      hostWorkspaceDir: root,
      containerWorkspaceDir: '/workspaces/issue-1',
      issueId: 'issue-1',
      iterationId: 'iter-1',
      stepRunId: 'issue-1/devops',
      registry,
      tagInstructions,
      model: 'opus',
      thinkingLevel: 'high',
      timeoutMs: 1234,
      onStdout: () => {},
      onStderr: () => {},
    });

    await agent.runDevOps('/workspaces/issue-1', REPO_URL, 'app');

    expect(pi.calls).toHaveLength(1);
    expect(pi.calls[0].options).toMatchObject({
      issueId: 'issue-1',
      iterationId: 'iter-1',
      stepRunId: 'issue-1/devops',
      registry,
    });
    // tagInstructions не уходит в pi.run — он подставляется в промпт.
    expect(pi.calls[0].prompt).toContain('run proxy on :8081');
  });
});