import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import {
  IssueRunKind,
  PipelineStep,
  SessionAddress,
  StepRunStatus,
  extractRepoNameFromUrl,
} from '@issue-resolver/shared';
import type { Db } from '../db/client';
import { issues } from '../db/schema';
import type { StepSessionRegistry } from '../pi/session-registry';
import type { SseHub } from '../sse/hub';
import { allocateDevPort, releaseIssueDevPorts } from '../port-allocator';
import {
  DEFAULT_WORKSPACE_ROOT,
  containerNameFor,
  workspaceContainerDirFor,
  workspaceHostDirFor,
} from '../workspace/paths';
import { dbRunInstructionsStore } from './db-adapters';
import {
  collectDevOpsContext,
  finishDevopsSession,
  isDevopsRunActive,
  startDevopsSession,
  type DevOpsRunRepos,
} from './devops-session';
import { RUN_INSTRUCTIONS_FILE } from './devops';
import {
  DEV_SERVER_LOG_FILE,
  DEV_SERVER_PID_FILE,
  DEV_SERVER_SCRIPT,
  clearDevServerPid,
  devServerResponds,
  readDevServerLogTail,
  readDevServerPid,
} from './dev-server';
import type { DevOpsFactory } from './prepare-workspace';
import type { DevopsModelSettings } from './run-deps';
import { skipIfActive } from '../util/active-runs';
import { messageOf } from '../util/errors';

export interface DevopsRunDeps extends DevopsModelSettings {
  db: Db;
  sse: SseHub;
  devopsFactory: DevOpsFactory;
  control?: StepSessionRegistry;
  workspaceRoot?: string;
  local?: boolean;
}

export interface RunDevopsAgentInput {
  issueId: string;
  repositories: DevOpsRunRepos[];
  trigger?: string;
}

function clearDevOpsArtifacts(hostDir: string, repoName: string): void {
  const repoDir = join(hostDir, repoName);
  rmSync(join(repoDir, RUN_INSTRUCTIONS_FILE), { force: true });
  rmSync(join(repoDir, DEV_SERVER_SCRIPT), { force: true });
  rmSync(join(repoDir, DEV_SERVER_PID_FILE), { force: true });
  rmSync(join(repoDir, DEV_SERVER_LOG_FILE), { force: true });
}

export async function runDevopsAgent(
  deps: DevopsRunDeps,
  input: RunDevopsAgentInput,
): Promise<void> {
  const sessionId = SessionAddress.forIssueRun(
    input.issueId,
    IssueRunKind.devops,
  ).toString();

  if (
    skipIfActive(isDevopsRunActive, IssueRunKind.devops, input.issueId, input.trigger)
  ) {
    return;
  }

  const handle = await startDevopsSession(deps.db, deps, {
    issueId: input.issueId,
    sessionId,
    context: input.trigger ?? 'manual',
    enabled: true,
  });
  if (!handle) return;

  const hostDir = workspaceHostDirFor(
    deps.workspaceRoot ?? DEFAULT_WORKSPACE_ROOT,
    input.issueId,
  );
  const containerDir = deps.local
    ? hostDir
    : workspaceContainerDirFor(input.issueId);
  const runStore = dbRunInstructionsStore(deps.db);
  const storedPort =
    deps.db
      .select({ port: issues.dev_server_port })
      .from(issues)
      .where(eq(issues.id, input.issueId))
      .get()?.port ?? undefined;
  let devPort = storedPort;
  let portAllocatedNow = false;

  const startedAt = Date.now();
  console.log(
    `devops agent started: issue=${input.issueId} trigger=${input.trigger ?? 'manual'} at=${new Date(startedAt).toISOString()}`,
  );

  try {
    const targets = input.repositories.filter(
      (repo) => repo.bootstrap_enabled !== false,
    );
    if (targets.length === 0) {
      await finishDevopsSession(deps.db, deps, handle, {
        issueId: input.issueId,
        status: StepRunStatus.failed,
        summary: 'нет репозиториев с включённым bootstrap',
        feedback: 'все репозитории исключены из сборки',
      });
      return;
    }

    const missing = targets.filter(
      (repo) =>
        !existsSync(
          join(hostDir, extractRepoNameFromUrl(repo.repository_url), '.git'),
        ),
    );
    if (missing.length > 0) {
      const names = missing
        .map((repo) => extractRepoNameFromUrl(repo.repository_url))
        .join(', ');
      await finishDevopsSession(deps.db, deps, handle, {
        issueId: input.issueId,
        status: StepRunStatus.failed,
        summary: 'рабочая папка не подготовлена',
        feedback: `клон отсутствует: ${names}`,
      });
      return;
    }

    const context = collectDevOpsContext(deps.db, input.issueId, targets);
    if (devPort === undefined) {
      devPort = await allocateDevPort(input.issueId);
      portAllocatedNow = true;
      deps.db
        .update(issues)
        .set({ dev_server_port: devPort })
        .where(eq(issues.id, input.issueId))
        .run();
    }
    const results: Array<{ repo: string; ok: boolean; error?: string }> = [];

    for (const repo of targets) {
      const repoName = extractRepoNameFromUrl(repo.repository_url);
      const agent = deps.devopsFactory({
        containerName: containerNameFor(input.issueId),
        hostWorkspaceDir: hostDir,
        containerWorkspaceDir: containerDir,
        issueId: input.issueId,
        stepRunId: sessionId,
        registry: deps.control,
        tagInstructions: context.tagInstructions,
        reposNames: context.reposNames,
        reposRequireDevServer: context.reposRequireDevServer,
        reposInstructions: context.reposInstructions,
        model: deps.devopsModel,
        thinkingLevel: deps.devopsThinkingLevel,
        timeoutMs: deps.devopsTimeoutMs,
        onStdout: (chunk) => handle.session.callbacks.onStdout(chunk),
        onStderr: (chunk) => handle.session.callbacks.onStderr(chunk),
        onEvent: (event) => handle.session.callbacks.onEvent(event),
      });

      clearDevOpsArtifacts(hostDir, repoName);

      const result = await agent.runDevOps(
        containerDir,
        repo.repository_url,
        repoName,
        devPort,
      );
      if (result.stats) handle.session.setStats(result.stats);

      if (result.success && result.instructions) {
        runStore.saveGenerated(repo.repository_url, result.instructions);
        results.push({ repo: repoName, ok: true });
      } else {
        runStore.saveFailed(repo.repository_url);
        results.push({
          repo: repoName,
          ok: false,
          error: result.error ?? 'не удалось собрать инструкции',
        });
      }
    }

    const entryRepo = targets[0];
    if (devPort !== undefined && entryRepo && results[0]) {
      const entryName = extractRepoNameFromUrl(entryRepo.repository_url);
      const pid = readDevServerPid(hostDir, entryName);
      const serving = pid !== null && (await devServerResponds(devPort, 5, 600));
      if (serving && pid !== null) {
        deps.db
          .update(issues)
          .set({ dev_server_port: devPort, dev_server_pid: pid })
          .where(eq(issues.id, input.issueId))
          .run();
      } else if (
        results[0].ok &&
        existsSync(join(hostDir, entryName, DEV_SERVER_SCRIPT))
      ) {
        const logTail = readDevServerLogTail(hostDir, entryName);
        results[0].ok = false;
        results[0].error = `dev server не отвечает на :${devPort}${
          logTail ? ` (${logTail})` : ''
        }`;
        clearDevServerPid(hostDir, entryName);
      }
    }

    const failed = results.filter((item) => !item.ok);
    const ok = results.length - failed.length;
    const status: StepRunStatus =
      failed.length === 0 ? StepRunStatus.success : StepRunStatus.failed;
    if (portAllocatedNow && ok === 0) {
      deps.db
        .update(issues)
        .set({ dev_server_port: null })
        .where(eq(issues.id, input.issueId))
        .run();
      releaseIssueDevPorts(input.issueId);
    }
    await finishDevopsSession(deps.db, deps, handle, {
      issueId: input.issueId,
      status,
      summary: `DevOps: ${ok}/${results.length} репозиториев`,
      feedback:
        failed.length > 0
          ? failed.map((item) => `${item.repo}: ${item.error}`).join('; ')
          : null,
    });
    console.log(
      `devops agent finished: issue=${input.issueId} status=${status} durationMs=${Date.now() - startedAt}`,
    );
  } catch (error) {
    const message = messageOf(error);
    await finishDevopsSession(deps.db, deps, handle, {
      issueId: input.issueId,
      status: StepRunStatus.failed,
      summary: `DevOps прерван: ${message}`,
      feedback: message,
    });
    console.error('devops agent failed', {
      issueId: input.issueId,
      durationMs: Date.now() - startedAt,
      error,
    });
  }
}
