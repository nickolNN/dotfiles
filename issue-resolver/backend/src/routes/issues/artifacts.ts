import { basename } from 'node:path';
import type { IssuesContext } from './context';
import { DEFAULT_WORKSPACE_ROOT } from '../../workspace/paths';
import { mimeForFilename, workspaceFilePathFor } from '../../workspace/workspace-files';
import { artifactWarningHeaders, attachmentDisposition } from './download-headers';
import { ROUTE_PATH } from './paths';
import { notFound, sendFileOr404 } from '../params';
import type { FastifyReply } from 'fastify';
import type { ResultArtifactResponse } from '../../issues/types';

interface ArtifactReplyInput {
  issueId: string;
  result: ResultArtifactResponse;
  disposition: 'inline' | 'attachment';
  workspaceRoot?: string;
}

function sendArtifact(reply: FastifyReply, input: ArtifactReplyInput) {
  const { issueId, result, disposition, workspaceRoot } = input;
  return reply
    .type(result.contentType)
    .header(
      'Content-Disposition',
      disposition === 'inline'
        ? 'inline'
        : `attachment; filename="${result.filename}"`,
    )
    .header('x-artifact-source', result.source)
    .header('x-artifact-mtime', result.mtime)
    .headers(artifactWarningHeaders(issueId, workspaceRoot))
    .send(result.body);
}

export function registerIssueArtifacts(ctx: IssuesContext): void {
  const { app, db, deps, service, config } = ctx;

  app.get<{ Params: { id: string } }>(
    `${ROUTE_PATH}/:id/result`,
    async (request, reply) => {
      const { id } = request.params;
      const issue = service.getIssue(db, config, id);
      if (!issue) {
        return notFound(reply, 'issue not found');
      }

      const result = await service.getResultArtifact(db, config, id);
      if (!result) {
        return notFound(reply, 'result not found');
      }
      return sendArtifact(reply, {
        issueId: id,
        result,
        disposition: 'inline',
        workspaceRoot: deps.workspaceRoot,
      });
    },
  );

  app.get<{ Params: { id: string } }>(
    `${ROUTE_PATH}/:id/result/download`,
    async (request, reply) => {
      const { id } = request.params;
      const issue = service.getIssue(db, config, id);
      if (!issue) {
        return notFound(reply, 'issue not found');
      }

      const result = await service.getResultArtifact(db, config, id);
      if (!result) {
        return notFound(reply, 'result not found');
      }
      return sendArtifact(reply, {
        issueId: id,
        result,
        disposition: 'attachment',
        workspaceRoot: deps.workspaceRoot,
      });
    },
  );

  app.get<{ Params: { id: string } }>(
    `${ROUTE_PATH}/:id/result/md`,
    async (request, reply) => {
      const { id } = request.params;
      const issue = service.getIssue(db, config, id);
      if (!issue) {
        return notFound(reply, 'issue not found');
      }

      const result = await service.getMdArtifact(db, config, id);
      if (!result) {
        return notFound(reply, 'result not found');
      }
      return sendArtifact(reply, {
        issueId: id,
        result,
        disposition: 'inline',
        workspaceRoot: deps.workspaceRoot,
      });
    },
  );

  app.get<{ Params: { id: string } }>(
    `${ROUTE_PATH}/:id/result/md/download`,
    async (request, reply) => {
      const { id } = request.params;
      const issue = service.getIssue(db, config, id);
      if (!issue) {
        return notFound(reply, 'issue not found');
      }

      const result = await service.getMdArtifact(db, config, id);
      if (!result) {
        return notFound(reply, 'result not found');
      }
      return sendArtifact(reply, {
        issueId: id,
        result,
        disposition: 'attachment',
        workspaceRoot: deps.workspaceRoot,
      });
    },
  );

  app.get<{ Params: { id: string } }>(
    `${ROUTE_PATH}/:id/result/files`,
    async (request, reply) => {
      const { id } = request.params;
      const issue = service.getIssue(db, config, id);
      if (!issue) {
        return notFound(reply, 'issue not found');
      }

      const files = await service.getResultFiles(db, config, id);
      if (!files) {
        return notFound(reply, 'result not found');
      }
      return files;
    },
  );

  app.get<{ Params: { id: string } }>(
    `${ROUTE_PATH}/:id/result/files/archive`,
    async (request, reply) => {
      const { id } = request.params;
      const issue = service.getIssue(db, config, id);
      if (!issue) {
        return notFound(reply, 'issue not found');
      }

      let buf: Buffer | null;
      try {
        buf = await service.getResultArchive(db, config, id);
      } catch {
        return notFound(reply, 'result not found');
      }
      if (!buf) {
        return notFound(reply, 'result not found');
      }

      return reply
        .type('application/gzip')
        .header(
          'Content-Disposition',
          `attachment; filename="issue-${id}.tar.gz"`,
        )
        .send(buf);
    },
  );

  app.get<{
    Params: { id: string };
    Querystring: { path?: string; inline?: string };
  }>(
    `${ROUTE_PATH}/:id/result/files/content`,
    async (request, reply) => {
      const { id } = request.params;
      const issue = service.getIssue(db, config, id);
      if (!issue) {
        return notFound(reply, 'issue not found');
      }

      const path = workspaceFilePathFor(
        deps.workspaceRoot ?? DEFAULT_WORKSPACE_ROOT,
        id,
        request.query.path ?? '',
      );
      if (!path) {
        return notFound(reply, 'file not found');
      }

      const name = basename(path);
      return sendFileOr404(reply, path, {
        type: mimeForFilename(name) ?? 'application/octet-stream',
        disposition:
          request.query.inline === '1' ? 'inline' : attachmentDisposition(name),
      });
    },
  );
}
