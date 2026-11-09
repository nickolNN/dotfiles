import { eq } from 'drizzle-orm';
import { join } from 'node:path';
import { extractRepoNameFromUrl } from '@issue-resolver/shared';
import type { Db } from '../db/client';
import { issues } from '../db/schema';
import {
  DEFAULT_WORKSPACE_ROOT,
  workspaceHostDirFor,
} from '../workspace/paths';
import { allocateDevPort, releaseIssueDevPorts, reserveDevPort } from '../port-allocator';
import { startRepoDevServer, stopDevServerProcess } from './dev-server';
import type { IterationRunDeps, RunIssueIterationInput } from './service-contracts';

export async function restartDevServerForIteration(
  db: Db,
  deps: IterationRunDeps,
  input: RunIssueIterationInput,
): Promise<void> {
  const issueRow = db
    .select()
    .from(issues)
    .where(eq(issues.id, input.issue.id))
    .get();
  const devRepo = input.repositories.find(
    (repo) => repo.bootstrap_enabled !== false,
  );
  const workspaceDir = workspaceHostDirFor(
    deps.workspaceRoot ?? DEFAULT_WORKSPACE_ROOT,
    input.issue.id,
  );
  const devRepoName = devRepo
    ? extractRepoNameFromUrl(devRepo.repository_url)
    : null;
  if (issueRow?.dev_server_pid) {
    await stopDevServerProcess(
      issueRow.dev_server_pid,
      devRepoName === null ? workspaceDir : join(workspaceDir, devRepoName),
    );
    releaseIssueDevPorts(input.issue.id);
    db.update(issues)
      .set({ dev_server_port: null, dev_server_pid: null })
      .where(eq(issues.id, input.issue.id))
      .run();

    if (devRepo && devRepoName !== null) {
      const preferredPort = issueRow.dev_server_port ?? undefined;
      const port =
        preferredPort !== undefined &&
        (await reserveDevPort(input.issue.id, preferredPort))
          ? preferredPort
          : await allocateDevPort(input.issue.id);
      const pid = startRepoDevServer(
        workspaceDir,
        devRepoName,
        port,
        input.issue.id,
      );
      if (pid !== null) {
        db.update(issues)
          .set({ dev_server_port: port, dev_server_pid: pid })
          .where(eq(issues.id, input.issue.id))
          .run();
      } else {
        releaseIssueDevPorts(input.issue.id);
      }
    }
  }
}
