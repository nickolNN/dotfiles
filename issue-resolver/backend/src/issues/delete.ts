import { IssueDeletingPhase } from '@issue-resolver/shared';
import { eq } from 'drizzle-orm';
import type { Db } from '../db/client';
import { issues } from '../db/schema';
import { releaseIssueDevPorts } from '../port-allocator';
import {
  killWorkspaceProcesses,
  removeWorkspaceDir,
} from '../processes/workspace-processes';
import type { SseHub } from '../sse/hub';
import { containerNameFor, workspaceHostDirFor } from '../workspace/paths';
import type { IssueServiceConfig } from './types';
import { messageOf } from '../util/errors';
import { nowIso } from '../db/rows';

function publishDeleting(
  sse: SseHub,
  id: string,
  phase: IssueDeletingPhase,
  message?: string,
): void {
  sse.publish({
    type: 'issue_deleting',
    issueId: id,
    data: JSON.stringify(message ? { phase, message } : { phase }),
    ts: nowIso(),
  });
}

export async function deleteIssueInBackground(
  db: Db,
  config: IssueServiceConfig,
  id: string,
): Promise<void> {
  const { workspaceRoot, container, sse } = config;

  try {
    const wsPath = workspaceHostDirFor(workspaceRoot, id);
    publishDeleting(sse, id, IssueDeletingPhase.stopping_processes);
    try {
      const { killed, remaining } = await killWorkspaceProcesses(wsPath);
      if (killed.length > 0 || remaining.length > 0) {
        console.error('issue delete: workspace processes', {
          issueId: id,
          killed: killed.length,
          remaining,
        });
      }
    } catch (error) {
      console.error('issue delete: stopping processes failed', error);
    }

    releaseIssueDevPorts(id);

    publishDeleting(sse, id, IssueDeletingPhase.removing_db_record);
    db.delete(issues).where(eq(issues.id, id)).run();

    publishDeleting(sse, id, IssueDeletingPhase.removing_container);
    try {
      await container.remove(containerNameFor(id));
    } catch (error) {
      console.error('remove container failed', error);
    }
    publishDeleting(sse, id, IssueDeletingPhase.removing_workspace);
    try {
      const { removed, remaining } = await removeWorkspaceDir(wsPath);
      if (!removed) {
        console.error('remove workspace failed', { issueId: id, remaining });
      }
    } catch (error) {
      console.error('remove workspace failed', error);
    }

    sse.publish({
      type: 'issue_deleted',
      issueId: id,
      data: JSON.stringify({ issueId: id }),
      ts: nowIso(),
    });
  } catch (error) {
    const message = messageOf(error);
    console.error('delete issue failed', error);
    publishDeleting(sse, id, IssueDeletingPhase.error, message);
  }
}