import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Iteration } from '@issue-resolver/shared';
import { isIterationActive } from '@issue-resolver/shared';
import { and, eq, max } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { Db } from '../db/client';
import { insertMany, listByIteration } from '../db/issue-files.repo';
import { listAnsweredQuestionIds } from '../db/question-answers.repo';
import { issueRepositories, issues, iterations } from '../db/schema';
import { listStepRunsWithLog } from '../db/step-runs.repo';
import {
  prepareIssueWorkspace,
  runIssueIteration,
  type IterationRunDeps,
} from '../workflow/run-iteration.service';
import {
  ALL_RESULT_ARTIFACTS,
  DEFAULT_WORKSPACE_ROOT,
  HTML_ARTIFACT,
  iterationResultDirFor,
  MD_ARTIFACT,
  workspaceHostDirFor,
} from '../workspace/paths';

const ROUTE_PATH = '/issue-resolver/api/v1/iterations';

export async function iterationsRoutes(
  app: FastifyInstance,
  db: Db,
  deps: IterationRunDeps,
): Promise<void> {
  app.get<{ Params: { id: string } }>(
    `${ROUTE_PATH}/:id/step-runs`,
    async (request, reply) => {
      const { id } = request.params;
      const iteration = db.select().from(iterations).where(eq(iterations.id, id)).get();
      if (!iteration) return reply.status(404).send({ error: 'iteration not found' });
      const runs = await listStepRunsWithLog(db, id);
      return runs;
    },
  );

  app.get<{ Params: { id: string } }>(
    `${ROUTE_PATH}/:id/question-answers`,
    async (request, reply) => {
      const { id } = request.params;
      const iteration = db.select().from(iterations).where(eq(iterations.id, id)).get();
      if (!iteration) return reply.status(404).send({ error: 'iteration not found' });
      const answered_ids = await listAnsweredQuestionIds(db, id);
      return { answered_ids };
    },
  );

  app.get<{ Params: { id: string } }>(
    `${ROUTE_PATH}/:id/result`,
    async (request, reply) => {
      const { id } = request.params;
      const iteration = db.select().from(iterations).where(eq(iterations.id, id)).get();
      if (!iteration) return reply.status(404).send({ error: 'iteration not found' });
      const issue = db.select().from(issues).where(eq(issues.id, iteration.issue_id)).get();
      if (!issue) return reply.status(404).send({ error: 'issue not found' });
      const dir = iterationResultDirFor(deps.workspaceRoot ?? DEFAULT_WORKSPACE_ROOT, iteration.issue_id, iteration.id);

      let result: { body: string; contentType: string; filename: string } | null = null;
      for (const artifact of [HTML_ARTIFACT, MD_ARTIFACT]) {
        try {
          const body = await readFile(join(dir, artifact.filename), 'utf8');
          result = { ...artifact, body };
          break;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
      }
      if (!result) return reply.status(404).send({ error: 'result not found' });
      return reply.type(result.contentType).header('Content-Disposition', 'inline').send(result.body);
    },
  );

  app.get<{ Params: { id: string } }>(
    `${ROUTE_PATH}/:id/result/download`,
    async (request, reply) => {
      const { id } = request.params;
      const iteration = db.select().from(iterations).where(eq(iterations.id, id)).get();
      if (!iteration) return reply.status(404).send({ error: 'iteration not found' });
      const issue = db.select().from(issues).where(eq(issues.id, iteration.issue_id)).get();
      if (!issue) return reply.status(404).send({ error: 'issue not found' });
      const dir = iterationResultDirFor(deps.workspaceRoot ?? DEFAULT_WORKSPACE_ROOT, iteration.issue_id, iteration.id);

      let result: { body: string; contentType: string; filename: string } | null = null;
      for (const artifact of [HTML_ARTIFACT, MD_ARTIFACT]) {
        try {
          const body = await readFile(join(dir, artifact.filename), 'utf8');
          result = { ...artifact, body };
          break;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
      }
      if (!result) return reply.status(404).send({ error: 'result not found' });
      return reply.type(result.contentType).header('Content-Disposition', `attachment; filename="${result.filename}"`).send(result.body);
    },
  );

  app.get<{ Params: { id: string } }>(
    `${ROUTE_PATH}/:id/result/md`,
    async (request, reply) => {
      const { id } = request.params;
      const iteration = db.select().from(iterations).where(eq(iterations.id, id)).get();
      if (!iteration) return reply.status(404).send({ error: 'iteration not found' });
      const issue = db.select().from(issues).where(eq(issues.id, iteration.issue_id)).get();
      if (!issue) return reply.status(404).send({ error: 'issue not found' });
      const dir = iterationResultDirFor(deps.workspaceRoot ?? DEFAULT_WORKSPACE_ROOT, iteration.issue_id, iteration.id);
      let body: string;
      try {
        body = await readFile(join(dir, MD_ARTIFACT.filename), 'utf8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return reply.status(404).send({ error: 'result not found' });
        throw error;
      }
      return reply.type(MD_ARTIFACT.contentType).header('Content-Disposition', 'inline').send(body);
    },
  );

  app.get<{ Params: { id: string } }>(
    `${ROUTE_PATH}/:id/result/md/download`,
    async (request, reply) => {
      const { id } = request.params;
      const iteration = db.select().from(iterations).where(eq(iterations.id, id)).get();
      if (!iteration) return reply.status(404).send({ error: 'iteration not found' });
      const issue = db.select().from(issues).where(eq(issues.id, iteration.issue_id)).get();
      if (!issue) return reply.status(404).send({ error: 'issue not found' });
      const dir = iterationResultDirFor(deps.workspaceRoot ?? DEFAULT_WORKSPACE_ROOT, iteration.issue_id, iteration.id);
      let body: string;
      try {
        body = await readFile(join(dir, MD_ARTIFACT.filename), 'utf8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return reply.status(404).send({ error: 'result not found' });
        throw error;
      }
      return reply.type(MD_ARTIFACT.contentType).header('Content-Disposition', `attachment; filename="${MD_ARTIFACT.filename}"`).send(body);
    },
  );

  app.put<{ Params: { id: string }; Body: { context: string } }>(
    `${ROUTE_PATH}/:id`,
    async (request, reply) => {
      const { id } = request.params;
      const it = db.select().from(iterations).where(eq(iterations.id, id)).get();
      if (!it) return reply.status(404).send({ error: 'iteration not found' });
      if (it.status !== 'draft') return reply.status(409).send({ error: 'only draft iterations can be updated' });
      const now = new Date().toISOString();
      db.update(iterations)
        .set({ context: request.body.context, updated_at: now })
        .where(eq(iterations.id, id))
        .run();
      return reply.status(200).send({ ...it, context: request.body.context, updated_at: now });
    },
  );

  app.post<{ Params: { id: string } }>(
    `${ROUTE_PATH}/:id/repeat`,
    async (request, reply) => {
      const { id } = request.params;
      const source = db.select().from(iterations).where(eq(iterations.id, id)).get();
      if (!source) return reply.status(404).send({ error: 'iteration not found' });
      if (isIterationActive(source.status)) {
        return reply.status(409).send({ error: 'cannot repeat an active iteration' });
      }
      const issue = db.select().from(issues).where(eq(issues.id, source.issue_id)).get();
      if (!issue) return reply.status(404).send({ error: 'issue not found' });
      const repositories = db.select().from(issueRepositories).where(eq(issueRepositories.issue_id, issue.id)).all().map((r) => ({
        repository_url: r.repository_url,
        base_branch: r.branch_name,
        create_mr: !!r.create_mr,
        bootstrap_enabled: r.bootstrap_enabled ?? true,
      }));
      const lastNumber = db.select({ value: max(iterations.number) }).from(iterations).where(eq(iterations.issue_id, issue.id)).get()?.value ?? 0;
      const now = new Date().toISOString();
      const iterationId = randomUUID();
      const iteration: Iteration = {
        id: iterationId, issue_id: issue.id, number: lastNumber + 1,
        context: source.context, review_context: source.review_context ?? '',
        is_review_need: !!source.is_review_need, steps: source.steps,
        model: source.model ?? null, step_models: source.step_models ?? undefined,
        thinking_level: source.thinking_level ?? null,
        step_thinking_levels: source.step_thinking_levels ?? undefined,
        worker_count: source.worker_count ?? undefined,
        status: 'pending', created_at: now, updated_at: now,
      };

      const hasRunning = db.select({ id: iterations.id }).from(iterations).where(
        and(eq(iterations.issue_id, issue.id), eq(iterations.status, 'running')),
      ).get();

      const hasPlanned = db.select({ id: iterations.id }).from(iterations).where(
        and(eq(iterations.issue_id, issue.id), eq(iterations.status, 'pending')),
      ).get();
      if (hasPlanned) return reply.status(409).send({ error: 'A pending iteration already exists — wait for it to start' });
      const hasDraft = db.select({ id: iterations.id }).from(iterations).where(
        and(eq(iterations.issue_id, issue.id), eq(iterations.status, 'draft')),
      ).get();
      if (hasDraft) return reply.status(409).send({ error: 'A draft iteration already exists — edit or delete it first' });

      if (hasRunning) {
        db.insert(iterations).values({ ...iteration, status: 'draft' }).run();
        const srcFiles = await listByIteration(db, id);
        await insertMany(db, srcFiles.map((f) => ({ issueId: issue.id, iterationId, name: f.name, relPath: f.rel_path, size: f.size, mimeType: f.mime_type })));
        return reply.status(201).send({ ...iteration, status: 'draft' });
      }

      db.insert(iterations).values(iteration).run();
      const srcFiles = await listByIteration(db, id);
      await insertMany(db, srcFiles.map((f) => ({ issueId: issue.id, iterationId, name: f.name, relPath: f.rel_path, size: f.size, mimeType: f.mime_type })));

      const prepareDeps = {
        container: deps.container, git: deps.git, sse: deps.sse, local: deps.local,
        ...(deps.devopsFactory ? { devopsFactory: deps.devopsFactory } : {}),
        devopsModel: issue.devops_model ?? undefined,
        devopsThinkingLevel: issue.devops_thinking_level ?? undefined,
        devopsTimeoutMs: deps.devopsTimeoutMs, workspaceRoot: deps.workspaceRoot,
      };

      void (async () => {
        try {
          const ws = await prepareIssueWorkspace(db, prepareDeps, { issueId: issue.id, iterationId, repositories });
          void runIssueIteration(db, deps, {
            issue: { id: issue.id, title: issue.title, pipelineSteps: issue.pipeline_steps, description: issue.description ?? '', desiredResult: issue.desired_result ?? 'md', jiraIssueUrl: issue.jira_issue_url },
            iteration: { id: iterationId, issueId: issue.id, number: iteration.number, context: iteration.context, steps: iteration.steps, reviewContext: iteration.review_context, isReviewNeed: iteration.is_review_need, worker_count: iteration.worker_count ?? undefined },
            repositories, repoWorkspaces: ws, model: iteration.model ?? undefined, step_models: iteration.step_models, thinking_level: iteration.thinking_level ?? undefined, step_thinking_levels: iteration.step_thinking_levels,
          }).catch((e) => console.error('run failed', e));
        } catch (e) { console.error('prep failed', e); }
      })();

      return reply.status(201).send(iteration);
    },
  );

  app.post<{ Params: { id: string } }>(
    `${ROUTE_PATH}/:id/queue`,
    async (request, reply) => {
      const { id } = request.params;
      const it = db.select().from(iterations).where(eq(iterations.id, id)).get();
      if (!it) return reply.status(404).send({ error: 'iteration not found' });
      if (it.status !== 'draft') return reply.status(409).send({ error: 'only draft iterations can be queued' });
      const hasPending = db.select({ id: iterations.id }).from(iterations).where(and(eq(iterations.issue_id, it.issue_id), eq(iterations.status, 'pending'))).get();
      if (hasPending) return reply.status(409).send({ error: 'A pending iteration already exists' });
      const now = new Date().toISOString();
      db.update(iterations).set({ status: 'pending', updated_at: now }).where(eq(iterations.id, id)).run();

      const issue = db.select({ status: issues.status }).from(issues).where(eq(issues.id, it.issue_id)).get();
      if (issue && (issue.status === 'completed' || issue.status === 'failed')) {
        db.update(issues).set({ status: 'pending', updated_at: now }).where(eq(issues.id, it.issue_id)).run();
      }
      return reply.status(200).send({ ...it, status: 'pending' });
    },
  );

  app.post<{ Params: { id: string } }>(
    `${ROUTE_PATH}/:id/fetch-review-comments`,
    async (request, reply) => {
      const { id } = request.params;
      const source = db.select().from(iterations).where(eq(iterations.id, id)).get();
      if (!source) return reply.status(404).send({ error: 'iteration not found' });
      if (isIterationActive(source.status)) return reply.status(409).send({ error: 'cannot fetch review for an active iteration' });
      const issue = db.select().from(issues).where(eq(issues.id, source.issue_id)).get();
      if (!issue) return reply.status(404).send({ error: 'issue not found' });

      const dir = workspaceHostDirFor(deps.workspaceRoot ?? DEFAULT_WORKSPACE_ROOT, issue.id);
      let mrEntries: { repository_url: string; url: string; title: string }[] = [];
      try {
        const txt = await readFile(join(dir, 'result.json'), 'utf8');
        const data = JSON.parse(txt) as { merge_requests?: { repository_url: string; url: string; title: string }[] };
        mrEntries = data.merge_requests ?? [];
      } catch {
        return reply.status(404).send({ error: 'no MR/PR found for this iteration' });
      }
      if (mrEntries.length === 0) return reply.status(404).send({ error: 'no MR/PR found for this iteration' });

      type CommentEntry = { repo: string; file: string | null; line: number | null; body: string; author: string };
      const allComments: CommentEntry[] = [];
      const errors: string[] = [];
      for (const mr of mrEntries) {
        try {
          const comments = await deps.mr.fetchComments({
            mrUrl: mr.url,
            token: deps.mrToken ?? '',
            repositoryUrl: mr.repository_url,
          });
          for (const c of comments) allComments.push({ repo: mr.repository_url, file: c.file, line: c.line, body: c.body, author: c.author });
        } catch (error) {
          errors.push(`${mr.repository_url}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      if (allComments.length === 0 && errors.length > 0) return reply.status(502).send({ error: 'failed to fetch review comments', details: errors });
      return reply.status(200).send({ comments: allComments, errors: errors.length > 0 ? errors : undefined });
    },
  );
}