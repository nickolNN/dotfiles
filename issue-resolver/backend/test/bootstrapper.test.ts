import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RunInstructionsStatus } from '@issue-resolver/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { FakeContainerController } from '../src/docker/controller';
import { FakeGitService } from '../src/git/service';
import { FakePiRunner } from '../src/pi/runner';
import {
  PiBootstrapperAgent,
  RUN_INSTRUCTIONS_FILE,
  renderBootstrapPrompt,
} from '../src/workflow/bootstrapper';
import type {
  RunInstructionsPort,
  WorkspaceProgress,
} from '../src/workflow/engine';
import { prepareWorkspace } from '../src/workflow/engine';
import { FakeBootstrapperAgent } from './fixtures/fake-bootstrapper';

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
  const root = await mkdtemp(join(tmpdir(), 'ir-bootstrapper-'));
  roots.push(root);
  return root;
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('prepareWorkspace — анализ run_instructions', () => {
  it('статус не generated: bootstrapper вызывается, инструкции и analyzing-прогресс сохранены', async () => {
    const store = new FakeRunInstructionsStore();
    store.statuses.set(REPO_URL, 'unknown');
    const agent = new FakeBootstrapperAgent({
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
        bootstrapper: (params) => {
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
      step: 'bootstrapping',
      repo: 'app',
      status: 'running',
    });
    expect(progress).toContainEqual({
      step: 'bootstrapping',
      repo: 'app',
      status: 'done',
      message: 'Инструкции сохранены',
    });
    // analyzing идёт между clone и install.
    const steps = progress.map((item) => item.step);
    expect(steps.indexOf('bootstrapping')).toBeGreaterThan(steps.indexOf('cloning'));
    expect(steps.indexOf('bootstrapping')).toBeLessThan(steps.indexOf('installing'));
  });

  it('статус generated: bootstrapper не вызывается', async () => {
    const store = new FakeRunInstructionsStore();
    store.statuses.set(REPO_URL, 'generated');
    const agent = new FakeBootstrapperAgent({
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
        bootstrapper: () => agent,
        runInstructions: store,
      },
      { id: 'issue-1' },
      repos,
      (item) => progress.push(item),
    );

    expect(agent.calls).toHaveLength(0);
    expect(progress.some((item) => item.step === 'bootstrapping')).toBe(false);
    expect(store.saved).toHaveLength(0);
  });

  it('фейл анализа: статус failed, прогресс analyzing error', async () => {
    const store = new FakeRunInstructionsStore();
    store.statuses.set(REPO_URL, 'failed');
    const agent = new FakeBootstrapperAgent({
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
        bootstrapper: () => agent,
        runInstructions: store,
      },
      { id: 'issue-1' },
      repos,
      (item) => progress.push(item),
    );

    expect(store.failed).toEqual([REPO_URL]);
    expect(store.saved).toHaveLength(0);
    expect(progress).toContainEqual({
      step: 'bootstrapping',
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
          bootstrapper: () => {
            throw new Error('bootstrapper must not run for generated');
          },
          runInstructions: store,
        },
        { id: 'issue-1' },
        repos,
      ),
    ).rejects.toThrow('install boom');

    expect(store.failed).toEqual([REPO_URL]);
  });

  it('onBootstrapStdout/Stderr получают имя репозитория вместе с выводом', async () => {
    const store = new FakeRunInstructionsStore();
    store.statuses.set(REPO_URL, 'unknown');
    const agent = new FakeBootstrapperAgent({
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
        bootstrapper: (params) => {
          // Имитируем живой вывод агента через переданные фабрике колбэки.
          params.onStdout?.('installing deps\n');
          params.onStderr?.('warning\n');
          return agent;
        },
        runInstructions: store,
        onBootstrapStdout: (repo, chunk) => stdout.push([repo, chunk]),
        onBootstrapStderr: (repo, chunk) => stderr.push([repo, chunk]),
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
        bootstrapper: () => {
          throw new Error('bootstrapper must not run for generated');
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

describe('PiBootstrapperAgent', () => {
  it('читает RUN_INSTRUCTIONS.md и передаёт отрендеренный промпт в pi', async () => {
    const root = await tempRoot();
    const repoDir = join(root, 'app');
    await mkdir(repoDir, { recursive: true });
    await writeFile(join(repoDir, RUN_INSTRUCTIONS_FILE), '# Install\nnpm install');
    const template = join(root, 'bootstrapper.md');
    await writeFile(template, 'DIR={{REPO_DIR}} NAME={{REPO_NAME}}');

    const pi = new FakePiRunner();
    const agent = new PiBootstrapperAgent({
      pi,
      containerName: 'issue-resolver-issue-1',
      hostWorkspaceDir: root,
      promptPath: template,
    });

    const result = await agent.bootstrap('/workspaces/issue-1', REPO_URL, 'app');

    expect(result).toEqual({
      success: true,
      instructions: '# Install\nnpm install',
    });
    expect(pi.calls).toHaveLength(1);
    expect(pi.calls[0].prompt).toBe('DIR=/workspaces/issue-1/app NAME=app');
    expect(pi.calls[0].options?.cwd).toBe('/workspaces/issue-1');
  });

  it('нет файла инструкции: success false с понятной причиной', async () => {
    const root = await tempRoot();
    await mkdir(join(root, 'app'), { recursive: true });
    const template = join(root, 'bootstrapper.md');
    await writeFile(template, '{{REPO_DIR}}');

    const agent = new PiBootstrapperAgent({
      pi: new FakePiRunner(),
      containerName: 'issue-resolver-issue-1',
      hostWorkspaceDir: root,
      promptPath: template,
    });

    const result = await agent.bootstrap('/workspaces/issue-1', REPO_URL, 'app');

    expect(result.success).toBe(false);
    expect(result.instructions).toBeNull();
    expect(result.error).toContain(RUN_INSTRUCTIONS_FILE);
  });

  it('renderBootstrapPrompt заменяет все вхождения плейсхолдеров', () => {
    expect(
      renderBootstrapPrompt('{{REPO_DIR}}/{{REPO_NAME}} @ {{REPO_DIR}}', '/a', 'b'),
    ).toBe('/a/b @ /a');
  });
});