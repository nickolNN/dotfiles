import { copyFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { and, desc, eq } from 'drizzle-orm';
import {
  ALL_RESULT_ARTIFACTS,
  DEFAULT_WORKSPACE_ROOT,
  iterationResultDirFor,
  workspaceHostDirFor,
} from '../workspace/paths';
import { iterations } from '../db/schema';
import type { Db } from '../db/client';
import { TaskStatus } from '@issue-resolver/shared';
import { messageOf } from '../util/errors';

export async function snapshotIterationResult(
  workspaceRoot: string,
  issueId: string,
  iterationId: string,
): Promise<void> {
  const targetDir = iterationResultDirFor(workspaceRoot, issueId, iterationId);
  for (const artifact of ALL_RESULT_ARTIFACTS) {
    const source = join(
      workspaceHostDirFor(workspaceRoot, issueId),
      artifact.filename,
    );
    try {
      await mkdir(targetDir, { recursive: true });
      await copyFile(source, join(targetDir, artifact.filename));
    } catch (error) {
      console.warn('attachment copy failed', {
        file: artifact.filename,
        error: messageOf(error),
      });
    }
  }
}

export async function refreshLatestResultSnapshot(
  db: Db,
  workspaceRoot: string | undefined,
  issueId: string,
): Promise<void> {
  const latest = db
    .select({ id: iterations.id })
    .from(iterations)
    .where(
      and(
        eq(iterations.issue_id, issueId),
        eq(iterations.status, TaskStatus.completed),
      ),
    )
    .orderBy(desc(iterations.number))
    .get();
  if (!latest) return;
  await snapshotIterationResult(
    workspaceRoot ?? DEFAULT_WORKSPACE_ROOT,
    issueId,
    latest.id,
  );
}
