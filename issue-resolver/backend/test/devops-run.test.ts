import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import type { SessionEvent, SSEEvent } from '@issue-resolver/shared';
import { SessionAddress } from '@issue-resolver/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { Db } from '../src/db/client';
import { createDb } from '../src/db/client';
import { issues, repositories } from '../src/db/schema';
import {
  getLatestStepRunForIssue,
  getStepRunWithLog,
  listStepRunsByIssue,
} from '../src/db/step-runs.repo';
import type { DevOpsAgent, DevOpsResult } from '../src/workflow/devops';
import { RUN_INSTRUCTIONS_FILE } from '../src/workflow/devops';
import type { DevOpsFactory } from '../src/workflow/engine';
import type { SseHub } from '../src/sse/hub';
import { insertTag } from '../src/db/tags.repo';
import { resetPortAllocator } from '../src/port-allocator';
import {
  collectDevOpsContext,
  isDevopsRunActive,
  runDevopsAgent,
  startRepoDevServer,
} from '../src/workflow/run-iteration.service';
import {
  isProcessAlive,
  readOwnedDevServerPid,
  stopDevServerProcess,
} from '../src/workflow/dev-server';

const REPO_URL = 'https://example.com/acme/app.git';
const NOW = '2026-06-01T00:00:00.000Z';

class RecordingSseHub implements SseHub {
  readonly events: SSEEvent[] = [];

  publish(event: SSEEvent): void {
    this.events.push(event);
  }

  subscribe(): () => void {
    return () => {};
  }

  subscribeByIssue(): () => void {
    return () => {};
  }

  subscribeGlobal(): () => void {
    return () => {};
  }
}

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'ir-devops-'));
  roots.push(root);
  return root;
}

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function seedIssue(db: Db, root: string, patch?: Partial<typeof issues.$inferInsert>) {
  const issueId = randomUUID();
  db.insert(issues)
    .values({
      id: issueId,
      title: 'DevOps run',
      jira_issue_url: null,
      pipeline_steps: ['resolve'],
      container_name: null,
      status: 'pending',
      created_at: NOW,
      updated_at: NOW,
      ...patch,
    })
    .run();
  db.insert(repositories)
    .values({
      id: randomUUID(),
      url: REPO_URL,
      full_name: 'acme/app',
      run_instructions: null,
      run_instructions_status: 'unknown',
      created_at: NOW,
      updated_at: NOW,
    })
    .run();
  return { issueId, repoDir: join(root, issueId, 'app') };
}

function makeClonedRepo(repoDir: string): void {
  mkdirSync(join(repoDir, '.git'), { recursive: true });
}

function killGroup(pid: number): void {
  if (pid <= 0) return;
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    try {
      process.kill(pid, 'SIGKILL');
    } catch (error) {
      void error;
    }
  }
}

type AgentBehaviour = (
  repoName: string,
  emit: {
    stdout: (chunk: string) => void;
    stderr: (chunk: string) => void;
    event: (event: SessionEvent) => void;
  },
) => Promise<DevOpsResult> | DevOpsResult;

function trackingFactory(behaviour: AgentBehaviour): {
  factory: DevOpsFactory;
  calls: Array<{ repoName: string; devServerPort?: number; stepRunId?: string }>;
} {
  const calls: Array<{
    repoName: string;
    devServerPort?: number;
    stepRunId?: string;
  }> = [];
  const factory: DevOpsFactory = (params) => {
    const agent: DevOpsAgent = {
      async runDevOps(_workspaceDir, _repoUrl, repoName, devServerPort) {
        calls.push({
          repoName,
          ...(devServerPort !== undefined ? { devServerPort } : {}),
          ...(params.stepRunId ? { stepRunId: params.stepRunId } : {}),
        });
        return behaviour(repoName, {
          stdout: (chunk) => params.onStdout?.(chunk),
          stderr: (chunk) => params.onStderr?.(chunk),
          event: (event) => params.onEvent?.(event),
        });
      },
    };
    return agent;
  };
  return { factory, calls };
}

function buildDeps(
  db: Db,
  root: string,
  factory: DevOpsFactory,
  sse: RecordingSseHub,
) {
  return {
    db,
    sse,
    devopsFactory: factory,
    workspaceRoot: root,
    local: true,
    devopsModel: 'gpt-test',
    devServerStartupMs: 300,
  };
}

describe('runDevopsAgent — прогон DevOps на уровне задачи', () => {
  it('создаёт devops step_run без итерации и завершает его успехом', async () => {
    const db = createDb(':memory:');
    const root = tempRoot();
    const sse = new RecordingSseHub();
    const { issueId, repoDir } = seedIssue(db, root);
    makeClonedRepo(repoDir);
    const { factory } = trackingFactory(() => ({
      success: true,
      instructions: '# Install\nnpm ci',
      stats: null,
    }));

    await runDevopsAgent(buildDeps(db, root, factory, sse), {
      issueId,
      repositories: [{ repository_url: REPO_URL }],
    });

    const run = await getLatestStepRunForIssue(db, issueId, 'devops');
    expect(run).not.toBeNull();
    expect(run?.status).toBe('success');
    expect(run?.iteration_id).toBeNull();
    expect(run?.context).toBe('manual');
    expect(isDevopsRunActive(issueId)).toBe(false);
  });

  it('пишет реальный stdout/stderr и события сессии в step_output', async () => {
    const db = createDb(':memory:');
    const root = tempRoot();
    const sse = new RecordingSseHub();
    const { issueId, repoDir } = seedIssue(db, root);
    makeClonedRepo(repoDir);
    const { factory } = trackingFactory((repoName, emit) => {
      emit.stdout(`npm ci ${repoName}`);
      emit.stderr('warn: deprecated');
      emit.event({ type: 'text', text: 'собрал инструкции' });
      return { success: true, instructions: '# Install', stats: null };
    });

    await runDevopsAgent(buildDeps(db, root, factory, sse), {
      issueId,
      repositories: [{ repository_url: REPO_URL }],
    });

    const run = await getLatestStepRunForIssue(db, issueId, 'devops');
    const withLog = await getStepRunWithLog(db, run?.id ?? '');
    expect(withLog?.stdout).toContain('npm ci app');
    expect(withLog?.stderr).toContain('warn: deprecated');
    expect(withLog?.events.map((event) => event.type)).toContain('text');
    expect(JSON.parse(withLog?.report ?? '{}').summary).toContain('1/1');
  });

  it('сохраняет сгенерированные инструкции в репозиторий задачи', async () => {
    const db = createDb(':memory:');
    const root = tempRoot();
    const sse = new RecordingSseHub();
    const { issueId, repoDir } = seedIssue(db, root);
    makeClonedRepo(repoDir);
    const { factory } = trackingFactory(() => ({
      success: true,
      instructions: '# Run\nyarn dev',
      stats: null,
    }));

    await runDevopsAgent(buildDeps(db, root, factory, sse), {
      issueId,
      repositories: [{ repository_url: REPO_URL }],
    });

    const repo = db
      .select()
      .from(repositories)
      .where(eq(repositories.url, REPO_URL))
      .get();
    expect(repo?.run_instructions).toBe('# Run\nyarn dev');
    expect(repo?.run_instructions_status).toBe('generated');
  });

  it('чистит прошлые RUN_INSTRUCTIONS.md и DEV_SERVER.sh перед прогоном', async () => {
    const db = createDb(':memory:');
    const root = tempRoot();
    const sse = new RecordingSseHub();
    const { issueId, repoDir } = seedIssue(db, root);
    makeClonedRepo(repoDir);
    writeFileSync(join(repoDir, RUN_INSTRUCTIONS_FILE), '# stale');
    writeFileSync(join(repoDir, 'DEV_SERVER.sh'), '#!/bin/sh\nstale');
    const { factory } = trackingFactory((_repoName, emit) => {
      emit.stdout('go');
      return { success: true, instructions: '# fresh', stats: null };
    });

    await runDevopsAgent(buildDeps(db, root, factory, sse), {
      issueId,
      repositories: [{ repository_url: REPO_URL }],
    });

    expect(existsSync(join(repoDir, RUN_INSTRUCTIONS_FILE))).toBe(false);
    expect(existsSync(join(repoDir, 'DEV_SERVER.sh'))).toBe(false);
  });

  it('при ошибке агента помечает прогон failed и репозиторий failed', async () => {
    const db = createDb(':memory:');
    const root = tempRoot();
    const sse = new RecordingSseHub();
    const { issueId, repoDir } = seedIssue(db, root);
    makeClonedRepo(repoDir);
    const { factory } = trackingFactory(() => ({
      success: false,
      instructions: null,
      error: 'нет package.json',
      stats: null,
    }));

    await runDevopsAgent(buildDeps(db, root, factory, sse), {
      issueId,
      repositories: [{ repository_url: REPO_URL }],
    });

    const run = await getLatestStepRunForIssue(db, issueId, 'devops');
    expect(run?.status).toBe('failed');
    expect(run?.feedback).toContain('app: нет package.json');
    const repo = db
      .select()
      .from(repositories)
      .where(eq(repositories.url, REPO_URL))
      .get();
    expect(repo?.run_instructions_status).toBe('failed');
  });

  it('не вызывает агента, когда клона нет, и объясняет причину', async () => {
    const db = createDb(':memory:');
    const root = tempRoot();
    const sse = new RecordingSseHub();
    const { issueId } = seedIssue(db, root);
    const { factory, calls } = trackingFactory(() => ({
      success: true,
      instructions: 'x',
      stats: null,
    }));

    await runDevopsAgent(buildDeps(db, root, factory, sse), {
      issueId,
      repositories: [{ repository_url: REPO_URL }],
    });

    expect(calls).toHaveLength(0);
    const run = await getLatestStepRunForIssue(db, issueId, 'devops');
    expect(run?.status).toBe('failed');
    expect(run?.feedback).toContain('клон отсутствует');
  });

  it('исключает репозитории с выключенным bootstrap', async () => {
    const db = createDb(':memory:');
    const root = tempRoot();
    const sse = new RecordingSseHub();
    const { issueId, repoDir } = seedIssue(db, root);
    makeClonedRepo(repoDir);
    const { factory, calls } = trackingFactory(() => ({
      success: true,
      instructions: 'x',
      stats: null,
    }));

    await runDevopsAgent(buildDeps(db, root, factory, sse), {
      issueId,
      repositories: [{ repository_url: REPO_URL, bootstrap_enabled: false }],
    });

    expect(calls).toHaveLength(0);
    const run = await getLatestStepRunForIssue(db, issueId, 'devops');
    expect(run?.status).toBe('failed');
    expect(run?.feedback).toContain('исключены');
  });

  it('передает порт dev-сервера и адрес сессии задачи агенту', async () => {
    const db = createDb(':memory:');
    const root = tempRoot();
    const sse = new RecordingSseHub();
    const { issueId, repoDir } = seedIssue(db, root, { dev_server_port: 5199 });
    makeClonedRepo(repoDir);
    const { factory, calls } = trackingFactory(() => ({
      success: true,
      instructions: 'x',
      stats: null,
    }));

    await runDevopsAgent(buildDeps(db, root, factory, sse), {
      issueId,
      repositories: [{ repository_url: REPO_URL }],
    });

    const sessionId = SessionAddress.forIssueRun(issueId, 'devops').toString();
    expect(calls[0]?.devServerPort).toBe(5199);
    expect(calls[0]?.stepRunId).toBe(sessionId);
  });

  it('публикует step_status: running с шагом devops и терминальный статус', async () => {
    const db = createDb(':memory:');
    const root = tempRoot();
    const sse = new RecordingSseHub();
    const { issueId, repoDir } = seedIssue(db, root);
    makeClonedRepo(repoDir);
    const { factory } = trackingFactory((_repoName, emit) => {
      emit.stdout('npm ci');
      return { success: true, instructions: 'x', stats: null };
    });

    await runDevopsAgent(buildDeps(db, root, factory, sse), {
      issueId,
      repositories: [{ repository_url: REPO_URL }],
    });

    const sessionId = SessionAddress.forIssueRun(issueId, 'devops').toString();
    const statuses = sse.events.filter(
      (event) => event.type === 'step_status' && event.stepRunId === sessionId,
    );
    expect(statuses).toHaveLength(2);
    expect(JSON.parse(statuses[0]?.data ?? '{}')).toMatchObject({
      status: 'running',
      step: 'devops',
      model: 'gpt-test',
    });
    expect(statuses[1]?.data).toBe('success');
    const logs = sse.events.filter(
      (event) => event.type === 'log' && event.stepRunId === sessionId,
    );
    expect(logs.map((event) => event.data)).toContain('npm ci');
  });

  it('второй прогон во время активного не создаёт новую запись', async () => {
    const db = createDb(':memory:');
    const root = tempRoot();
    const sse = new RecordingSseHub();
    const { issueId, repoDir } = seedIssue(db, root);
    makeClonedRepo(repoDir);
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { factory, calls } = trackingFactory(async (repoName, emit) => {
      emit.stdout('busy');
      await gate;
      return { success: true, instructions: repoName, stats: null };
    });
    const deps = buildDeps(db, root, factory, sse);

    const first = runDevopsAgent(deps, {
      issueId,
      repositories: [{ repository_url: REPO_URL }],
    });
    while (calls.length === 0) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    expect(isDevopsRunActive(issueId)).toBe(true);

    await runDevopsAgent(deps, {
      issueId,
      repositories: [{ repository_url: REPO_URL }],
      trigger: 'manual',
    });

    release();
    await first;

    const runs = await listStepRunsByIssue(db, issueId);
    expect(runs.filter((run) => run.step === 'devops')).toHaveLength(1);
  });

  it('attempt растёт с каждым прогоном задачи', async () => {
    const db = createDb(':memory:');
    const root = tempRoot();
    const sse = new RecordingSseHub();
    const { issueId, repoDir } = seedIssue(db, root);
    makeClonedRepo(repoDir);
    const { factory } = trackingFactory(() => ({
      success: true,
      instructions: 'x',
      stats: null,
    }));
    const deps = buildDeps(db, root, factory, sse);

    await runDevopsAgent(deps, {
      issueId,
      repositories: [{ repository_url: REPO_URL }],
    });
    await runDevopsAgent(deps, {
      issueId,
      repositories: [{ repository_url: REPO_URL }],
    });

    const runs = await listStepRunsByIssue(db, issueId);
    const attempts = runs
      .filter((run) => run.step === 'devops')
      .map((run) => run.attempt)
      .sort();
    expect(attempts).toEqual([1, 2]);
  });
});

describe('devops прогон — сохраняемый отчёт для UI', () => {
  it('step_output несёт report со статусом pass и сводкой по репозиториям', async () => {
    const db = createDb(':memory:');
    const root = tempRoot();
    const sse = new RecordingSseHub();
    const { issueId, repoDir } = seedIssue(db, root);
    makeClonedRepo(repoDir);
    const { factory } = trackingFactory(() => ({
      success: true,
      instructions: 'x',
      stats: null,
    }));

    await runDevopsAgent(buildDeps(db, root, factory, sse), {
      issueId,
      repositories: [{ repository_url: REPO_URL }],
    });

    const run = await getLatestStepRunForIssue(db, issueId, 'devops');
    const withLog = await getStepRunWithLog(db, run?.id ?? '');
    expect(JSON.parse(withLog?.report ?? '{}')).toMatchObject({
      status: 'pass',
      summary: 'DevOps: 1/1 репозиториев',
    });
  });

  it('освобождает флаг активного прогона даже при неудаче', async () => {
    const db = createDb(':memory:');
    const root = tempRoot();
    const sse = new RecordingSseHub();
    const { issueId, repoDir } = seedIssue(db, root);
    makeClonedRepo(repoDir);
    const { factory } = trackingFactory(() => ({
      success: false,
      instructions: null,
      error: 'упал',
      stats: null,
    }));

    await runDevopsAgent(buildDeps(db, root, factory, sse), {
      issueId,
      repositories: [{ repository_url: REPO_URL }],
    });

    expect(isDevopsRunActive(issueId)).toBe(false);
  });

  it('пишет инструкции в строку с browse-URL, когда задача ссылается на clone-URL', async () => {
    const db = createDb(':memory:');
    const root = tempRoot();
    const sse = new RecordingSseHub();
    const { issueId } = seedIssue(db, root);
    db.update(repositories)
      .set({
        url: 'https://b.yadro.com/projects/KOS/repos/metromost_web/browse',
        clone_url: 'https://b.yadro.com/scm/kos/metromost_web.git',
      })
      .where(eq(repositories.url, REPO_URL))
      .run();
    makeClonedRepo(join(root, issueId, 'metromost_web'));
    const { factory } = trackingFactory(() => ({
      success: true,
      instructions: '# Install\npnpm ci',
      stats: null,
    }));

    await runDevopsAgent(buildDeps(db, root, factory, sse), {
      issueId,
      repositories: [
        { repository_url: 'https://b.yadro.com/scm/kos/metromost_web.git' },
      ],
    });

    const repo = db
      .select()
      .from(repositories)
      .where(eq(repositories.url, 'https://b.yadro.com/projects/KOS/repos/metromost_web/browse'))
      .get();
    expect(repo?.run_instructions).toBe('# Install\npnpm ci');
    expect(repo?.run_instructions_status).toBe('generated');
  });

  it('отмечает failed именно ту строку реестра, где лежит browse-URL', async () => {
    const db = createDb(':memory:');
    const root = tempRoot();
    const sse = new RecordingSseHub();
    const { issueId } = seedIssue(db, root);
    db.update(repositories)
      .set({
        url: 'https://b.yadro.com/projects/KOS/repos/metromost_web/browse',
        clone_url: null,
        run_instructions: '# Старые инструкции',
        run_instructions_status: 'generated',
      })
      .where(eq(repositories.url, REPO_URL))
      .run();
    makeClonedRepo(join(root, issueId, 'metromost_web'));
    const { factory } = trackingFactory(() => ({
      success: false,
      instructions: null,
      error: 'dev-сервер не поднялся',
      stats: null,
    }));

    await runDevopsAgent(buildDeps(db, root, factory, sse), {
      issueId,
      repositories: [
        { repository_url: 'https://b.yadro.com/scm/kos/metromost_web.git' },
      ],
    });

    const repo = db
      .select()
      .from(repositories)
      .where(eq(repositories.url, 'https://b.yadro.com/projects/KOS/repos/metromost_web/browse'))
      .get();
    expect(repo?.run_instructions_status).toBe('failed');
    expect(repo?.run_instructions).toBeNull();
  });
});

describe('collectDevOpsContext — имена репозиториев из реестра', () => {
  it('называет репозиторий по тегу его настоящим именем, а не хвостом browse-URL', () => {
    const db = createDb(':memory:');
    const root = tempRoot();
    const repoId = randomUUID();
    db.insert(repositories)
      .values({
        id: repoId,
        url: 'https://b.yadro.com/projects/KOS/repos/metromost_web/browse',
        clone_url: 'https://b.yadro.com/scm/kos/metromost_web.git',
        run_instructions: '# Install\npnpm ci',
        run_instructions_status: 'generated',
        created_at: NOW,
        updated_at: NOW,
      })
      .run();
    const tag = insertTag(db, {
      name: 'metromost',
      repositories: [{ repository_id: repoId, bootstrap_enabled: true }],
    });
    const { issueId } = seedIssue(db, root, { tag_id: tag.id });

    const context = collectDevOpsContext(db, issueId, [
      { repository_url: 'https://b.yadro.com/scm/kos/metromost_web.git' },
    ]);

    expect(context.reposNames).toBe('metromost_web');
    expect(context.reposRequireDevServer).toBe('metromost_web');
    expect(context.reposInstructions).toContain('### metromost_web');
    expect(context.reposInstructions).toContain('pnpm ci');
  });
});

describe('entry-порт владеет система, а не агент', () => {
  afterEach(() => {
    resetPortAllocator();
  });

  it('ран без назначенного порту получает порт из диапазона и записывает его в задачу', async () => {
    const db = createDb(':memory:');
    const root = tempRoot();
    const sse = new RecordingSseHub();
    const { issueId, repoDir } = seedIssue(db, root);
    makeClonedRepo(repoDir);
    const { factory, calls } = trackingFactory(() => ({
      success: true,
      instructions: '# Run\nnpm start',
      stats: null,
    }));

    await runDevopsAgent(buildDeps(db, root, factory, sse), {
      issueId,
      repositories: [{ repository_url: REPO_URL }],
    });

    const port = calls[0]?.devServerPort;
    expect(port).toBeGreaterThanOrEqual(5100);
    expect(port).toBeLessThanOrEqual(5299);
    const stored = db
      .select({ port: issues.dev_server_port })
      .from(issues)
      .where(eq(issues.id, issueId))
      .get()?.port;
    expect(stored).toBe(port);
  });

  it('ничего не собрано — порт возвращается аллокатору, задача очищена', async () => {
    const db = createDb(':memory:');
    const root = tempRoot();
    const sse = new RecordingSseHub();
    const { issueId, repoDir } = seedIssue(db, root);
    makeClonedRepo(repoDir);
    const { factory, calls } = trackingFactory(() => ({
      success: false,
      instructions: null,
      error: 'сборка не удалась',
      stats: null,
    }));

    await runDevopsAgent(buildDeps(db, root, factory, sse), {
      issueId,
      repositories: [{ repository_url: REPO_URL }],
    });

    expect(calls[0]?.devServerPort).toBeDefined();
    expect(
      db
        .select({ port: issues.dev_server_port })
        .from(issues)
        .where(eq(issues.id, issueId))
        .get()?.port,
    ).toBeNull();
  });
});

describe('startRepoDevServer передаёт системе выделенный порт скрипту', () => {
  it('DEV_SERVER.sh видит PORT, который выделила система', async () => {
    const root = tempRoot();
    const repoDir = join(root, 'app');
    mkdirSync(repoDir, { recursive: true });
    const scriptPath = join(repoDir, 'DEV_SERVER.sh');
    const marker = join(repoDir, 'port.txt');
    writeFileSync(scriptPath, `#!/bin/sh\necho "$PORT" > "${marker}"\n`);
    chmodSync(scriptPath, 0o755);

    const pid = startRepoDevServer(root, 'app', 5199);
    expect(pid).not.toBeNull();

    const readMarker = () =>
      existsSync(marker) ? readFileSync(marker, 'utf8').trim() : '';

    const deadline = Date.now() + 3000;
    let port = readMarker();
    while (port === '' && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      port = readMarker();
    }

    expect(port).toBe('5199');
    try {
      process.kill(pid as number, 'SIGKILL');
    } catch (error) {
      void error;
    }
  });
});

describe('учёт dev-сервера после прогона DevOps', () => {
  it('startRepoDevServer оставляет pid в .dev-server.pid и снимает его без скрипта', () => {
    const root = tempRoot();
    const repoDir = join(root, 'app');
    mkdirSync(repoDir, { recursive: true });
    const pidFile = join(repoDir, '.dev-server.pid');

    expect(startRepoDevServer(root, 'app', 5198)).toBeNull();
    expect(existsSync(pidFile)).toBe(false);

    const scriptPath = join(repoDir, 'DEV_SERVER.sh');
    writeFileSync(scriptPath, '#!/bin/sh\nexec sleep 30\n');
    chmodSync(scriptPath, 0o755);

    const pid = startRepoDevServer(root, 'app', 5198);
    expect(pid).toBeGreaterThan(0);
    expect(readFileSync(pidFile, 'utf8').trim()).toBe(String(pid));

    try {
      process.kill(-(pid as number), 'SIGKILL');
    } catch {
      process.kill(pid as number, 'SIGKILL');
    }
    rmSync(pidFile, { force: true });
  });

  it('принимает оставленный агентом сервер: pid в БД, статус success', async () => {
    const db = createDb(':memory:');
    const root = tempRoot();
    const sse = new RecordingSseHub();
    const { issueId, repoDir } = seedIssue(db, root);
    makeClonedRepo(repoDir);
    const server = createServer((_request, response) => response.end('ok'));
    let port = 0;
    let agentPid = 0;

    const factory: DevOpsFactory = () => ({
      async runDevOps(_workspaceDir, _repoUrl, _repoName, devServerPort) {
        port = devServerPort ?? 0;
        writeFileSync(join(repoDir, 'DEV_SERVER.sh'), '#!/bin/sh\nexec sleep 30\n');
        chmodSync(join(repoDir, 'DEV_SERVER.sh'), 0o755);
        const child = spawn('sleep', ['30'], {
          cwd: repoDir,
          detached: true,
          stdio: 'ignore',
        });
        child.unref();
        agentPid = child.pid ?? 0;
        writeFileSync(join(repoDir, '.dev-server.pid'), `${agentPid}\n`);
        await new Promise<void>((resolve) =>
          server.listen(port, '127.0.0.1', () => resolve()),
        );
        return { success: true, instructions: '# Run', stats: null };
      },
    });

    try {
      await runDevopsAgent(buildDeps(db, root, factory, sse), {
        issueId,
        repositories: [{ repository_url: REPO_URL }],
      });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      killGroup(agentPid);
    }

    const run = await getLatestStepRunForIssue(db, issueId, 'devops');
    expect(run?.status).toBe('success');
    const issue = db.select().from(issues).where(eq(issues.id, issueId)).get();
    expect(issue?.dev_server_port).toBe(port);
    expect(issue?.dev_server_pid).toBe(agentPid);
    expect(agentPid).toBeGreaterThan(0);
  });

  it('помечает репозиторий failed, если скрипт есть, а порт не отвечает', async () => {
    const db = createDb(':memory:');
    const root = tempRoot();
    const sse = new RecordingSseHub();
    const { issueId, repoDir } = seedIssue(db, root);
    makeClonedRepo(repoDir);
    const { factory } = trackingFactory(() => {
      writeFileSync(join(repoDir, 'DEV_SERVER.sh'), '#!/bin/sh\nexit 1\n');
      chmodSync(join(repoDir, 'DEV_SERVER.sh'), 0o755);
      return { success: true, instructions: '# Run', stats: null };
    });

    await runDevopsAgent(buildDeps(db, root, factory, sse), {
      issueId,
      repositories: [{ repository_url: REPO_URL }],
    });

    const run = await getLatestStepRunForIssue(db, issueId, 'devops');
    expect(run?.status).toBe('failed');
    expect(run?.feedback).toContain('dev server не отвечает');
    const issue = db.select().from(issues).where(eq(issues.id, issueId)).get();
    expect(issue?.dev_server_pid).toBeNull();
  });
});

describe('чужой процесс не получает pid-файл задачи', () => {
  it('readOwnedDevServerPid игнорирует pid процесса из другой директории', () => {
    const root = tempRoot();
    const repoDir = join(root, 'app');
    mkdirSync(repoDir, { recursive: true });
    const foreign = spawn('sleep', ['30'], { stdio: 'ignore' });
    try {
      writeFileSync(join(repoDir, '.dev-server.pid'), `${foreign.pid}\n`);
      expect(readOwnedDevServerPid(root, 'app')).toBeNull();
    } finally {
      killGroup(foreign.pid ?? 0);
    }
  });

  it('readOwnedDevServerPid принимает pid процесса, запущенного из репозитория', async () => {
    const root = tempRoot();
    const repoDir = join(root, 'app');
    mkdirSync(repoDir, { recursive: true });
    const own = spawn('sleep', ['30'], {
      cwd: repoDir,
      detached: true,
      stdio: 'ignore',
    });
    own.unref();
    const pid = own.pid ?? 0;
    try {
      writeFileSync(join(repoDir, '.dev-server.pid'), `${pid}\n`);
      const deadline = Date.now() + 2000;
      while (!existsSync(`/proc/${pid}/cwd`) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(pid).toBeGreaterThan(0);
      expect(readOwnedDevServerPid(root, 'app')).toBe(pid);
    } finally {
      killGroup(pid);
    }
  });

  it('stopDevServerProcess не убивает процесс, чья cwd вне рабочей папки', async () => {
    const root = tempRoot();
    const repoDir = join(root, 'app');
    mkdirSync(repoDir, { recursive: true });
    const foreign = spawn('sleep', ['30'], { stdio: 'ignore' });
    const pid = foreign.pid ?? 0;
    await stopDevServerProcess(pid, repoDir);
    expect(isProcessAlive(pid)).toBe(true);
    killGroup(pid);
  });
});

describe('занятый порт задачи', () => {
  afterEach(() => {
    resetPortAllocator();
  });

  it('выделяет новый порт, если сохранённый держит чужой процесс', async () => {
    const db = createDb(':memory:');
    const root = tempRoot();
    const sse = new RecordingSseHub();
    const foreign = createServer((_request, response) => response.end('foreign'));
    await new Promise<void>((resolve) =>
      foreign.listen(0, '127.0.0.1', () => resolve()),
    );
    const occupied = (foreign.address() as { port: number }).port;
    const { issueId, repoDir } = seedIssue(db, root, {
      dev_server_port: occupied,
      dev_server_pid: null,
    });
    makeClonedRepo(repoDir);
    const { factory, calls } = trackingFactory(() => ({
      success: true,
      instructions: '# Run\nnpm start',
      stats: null,
    }));

    try {
      await runDevopsAgent(buildDeps(db, root, factory, sse), {
        issueId,
        repositories: [{ repository_url: REPO_URL }],
      });
    } finally {
      await new Promise<void>((resolve) => foreign.close(() => resolve()));
    }

    const allocated = calls[0]?.devServerPort;
    expect(allocated).toBeDefined();
    expect(allocated).not.toBe(occupied);
    expect(allocated).toBeGreaterThanOrEqual(5100);
    expect(allocated).toBeLessThanOrEqual(5299);
    expect(
      db
        .select({ port: issues.dev_server_port })
        .from(issues)
        .where(eq(issues.id, issueId))
        .get()?.port,
    ).toBe(allocated);
  });
});
