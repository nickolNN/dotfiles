import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Iteration } from '@issue-resolver/shared';
import { isIterationActive } from '@issue-resolver/shared';
import { eq, max } from 'drizzle-orm';
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
  DEFAULT_WORKSPACE_ROOT,
  iterationResultDirFor,
  resultArtifactFor,
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

      const iteration = db
        .select()
        .from(iterations)
        .where(eq(iterations.id, id))
        .get();
      if (!iteration) {
        return reply.status(404).send({ error: 'iteration not found' });
      }

      const runs = await listStepRunsWithLog(db, id);
      // Canonical-порядок уже step-first (pipeline order, внутри шага attempt
      // ASC) — пересортировка не нужна, иначе ломается контракт.
      return runs;
    },
  );

  app.get<{ Params: { id: string } }>(
    `${ROUTE_PATH}/:id/question-answers`,
    async (request, reply) => {
      const { id } = request.params;

      const iteration = db
        .select()
        .from(iterations)
        .where(eq(iterations.id, id))
        .get();
      if (!iteration) {
        return reply.status(404).send({ error: 'iteration not found' });
      }

      const answered_ids = await listAnsweredQuestionIds(db, id);
      return { answered_ids };
    },
  );

  app.get<{ Params: { id: string } }>(
    `${ROUTE_PATH}/:id/result`,
    async (request, reply) => {
      const { id } = request.params;

      const iteration = db
        .select()
        .from(iterations)
        .where(eq(iterations.id, id))
        .get();
      if (!iteration) {
        return reply.status(404).send({ error: 'iteration not found' });
      }

      const issue = db
        .select()
        .from(issues)
        .where(eq(issues.id, iteration.issue_id))
        .get();
      if (!issue) {
        return reply.status(404).send({ error: 'issue not found' });
      }

      const artifact = resultArtifactFor(issue.desired_result ?? 'md');
      if (!artifact) {
        return reply.status(404).send({ error: 'result not found' });
      }

      const dir = iterationResultDirFor(
        deps.workspaceRoot ?? DEFAULT_WORKSPACE_ROOT,
        iteration.issue_id,
        iteration.id,
      );
      let body: string;
      try {
        body = await readFile(join(dir, artifact.filename), 'utf8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          return reply.status(404).send({ error: 'result not found' });
        }
        throw error;
      }

      return reply
        .type(artifact.contentType)
        .header('Content-Disposition', 'inline')
        .send(body);
    },
  );

  app.get<{ Params: { id: string } }>(
    `${ROUTE_PATH}/:id/result/download`,
    async (request, reply) => {
      const { id } = request.params;

      const iteration = db
        .select()
        .from(iterations)
        .where(eq(iterations.id, id))
        .get();
      if (!iteration) {
        return reply.status(404).send({ error: 'iteration not found' });
      }

      const issue = db
        .select()
        .from(issues)
        .where(eq(issues.id, iteration.issue_id))
        .get();
      if (!issue) {
        return reply.status(404).send({ error: 'issue not found' });
      }

      const artifact = resultArtifactFor(issue.desired_result ?? 'md');
      if (!artifact) {
        return reply.status(404).send({ error: 'result not found' });
      }

      const dir = iterationResultDirFor(
        deps.workspaceRoot ?? DEFAULT_WORKSPACE_ROOT,
        iteration.issue_id,
        iteration.id,
      );
      let body: string;
      try {
        body = await readFile(join(dir, artifact.filename), 'utf8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          return reply.status(404).send({ error: 'result not found' });
        }
        throw error;
      }

      return reply
        .type(artifact.contentType)
        .header(
          'Content-Disposition',
          `attachment; filename="${artifact.filename}"`,
        )
        .send(body);
    },
  );

  // Повторить итерацию: новая итерация с теми же параметрами/запросом/
  // вложениями, что у исходной. Шаги и модели копируются КАК ЕСТЬ (уже
  // разрешённые на момент создания) — без пересборки шагов.
  app.post<{ Params: { id: string } }>(
    `${ROUTE_PATH}/:id/repeat`,
    async (request, reply) => {
      const { id } = request.params;

      const source = db
        .select()
        .from(iterations)
        .where(eq(iterations.id, id))
        .get();
      if (!source) {
        return reply.status(404).send({ error: 'iteration not found' });
      }

      // Повторить можно только завершённую/проваленную/отменённую итерацию.
      // Активную (running) или ещё не стартовавшую (pending) копировать нельзя.
      if (isIterationActive(source.status)) {
        return reply
          .status(409)
          .send({ error: 'cannot repeat an active iteration' });
      }

      const issue = db
        .select()
        .from(issues)
        .where(eq(issues.id, source.issue_id))
        .get();
      if (!issue) {
        return reply.status(404).send({ error: 'issue not found' });
      }

      const repositories = db
        .select()
        .from(issueRepositories)
        .where(eq(issueRepositories.issue_id, issue.id))
        .all()
        .map((repository) => ({
          repository_url: repository.repository_url,
          base_branch: repository.branch_name,
          create_mr: !!repository.create_mr,
          bootstrap_enabled: repository.bootstrap_enabled ?? true,
        }));

      const lastNumber =
        db
          .select({ value: max(iterations.number) })
          .from(iterations)
          .where(eq(iterations.issue_id, issue.id))
          .get()?.value ?? 0;

      const now = new Date().toISOString();
      const iterationId = randomUUID();
      const iteration: Iteration = {
        id: iterationId,
        issue_id: issue.id,
        number: lastNumber + 1,
        context: source.context,
        review_context: source.review_context ?? '',
        is_review_need: !!source.is_review_need,
        steps: source.steps,
        model: source.model ?? null,
        step_models: source.step_models ?? undefined,
        thinking_level: source.thinking_level ?? null,
        step_thinking_levels: source.step_thinking_levels ?? undefined,
        worker_count: source.worker_count ?? undefined,
        status: 'pending',
        created_at: now,
        updated_at: now,
      };

      db.insert(iterations).values(iteration).run();

      // Копируем вложения уровня итерации (файлы задачи с iteration_id IS NULL
      // не дублируем); физ-копии не нужны — attachments живут по issue_id+rel_path.
      const sourceFiles = await listByIteration(db, id);
      await insertMany(
        db,
        sourceFiles.map((file) => ({
          issueId: issue.id,
          iterationId,
          name: file.name,
          relPath: file.rel_path,
          size: file.size,
          mimeType: file.mime_type,
        })),
      );

      const prepareDeps = {
        container: deps.container,
        git: deps.git,
        sse: deps.sse,
        local: deps.local,
        ...(deps.bootstrapperFactory
          ? { bootstrapperFactory: deps.bootstrapperFactory }
          : {}),
        bootstrapperTimeoutMs: deps.bootstrapperTimeoutMs,
        workspaceRoot: deps.workspaceRoot,
      };
      // Подготовка + конвейер — фоновый прогон. HTTP-ответ возвращается
      // немедленно; прогресс и статус идут через SSE.
      void (async () => {
        try {
          const ws = await prepareIssueWorkspace(db, prepareDeps, {
            issueId: issue.id,
            iterationId,
            repositories,
          });
          void runIssueIteration(db, deps, {
            issue: {
              id: issue.id,
              title: issue.title,
              pipelineSteps: issue.pipeline_steps,
              description: issue.description ?? '',
              desiredResult: issue.desired_result ?? 'md',
              jiraIssueUrl: issue.jira_issue_url,
            },
            iteration: {
              id: iterationId,
              issueId: issue.id,
              number: iteration.number,
              context: iteration.context,
              steps: iteration.steps,
              reviewContext: iteration.review_context,
              isReviewNeed: iteration.is_review_need,
            },
            repositories,
            repoWorkspaces: ws,
            model: iteration.model ?? undefined,
            step_models: iteration.step_models,
            thinking_level: iteration.thinking_level ?? undefined,
            step_thinking_levels: iteration.step_thinking_levels,
          }).catch((error) => console.error('run failed', error));
        } catch (error) {
          console.error('preparation failed, issue set to failed', error);
        }
      })();

      return reply.status(201).send(iteration);
    },
  );

  // Получить комментарии ревью из MR/PR и создать новую итерацию с ними.
  app.post<{ Params: { id: string } }>(
    `${ROUTE_PATH}/:id/fetch-review-comments`,
    async (request, reply) => {
      const { id } = request.params;

      const source = db
        .select()
        .from(iterations)
        .where(eq(iterations.id, id))
        .get();
      if (!source) {
        return reply.status(404).send({ error: 'iteration not found' });
      }

      if (isIterationActive(source.status)) {
        return reply
          .status(409)
          .send({ error: 'cannot fetch review for an active iteration' });
      }

      const issue = db
        .select()
        .from(issues)
        .where(eq(issues.id, source.issue_id))
        .get();
      if (!issue) {
        return reply.status(404).send({ error: 'issue not found' });
      }

      // Читаем result.json из корня рабочей папки задачи — там MR URL-ы.
      const workspaceHostDir = workspaceHostDirFor(
        deps.workspaceRoot ?? DEFAULT_WORKSPACE_ROOT,
        issue.id,
      );
      let mrEntries: { repository_url: string; url: string; title: string }[] = [];
      try {
        const resultText = await readFile(
          join(workspaceHostDir, 'result.json'),
          'utf8',
        );
        const resultData = JSON.parse(resultText) as {
          merge_requests?: { repository_url: string; url: string; title: string }[];
        };
        mrEntries = resultData.merge_requests ?? [];
      } catch {
        return reply
          .status(404)
          .send({ error: 'no MR/PR found for this iteration' });
      }

      if (mrEntries.length === 0) {
        return reply
          .status(404)
          .send({ error: 'no MR/PR found for this iteration' });
      }

      // Собираем комментарии со всех MR.
      type CommentEntry = { repo: string; file: string | null; line: number | null; body: string; author: string };
      const allComments: CommentEntry[] = [];
      const errors: string[] = [];

      for (const mr of mrEntries) {
        try {
          const comments = await deps.mr.fetchComments({
            mrUrl: mr.url,
            token: deps.mrToken ?? '',
          });
          for (const c of comments) {
            allComments.push({
              repo: mr.repository_url,
              file: c.file,
              line: c.line,
              body: c.body,
              author: c.author,
            });
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          errors.push(`${mr.repository_url}: ${message}`);
        }
      }

      if (allComments.length === 0 && errors.length > 0) {
        return reply.status(502).send({
          error: 'failed to fetch review comments',
          details: errors,
        });
      }

      // Формируем контекст из комментариев: файл + строка + текст.
      const contextParts: string[] = [
        `Review comments from MR/PR (fetched from ${mrEntries.length} MR(s)):`,
        '',
      ];
      for (const c of allComments) {
        const location = c.file
          ? `${c.file}${c.line !== null ? `:${c.line}` : ''}`
          : 'общий комментарий';
        contextParts.push(
          `- **${c.author}** [${c.repo} → ${location}]:`,
          `  ${c.body}`,
          '',
        );
      }
      if (errors.length > 0) {
        contextParts.push(
          '',
          '⚠ Некоторые MR не удалось опросить:',
          ...errors.map((e) => `  - ${e}`),
        );
      }
      const reviewContext = contextParts.join('\n');

      // Создаём новую итерацию с контекстом ревью.
      const repositories = db
        .select()
        .from(issueRepositories)
        .where(eq(issueRepositories.issue_id, issue.id))
        .all()
        .map((repository) => ({
          repository_url: repository.repository_url,
          base_branch: repository.branch_name,
          create_mr: !!repository.create_mr,
          bootstrap_enabled: repository.bootstrap_enabled ?? true,
        }));

      const lastNumber =
        db
          .select({ value: max(iterations.number) })
          .from(iterations)
          .where(eq(iterations.issue_id, issue.id))
          .get()?.value ?? 0;

      const now = new Date().toISOString();
      const iterationId = randomUUID();
      const iteration: Iteration = {
        id: iterationId,
        issue_id: issue.id,
        number: lastNumber + 1,
        context: source.context,
        review_context: reviewContext,
        is_review_need: true,
        steps: source.steps,
        model: source.model ?? null,
        step_models: source.step_models ?? undefined,
        thinking_level: source.thinking_level ?? null,
        step_thinking_levels: source.step_thinking_levels ?? undefined,
        worker_count: source.worker_count ?? undefined,
        status: 'pending',
        created_at: now,
        updated_at: now,
      };

      db.insert(iterations).values(iteration).run();

      // Запускаем подготовку + конвейер асинхронно.
      const prepareDeps = {
        container: deps.container,
        git: deps.git,
        sse: deps.sse,
        local: deps.local,
        ...(deps.bootstrapperFactory
          ? { bootstrapperFactory: deps.bootstrapperFactory }
          : {}),
        bootstrapperTimeoutMs: deps.bootstrapperTimeoutMs,
        workspaceRoot: deps.workspaceRoot,
      };
      void (async () => {
        try {
          const ws = await prepareIssueWorkspace(db, prepareDeps, {
            issueId: issue.id,
            iterationId,
            repositories,
          });
          void runIssueIteration(db, deps, {
            issue: {
              id: issue.id,
              title: issue.title,
              pipelineSteps: issue.pipeline_steps,
              description: issue.description ?? '',
              desiredResult: issue.desired_result ?? 'md',
              jiraIssueUrl: issue.jira_issue_url,
            },
            iteration: {
              id: iterationId,
              issueId: issue.id,
              number: iteration.number,
              context: iteration.context,
              steps: iteration.steps,
              reviewContext: reviewContext,
              isReviewNeed: true,
            },
            repositories,
            repoWorkspaces: ws,
            model: iteration.model ?? undefined,
            step_models: iteration.step_models,
            thinking_level: iteration.thinking_level ?? undefined,
            step_thinking_levels: iteration.step_thinking_levels,
          }).catch((error) => console.error('run failed', error));
        } catch (error) {
          console.error('preparation failed, issue set to failed', error);
        }
      })();

      return reply.status(201).send(iteration);
    },
  );
}