import { join } from 'node:path';
import { TaskStatus, isIterationActive } from '@issue-resolver/shared';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { Db } from '../db/client';
import { listAnsweredQuestionIds } from '../db/question-answers.repo';
import { iterations } from '../db/schema';
import { listStepRunsWithLog } from '../db/step-runs.repo';
import { getIssueRow } from '../issues/queries';
import { readTextFileOrNullAsync } from '../util/files';
import { JSON_PARSE_FAILED, tryParseJson } from '../util/json-file';
import type { IterationRunDeps } from '../workflow/run-iteration.service';
import { DEFAULT_WORKSPACE_ROOT, workspaceHostDirFor } from '../workspace/paths';
import { messageOf } from '../util/errors';
import { asRecord } from '../util/records';
import { iterationArtifactRoutes } from './iterations/artifacts';
import { iterationRepeatRoutes } from './iterations/repeat';
import { conflict, getIterationRow, notFound } from './params';
import { nowIso } from '../db/rows';

const ROUTE_PATH = '/issue-resolver/api/v1/iterations';

export async function iterationsRoutes(
  app: FastifyInstance,
  db: Db,
  deps: IterationRunDeps,
): Promise<void> {
  app.get<{ Params: { id: string } }>(
    `${ROUTE_PATH}/:id/step-runs`,
    async (request, reply) => {
      if (!getIterationRow(db, request.params.id)) {
        return notFound(reply, 'iteration not found');
      }
      return await listStepRunsWithLog(db, request.params.id);
    },
  );

  app.get<{ Params: { id: string } }>(
    `${ROUTE_PATH}/:id/question-answers`,
    async (request, reply) => {
      if (!getIterationRow(db, request.params.id)) {
        return notFound(reply, 'iteration not found');
      }
      const answered_ids = await listAnsweredQuestionIds(db, request.params.id);
      return { answered_ids };
    },
  );

  app.put<{ Params: { id: string }; Body: { context: string } }>(
    `${ROUTE_PATH}/:id`,
    async (request, reply) => {
      const it = getIterationRow(db, request.params.id);
      if (!it) return notFound(reply, 'iteration not found');
      if (it.status !== TaskStatus.draft) {
        return conflict(reply, 'only draft iterations can be updated');
      }
      const now = nowIso();
      db.update(iterations)
        .set({ context: request.body.context, updated_at: now })
        .where(eq(iterations.id, it.id))
        .run();
      return reply
        .status(200)
        .send({ ...it, context: request.body.context, updated_at: now });
    },
  );

  app.post<{ Params: { id: string } }>(
    `${ROUTE_PATH}/:id/fetch-review-comments`,
    async (request, reply) => {
      const source = getIterationRow(db, request.params.id);
      if (!source) return notFound(reply, 'iteration not found');
      if (isIterationActive(source.status)) {
        return conflict(reply, 'cannot fetch review for an active iteration');
      }
      const issue = getIssueRow(db, source.issue_id);
      if (!issue) return notFound(reply, 'issue not found');

      const mrEntries = await readMergeRequests(deps, issue.id);
      if (mrEntries.length === 0) {
        return notFound(reply, 'no MR/PR found for this iteration');
      }

      const comments = await fetchComments(deps, mrEntries);
      if (comments.entries.length === 0 && comments.errors.length > 0) {
        return reply.status(502).send({
          error: 'failed to fetch review comments',
          details: comments.errors,
        });
      }
      return reply.status(200).send({
        comments: comments.entries,
        errors: comments.errors.length > 0 ? comments.errors : undefined,
      });
    },
  );

  await iterationArtifactRoutes(app, db, deps);
  await iterationRepeatRoutes(app, db, deps);
}

interface MergeRequestEntry {
  repository_url: string;
  url: string;
  title: string;
}

async function readMergeRequests(
  deps: IterationRunDeps,
  issueId: string,
): Promise<MergeRequestEntry[]> {
  const dir = workspaceHostDirFor(
    deps.workspaceRoot ?? DEFAULT_WORKSPACE_ROOT,
    issueId,
  );
  const data = tryParseJson(
    await readTextFileOrNullAsync(join(dir, 'result.json')),
  );
  if (data === JSON_PARSE_FAILED) return [];
  const list = asRecord(data)?.merge_requests;
  if (!Array.isArray(list)) return [];
  return list.flatMap((item): MergeRequestEntry[] => {
    const record = asRecord(item);
    if (
      !record ||
      typeof record.repository_url !== 'string' ||
      typeof record.url !== 'string'
    ) {
      return [];
    }
    return [
      {
        repository_url: record.repository_url,
        url: record.url,
        title: typeof record.title === 'string' ? record.title : '',
      },
    ];
  });
}

interface ReviewComment {
  repo: string;
  file: string | null;
  line: number | null;
  body: string;
  author: string;
}

async function fetchComments(
  deps: IterationRunDeps,
  mergeRequests: MergeRequestEntry[],
): Promise<{ entries: ReviewComment[]; errors: string[] }> {
  const entries: ReviewComment[] = [];
  const errors: string[] = [];
  for (const mr of mergeRequests) {
    try {
      const comments = await deps.mr.fetchComments({
        mrUrl: mr.url,
        token: deps.mrToken ?? '',
        repositoryUrl: mr.repository_url,
      });
      for (const comment of comments) {
        entries.push({
          repo: mr.repository_url,
          file: comment.file,
          line: comment.line,
          body: comment.body,
          author: comment.author,
        });
      }
    } catch (error) {
      errors.push(`${mr.repository_url}: ${messageOf(error)}`);
    }
  }
  return { entries, errors };
}