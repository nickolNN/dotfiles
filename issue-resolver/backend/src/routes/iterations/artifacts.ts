import type { FastifyInstance, FastifyReply } from 'fastify';
import type { ResultArtifact } from '../../workspace/paths';
import {
  DEFAULT_WORKSPACE_ROOT,
  HTML_ARTIFACT,
  MD_ARTIFACT,
  iterationResultDirFor,
} from '../../workspace/paths';
import type { Db } from '../../db/client';
import { readArtifactFrom } from '../../issues/artifacts';
import type { IterationRunDeps } from '../../workflow/run-iteration.service';
import { getIssueRow } from '../../issues/queries';
import { getIterationRow, notFound } from '../params';

const ROUTE_PATH = '/issue-resolver/api/v1/iterations';

type Artifact = Awaited<ReturnType<typeof readArtifactFrom>>;

async function readFirst(
  dir: string,
  artifacts: readonly ResultArtifact[],
): Promise<Artifact> {
  for (const artifact of artifacts) {
    const found = await readArtifactFrom(dir, artifact);
    if (found) return found;
  }
  return null;
}

function sendArtifact(
  reply: FastifyReply,
  artifact: NonNullable<Artifact>,
  disposition: 'inline' | 'attachment',
) {
  return reply
    .type(artifact.contentType)
    .header(
      'Content-Disposition',
      disposition === 'inline'
        ? 'inline'
        : `attachment; filename="${artifact.filename}"`,
    )
    .send(artifact.body);
}

export async function iterationArtifactRoutes(
  app: FastifyInstance,
  db: Db,
  deps: IterationRunDeps,
): Promise<void> {
  app.get<{ Params: { id: string } }>(
    `${ROUTE_PATH}/:id/result`,
    async (request, reply) => {
      const loaded = await loadArtifact(db, deps, request.params.id, [
        HTML_ARTIFACT,
        MD_ARTIFACT,
      ]);
      if (!loaded.ok) return notFound(reply, loaded.error);
      return sendArtifact(reply, loaded.artifact, 'inline');
    },
  );

  app.get<{ Params: { id: string } }>(
    `${ROUTE_PATH}/:id/result/download`,
    async (request, reply) => {
      const loaded = await loadArtifact(db, deps, request.params.id, [
        HTML_ARTIFACT,
        MD_ARTIFACT,
      ]);
      if (!loaded.ok) return notFound(reply, loaded.error);
      return sendArtifact(reply, loaded.artifact, 'attachment');
    },
  );

  app.get<{ Params: { id: string } }>(
    `${ROUTE_PATH}/:id/result/md`,
    async (request, reply) => {
      const loaded = await loadArtifact(db, deps, request.params.id, [MD_ARTIFACT]);
      if (!loaded.ok) return notFound(reply, loaded.error);
      return sendArtifact(reply, loaded.artifact, 'inline');
    },
  );

  app.get<{ Params: { id: string } }>(
    `${ROUTE_PATH}/:id/result/md/download`,
    async (request, reply) => {
      const loaded = await loadArtifact(db, deps, request.params.id, [MD_ARTIFACT]);
      if (!loaded.ok) return notFound(reply, loaded.error);
      return sendArtifact(reply, loaded.artifact, 'attachment');
    },
  );
}

type LoadedArtifact =
  | { ok: true; artifact: NonNullable<Artifact> }
  | { ok: false; error: string };

async function loadArtifact(
  db: Db,
  deps: IterationRunDeps,
  id: string,
  artifacts: readonly ResultArtifact[],
): Promise<LoadedArtifact> {
  const iteration = getIterationRow(db, id);
  if (!iteration) return { ok: false, error: 'iteration not found' };
  const issue = getIssueRow(db, iteration.issue_id);
  if (!issue) return { ok: false, error: 'issue not found' };
  const dir = iterationResultDirFor(
    deps.workspaceRoot ?? DEFAULT_WORKSPACE_ROOT,
    iteration.issue_id,
    iteration.id,
  );
  const artifact = await readFirst(dir, artifacts);
  return artifact
    ? { ok: true, artifact }
    : { ok: false, error: 'result not found' };
}