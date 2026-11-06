import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import type { SessionEvent, WorkspaceProgress } from '@issue-resolver/shared';
import {
  IssueRunKind,
  RunInstructionsStatus,
  SessionAddress,
  StepRunStatus,
  TaskStatus,
  extractRepoNameFromUrl,
} from '@issue-resolver/shared';
import type { ContainerController } from '../docker/controller';
import type { GitPrepareResult, GitService } from '../git/service';
import type { StepSessionRegistry } from '../pi/session-registry';
import type { SseHub } from '../sse/hub';
import { issues, iterations } from '../db/schema';
import type { Db } from '../db/client';
import { allocateDevPort, releaseIssueDevPorts } from '../port-allocator';
import { updateTagRunInstructions } from '../db/tags.repo';
import {
  DEFAULT_WORKSPACE_ROOT,
  workspaceContainerDirFor,
  workspaceHostDirFor,
} from '../workspace/paths';
import { dbRunInstructionsStore } from './db-adapters';
import { prepareWorkspace } from './prepare-workspace';
import type { DevopsSettings } from './run-deps';
import {
  collectDevOpsContext,
  finishDevopsSession,
  startDevopsSession,
} from './devops-session';
import {
  devServerResponds,
  excludeInfraFiles,
  isProcessAlive,
  readDevServerPid,
  startRepoDevServer,
} from './dev-server';
import { installWorkspaceHelpers } from './workspace-helpers';
import { messageOf } from '../util/errors';
import { nowIso } from '../db/rows';

export interface PrepareIssueWorkspaceDeps extends DevopsSettings {
  container: ContainerController;
  git: GitService;
  sse: SseHub;
  local?: boolean;
  workspaceRoot?: string;
  control?: StepSessionRegistry;
}

export async function prepareIssueWorkspace(
  db: Db,
  deps: PrepareIssueWorkspaceDeps,
  input: {
    issueId: string;
    iterationId: string;
    repositories: Array<{
      repository_url: string;
      base_branch: string;
      bootstrap_enabled?: boolean;
    }>;
  },
): Promise<GitPrepareResult['repoWorkspaces']> {
  const repos = input.repositories;
  const workspaceDir = workspaceHostDirFor(
    deps.workspaceRoot ?? DEFAULT_WORKSPACE_ROOT,
    input.issueId,
  );
  const clonesReady =
    repos.length > 0 &&
    repos.every((repo) =>
      existsSync(
        join(workspaceDir, extractRepoNameFromUrl(repo.repository_url), '.git'),
      ),
    );
  const needPrepare = repos.length > 0 && !clonesReady;

  if (!needPrepare) {
    const dir = deps.local
      ? workspaceHostDirFor(
          deps.workspaceRoot ?? DEFAULT_WORKSPACE_ROOT,
          input.issueId,
        )
      : workspaceContainerDirFor(input.issueId);
    repos.forEach((repo) =>
      excludeInfraFiles(workspaceDir, extractRepoNameFromUrl(repo.repository_url)),
    );
    installWorkspaceHelpers(workspaceDir);
    return repos.map((repo) => ({
      repoUrl: repo.repository_url,
      path: join(dir, extractRepoNameFromUrl(repo.repository_url)),
      branch: repo.base_branch,
    }));
  }

  const devRepo = deps.devopsFactory
    ? repos.find((repo) => repo.bootstrap_enabled !== false)
    : undefined;
  const devServerPort = devRepo
    ? await allocateDevPort(input.issueId)
    : undefined;

  const {
    tagInstructions,
    reposNames,
    reposRequireDevServer,
    reposInstructions,
  } = collectDevOpsContext(db, input.issueId, input.repositories);

  const devopsRunId = SessionAddress.forIssueRun(
    input.issueId,
    IssueRunKind.devops,
  ).toString();
  const devopsSession = await startDevopsSession(db, deps, {
    issueId: input.issueId,
    iterationId: input.iterationId,
    sessionId: devopsRunId,
    context: 'post-prepare',
    enabled: Boolean(deps.devopsFactory),
  });

  const prepareDeps = {
    container: deps.container,
    git: deps.git,
    workspaceRoot: deps.workspaceRoot,
    local: deps.local,
    devopsModel: deps.devopsModel,
    devopsThinkingLevel: deps.devopsThinkingLevel,
    devopsTimeoutMs: deps.devopsTimeoutMs,
    devServerPort,
    issueId: input.issueId,
    iterationId: input.iterationId,
    control: deps.control,
    tagInstructions,
    reposNames: reposNames || null,
    reposRequireDevServer: reposRequireDevServer || null,
    reposInstructions,
    ...(deps.devopsFactory
      ? { devops: deps.devopsFactory }
      : {}),
    runInstructions: dbRunInstructionsStore(db),
    onDevOpsStdout: (_repo: string, chunk: string): void =>
      devopsSession?.session.callbacks.onStdout(chunk),
    onDevOpsStderr: (_repo: string, chunk: string): void =>
      devopsSession?.session.callbacks.onStderr(chunk),
    onDevOpsEvent: (_repo: string, event: SessionEvent): void =>
      devopsSession?.session.callbacks.onEvent(event),
  };

  const publishWorkspaceProgress = (progress: WorkspaceProgress): void => {
    deps.sse.publish({
      type: 'workspace_progress',
      issueId: input.issueId,
      data: JSON.stringify(progress),
      ts: nowIso(),
    });
  };

  const prepStart = nowIso();
  db.update(issues)
    .set({ status: TaskStatus.preparing, updated_at: prepStart })
    .where(eq(issues.id, input.issueId))
    .run();

  try {
    const prepared = await prepareWorkspace(
      prepareDeps,
      { id: input.issueId },
      repos,
      publishWorkspaceProgress,
    );

    repos.forEach((repo) =>
      excludeInfraFiles(workspaceDir, extractRepoNameFromUrl(repo.repository_url)),
    );
    installWorkspaceHelpers(workspaceDir);

    if (devServerPort !== undefined && devRepo) {
      const repoName = extractRepoNameFromUrl(devRepo.repository_url);
      const adopted = readDevServerPid(workspaceDir, repoName);
      const pid =
        adopted !== null &&
        isProcessAlive(adopted) &&
        (await devServerResponds(devServerPort, 2, 250))
          ? adopted
          : startRepoDevServer(workspaceDir, repoName, devServerPort);
      if (pid !== null) {
        db.update(issues)
          .set({ dev_server_port: devServerPort, dev_server_pid: pid })
          .where(eq(issues.id, input.issueId))
          .run();
      } else {
        releaseIssueDevPorts(input.issueId);
      }
    }

    const tagId = db
      .select({ tag_id: issues.tag_id })
      .from(issues)
      .where(eq(issues.id, input.issueId))
      .get()?.tag_id;

    if (tagId) {
      const workspaceInstructionsPath = join(workspaceDir, 'WORKSPACE_INSTRUCTIONS.md');
      if (existsSync(workspaceInstructionsPath)) {
        const wsInstructions = readFileSync(workspaceInstructionsPath, 'utf-8');
        if (wsInstructions.trim()) {
          updateTagRunInstructions(db, tagId, {
            instructions: wsInstructions,
            status: RunInstructionsStatus.generated,
          });
        }
      }
    }

    await finishDevopsSession(db, deps, devopsSession, {
      issueId: input.issueId,
      status: StepRunStatus.success,
      summary: 'DevOps completed during workspace preparation',
    });

    return prepared;
  } catch (error) {
    releaseIssueDevPorts(input.issueId);
    console.error('workspace preparation failed', error);
    const failedAt = nowIso();
    const message = messageOf(error);
    db.update(iterations)
      .set({ status: TaskStatus.failed, updated_at: failedAt })
      .where(eq(iterations.id, input.iterationId))
      .run();
    db.update(issues)
      .set({ status: TaskStatus.failed, updated_at: failedAt })
      .where(eq(issues.id, input.issueId))
      .run();

    await finishDevopsSession(db, deps, devopsSession, {
      issueId: input.issueId,
      status: StepRunStatus.failed,
      summary: `Workspace preparation failed: ${message}`,
      feedback: message,
    });

    deps.sse.publish({
      type: 'iteration_status',
      issueId: input.issueId,
      iterationId: input.iterationId,
      data: JSON.stringify({
        iterationId: input.iterationId,
        status: TaskStatus.failed,
        needsInput: false,
        error: message,
      }),
      ts: failedAt,
    });
    throw error;
  }
}
