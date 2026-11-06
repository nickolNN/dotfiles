import { rm } from 'node:fs/promises';
import type { Db } from '../../db/client';
import {
  deleteById,
  getById,
  insertMany,
  listByIssue,
  type NewIssueFile,
} from '../../db/issue-files.repo';
import type { IterationRunDeps } from '../../workflow/run-iteration.service';
import {
  attachmentsFilePathFor,
  saveUpload,
  type UploadInput,
} from '../../workspace/attachments';
import { DEFAULT_WORKSPACE_ROOT } from '../../workspace/paths';
import type { IssuesContext } from './context';
import { attachmentDisposition } from './download-headers';
import { API_PATH, ROUTE_PATH } from './paths';
import { notFound, sendFileOr404 } from '../params';

export async function saveAttachments(
  db: Db,
  deps: IterationRunDeps,
  issueId: string,
  iterationId: string | null,
  iterationNumber: number,
  files: UploadInput[],
): Promise<void> {
  if (files.length === 0) {
    return;
  }
  const root = deps.workspaceRoot ?? DEFAULT_WORKSPACE_ROOT;
  const saved: NewIssueFile[] = [];
  for (const file of files) {
    const upload = await saveUpload(root, issueId, iterationNumber, file);
    saved.push({
      issueId,
      iterationId,
      name: upload.name,
      relPath: upload.relPath,
      size: upload.size,
      mimeType: upload.mimeType,
    });
  }
  await insertMany(db, saved);
}

export function registerIssueAttachments(ctx: IssuesContext): void {
  const { app, db, deps, service, config } = ctx;
  app.get<{ Params: { id: string } }>(
    `${ROUTE_PATH}/:id/files`,
    async (request, reply) => {
      const { id } = request.params;
      if (!service.getIssue(db, config, id)) {
        return notFound(reply, 'issue not found');
      }

      return listByIssue(db, id);
    },
  );

  app.delete<{ Params: { fileId: string } }>(
    `${API_PATH}/files/:fileId`,
    async (request, reply) => {
      const row = await deleteById(db, request.params.fileId);
      if (!row) {
        return notFound(reply, 'file not found');
      }

      const path = attachmentsFilePathFor(
        deps.workspaceRoot ?? DEFAULT_WORKSPACE_ROOT,
        row.issue_id,
        row.rel_path,
      );
      if (path) {
        try {
          await rm(path, { force: true });
        } catch (error) {
          console.error('remove attachment failed', error);
        }
      }

      return reply.code(204).send();
    },
  );

  app.get<{ Params: { fileId: string } }>(
    `${API_PATH}/files/:fileId/content`,
    async (request, reply) => {
      const row = await getById(db, request.params.fileId);
      if (!row) {
        return notFound(reply, 'file not found');
      }

      const path = attachmentsFilePathFor(
        deps.workspaceRoot ?? DEFAULT_WORKSPACE_ROOT,
        row.issue_id,
        row.rel_path,
      );
      if (!path) {
        return notFound(reply, 'file not found');
      }

      return sendFileOr404(reply, path, {
        type: row.mime_type || 'application/octet-stream',
        disposition: attachmentDisposition(row.name),
      });
    },
  );
}
