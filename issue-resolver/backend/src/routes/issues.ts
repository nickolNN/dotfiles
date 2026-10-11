import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, rm } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type {
  DesiredResult,
  Issue,
  Iteration,
  PipelineStep,
} from '@issue-resolver/shared';
import { extractIssueKeyFromUrl, statusOfIssue } from '@issue-resolver/shared';
import { and, desc, eq, max } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { Db } from '../db/client';
import {
  deleteById,
  getById,
  insertMany,
  listByIssue,
  type NewIssueFile,
} from '../db/issue-files.repo';
import { issueRepositories, issues, iterations } from '../db/schema';
import type { JiraClient } from '../jira/client';
import {
  createIssueRequestSchema,
  createIterationRequestSchema,
  formatZodError,
} from '../validation';
import type { IterationRunDeps } from '../workflow/run-iteration.service';
import { runIssueIteration } from '../workflow/run-iteration.service';
import {
  attachmentsFilePathFor,
  saveUpload,
  type UploadInput,
} from '../workspace/attachments';
import { createTarGz, type ArchiveEntry } from '../workspace/archive';
import {
  listWorkspaceFiles,
  mimeForFilename,
  workspaceFilePathFor,
} from '../workspace/workspace-files';
import { readRequestPayload } from './multipart';
import {
  containerNameFor,
  DEFAULT_WORKSPACE_ROOT,
  iterationResultDirFor,
  resultArtifactFor,
  type ResultArtifact,
  workspaceHostDirFor,
} from '../workspace/paths';

const API_PATH = '/issue-resolver/api/v1';
const ROUTE_PATH = `${API_PATH}/issues`;
const DEFAULT_STEPS: readonly PipelineStep[] = ['refine', 'resolve'];

/**
 * Эффективные шаги задачи: 'resolve' всегда присутствует; при createMr —
 * 'pr' в конец. Список шагов приходит из `pipeline_steps`/`steps` напрямую:
 * review и test выбираются независимо пользователем, флагом не навязываются.
 * Остальное — без дублей, в исходном порядке.
 */
function resolvePipelineSteps(
  input: PipelineStep[] | undefined,
  createMr: boolean,
): PipelineStep[] {
  const steps = input && input.length > 0 ? input : DEFAULT_STEPS;
  const deduped = [...new Set(steps)];
  const withResolve: PipelineStep[] = deduped.includes('resolve')
    ? deduped
    : ['resolve', ...deduped];
  return combineSteps(withResolve, createMr);
}

/**
 * Шаги итерации: без принудительного 'resolve' (сохраняем override), но то же
 * правило комбинирования pr.
 */
function combineIterationSteps(
  input: PipelineStep[],
  createMr: boolean,
): PipelineStep[] {
  return combineSteps([...new Set(input)], createMr);
}

/** Общее правило: pr в конец при createMr; набор шагов не переписывается. */
function combineSteps(
  input: PipelineStep[],
  createMr: boolean,
): PipelineStep[] {
  let steps = input;
  if (createMr && !steps.includes('pr')) {
    steps = [...steps, 'pr'];
  }
  return steps;
}

/**
 * Приводит шаги к желаемому результату задачи: 'pr' гарантирован для
 * desired result 'pr' и убран для 'html'.
 */
function applyDesiredResult(
  steps: PipelineStep[],
  desiredResult: DesiredResult,
): PipelineStep[] {
  if (desiredResult === 'pr') {
    return steps.includes('pr') ? steps : [...steps, 'pr'];
  }
  return steps.filter((step) => step !== 'pr');
}

/** Строка БД → Iteration: 0/1 → boolean, review_context с дефолтом ''. */
function toIteration(row: typeof iterations.$inferSelect): Iteration {
  return {
    id: row.id,
    issue_id: row.issue_id,
    number: row.number,
    context: row.context,
    review_context: row.review_context ?? '',
    is_review_need: !!row.is_review_need,
    steps: row.steps,
    status: row.status,
    model: row.model ?? null,
    step_models: row.step_models ?? undefined,
    thinking_level: row.thinking_level ?? null,
    step_thinking_levels: row.step_thinking_levels ?? undefined,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/** Сборка Issue из строк БД: repositories — из issue_repositories, status — из последней итерации. */
function toIssue(
  db: Db,
  row: typeof issues.$inferSelect,
  workspaceRoot: string,
): Issue {
  const repositories = db
    .select()
    .from(issueRepositories)
    .where(eq(issueRepositories.issue_id, row.id))
    .all()
    .map((repository) => ({
      id: repository.id,
      repository_url: repository.repository_url,
      branch_name: repository.branch_name,
      create_mr: !!repository.create_mr,
      created_at: repository.created_at,
      updated_at: repository.updated_at,
    }));

  const iterationRows = db
    .select()
    .from(iterations)
    .where(eq(iterations.issue_id, row.id))
    .all();

  return {
    id: row.id,
    title: row.title,
    description: row.description ?? '',
    desired_result: row.desired_result ?? 'md',
    jira_issue_url: row.jira_issue_url,
    source: row.source ?? null,
    repositories,
    pipeline_steps: row.pipeline_steps,
    step_models: row.step_models ?? undefined,
    thinking_level: row.thinking_level ?? null,
    step_thinking_levels: row.step_thinking_levels ?? undefined,
    status: statusOfIssue(iterationRows.map(toIteration)) ?? 'pending',
    created_at: row.created_at,
    updated_at: row.updated_at,
    workspace_missing: !existsSync(workspaceHostDirFor(workspaceRoot, row.id)),
  };
}

/**
 * Читает артефакт результата из указанной папки. null — файла нет (ENOENT);
 * прочие ошибки чтения пробрасываются.
 */
async function readArtifactFrom(
  dir: string,
  artifact: ResultArtifact,
): Promise<({ body: string } & ResultArtifact) | null> {
  const path = join(dir, artifact.filename);
  try {
    const body = await readFile(path, 'utf8');
    return { ...artifact, body };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

/** id последней завершённой итерации задачи (по номеру), иначе null. */
function latestCompletedIterationId(db: Db, issueId: string): string | null {
  const row = db
    .select({ id: iterations.id })
    .from(iterations)
    .where(
      and(eq(iterations.issue_id, issueId), eq(iterations.status, 'completed')),
    )
    .orderBy(desc(iterations.number))
    .get();
  return row?.id ?? null;
}

/**
 * Сохраняет загруженные файлы в папку задачи/итерации и пишет строки в БД.
 * Вызывать до `runIssueIteration`, чтобы файлы уже лежали в cwd агента.
 */
async function saveAttachments(
  db: Db,
  deps: IterationRunDeps,
  issueId: string,
  iterationId: string,
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

/** RFC 5987-энкодер для `filename*` (encodeURIComponent + reserved attr-chars). */
function rfc5987(value: string): string {
  return encodeURIComponent(value).replace(
    /['()!*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/**
 * `Content-Disposition: attachment` с ASCII-фолбеком (кавычки/слэши/переводы
 * строк → `_`) и `filename*` (UTF-8) для не-ASCII имён.
 */
function attachmentDisposition(name: string): string {
  const ascii =
    name.replace(/["\\\r\n]/g, '_').replace(/[^\x20-\x7e]/g, '_') || 'file';
  return `attachment; filename="${ascii}"; filename*=UTF-8''${rfc5987(name)}`;
}

export async function issuesRoutes(
  app: FastifyInstance,
  db: Db,
  deps: IterationRunDeps,
  jira: JiraClient,
): Promise<void> {
  const findIssue = (id: string) =>
    db.select().from(issues).where(eq(issues.id, id)).get();

  app.get(ROUTE_PATH, async () => {
    const rows = db
      .select()
      .from(issues)
      .orderBy(desc(issues.created_at))
      .all();

    return rows.map((row) =>
      toIssue(db, row, deps.workspaceRoot ?? DEFAULT_WORKSPACE_ROOT),
    );
  });

  app.get<{ Params: { id: string } }>(
    `${ROUTE_PATH}/:id`,
    async (request, reply) => {
      const issue = findIssue(request.params.id);
      if (!issue) {
        return reply.status(404).send({ error: 'issue not found' });
      }
      return toIssue(db, issue, deps.workspaceRoot ?? DEFAULT_WORKSPACE_ROOT);
    },
  );

  app.get<{ Params: { id: string } }>(
    `${ROUTE_PATH}/:id/result`,
    async (request, reply) => {
      const { id } = request.params;
      const issue = findIssue(id);
      if (!issue) {
        return reply.status(404).send({ error: 'issue not found' });
      }

      const artifact = resultArtifactFor(issue.desired_result ?? 'md');
      if (!artifact) {
        return reply.status(404).send({ error: 'result not found' });
      }
      const latest = latestCompletedIterationId(db, id);
      if (latest === null) {
        return reply.status(404).send({ error: 'result not found' });
      }
      const dir = iterationResultDirFor(
        deps.workspaceRoot ?? DEFAULT_WORKSPACE_ROOT,
        id,
        latest,
      );
      const result = await readArtifactFrom(dir, artifact);
      if (!result) {
        return reply.status(404).send({ error: 'result not found' });
      }
      return reply
        .type(result.contentType)
        .header('Content-Disposition', 'inline')
        .send(result.body);
    },
  );

  app.get<{ Params: { id: string } }>(
    `${ROUTE_PATH}/:id/result/download`,
    async (request, reply) => {
      const { id } = request.params;
      const issue = findIssue(id);
      if (!issue) {
        return reply.status(404).send({ error: 'issue not found' });
      }

      const artifact = resultArtifactFor(issue.desired_result ?? 'md');
      if (!artifact) {
        return reply.status(404).send({ error: 'result not found' });
      }
      const latest = latestCompletedIterationId(db, id);
      if (latest === null) {
        return reply.status(404).send({ error: 'result not found' });
      }
      const dir = iterationResultDirFor(
        deps.workspaceRoot ?? DEFAULT_WORKSPACE_ROOT,
        id,
        latest,
      );
      const result = await readArtifactFrom(dir, artifact);
      if (!result) {
        return reply.status(404).send({ error: 'result not found' });
      }
      return reply
        .type(result.contentType)
        .header(
          'Content-Disposition',
          `attachment; filename="${result.filename}"`,
        )
        .send(result.body);
    },
  );

  app.get<{ Params: { id: string } }>(
    `${ROUTE_PATH}/:id/result/files`,
    async (request, reply) => {
      const { id } = request.params;
      const issue = findIssue(id);
      if (!issue) {
        return reply.status(404).send({ error: 'issue not found' });
      }
      if (latestCompletedIterationId(db, id) === null) {
        return reply.status(404).send({ error: 'result not found' });
      }

      const artifact = resultArtifactFor(issue.desired_result ?? 'md');
      return listWorkspaceFiles(
        deps.workspaceRoot ?? DEFAULT_WORKSPACE_ROOT,
        id,
        new Set([artifact?.filename ?? '']),
      );
    },
  );

  app.get<{ Params: { id: string } }>(
    `${ROUTE_PATH}/:id/result/files/archive`,
    async (request, reply) => {
      const { id } = request.params;
      const issue = findIssue(id);
      if (!issue) {
        return reply.status(404).send({ error: 'issue not found' });
      }
      const latest = latestCompletedIterationId(db, id);
      if (latest === null) {
        return reply.status(404).send({ error: 'result not found' });
      }

      const root = deps.workspaceRoot ?? DEFAULT_WORKSPACE_ROOT;
      const artifact = resultArtifactFor(issue.desired_result ?? 'md');
      const files = await listWorkspaceFiles(
        root,
        id,
        new Set([artifact?.filename ?? '']),
      );

      const entries: ArchiveEntry[] = [];
      for (const file of files) {
        const abs = workspaceFilePathFor(root, id, file.rel_path);
        if (!abs) {
          continue;
        }
        try {
          entries.push({
            name: file.name,
            relPath: file.rel_path,
            body: await readFile(abs),
          });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            continue;
          }
          throw error;
        }
      }

      // Артефакт результата живёт в снапшоте `.iteration-results`, а не в
      // рабочей папке, поэтому добавляем его отдельно.
      if (artifact) {
        const result = await readArtifactFrom(
          iterationResultDirFor(root, id, latest),
          artifact,
        );
        if (result) {
          entries.push({
            name: artifact.filename,
            relPath: artifact.filename,
            body: Buffer.from(result.body),
          });
        }
      }

      if (entries.length === 0) {
        return reply.status(404).send({ error: 'result not found' });
      }

      const buf = await createTarGz(entries);
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
      const issue = findIssue(id);
      if (!issue) {
        return reply.status(404).send({ error: 'issue not found' });
      }
      if (latestCompletedIterationId(db, id) === null) {
        return reply.status(404).send({ error: 'result not found' });
      }

      // Guard: только внутри рабочей папки задачи (защита от traversal).
      const path = workspaceFilePathFor(
        deps.workspaceRoot ?? DEFAULT_WORKSPACE_ROOT,
        id,
        request.query.path ?? '',
      );
      if (!path) {
        return reply.status(404).send({ error: 'file not found' });
      }

      let body: Buffer;
      try {
        body = await readFile(path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          return reply.status(404).send({ error: 'file not found' });
        }
        throw error;
      }

      const name = basename(path);
      // `inline=1` — для предпросмотра (iframe/img); без него — скачивание.
      const disposition =
        request.query.inline === '1'
          ? 'inline'
          : attachmentDisposition(name);
      return reply
        .type(mimeForFilename(name) ?? 'application/octet-stream')
        .header('Content-Disposition', disposition)
        .send(body);
    },
  );

  app.get<{ Params: { id: string } }>(
    `${ROUTE_PATH}/:id/iterations`,
    async (request, reply) => {
      const { id } = request.params;
      if (!findIssue(id)) {
        return reply.status(404).send({ error: 'issue not found' });
      }

      return db
        .select()
        .from(iterations)
        .where(eq(iterations.issue_id, id))
        .orderBy(iterations.number)
        .all()
        .map(toIteration);
    },
  );

  app.get<{ Params: { id: string } }>(
    `${ROUTE_PATH}/:id/files`,
    async (request, reply) => {
      const { id } = request.params;
      if (!findIssue(id)) {
        return reply.status(404).send({ error: 'issue not found' });
      }

      return listByIssue(db, id);
    },
  );

  app.delete<{ Params: { id: string } }>(
    `${ROUTE_PATH}/:id`,
    async (request, reply) => {
      const { id } = request.params;
      if (!findIssue(id)) {
        return reply.status(404).send({ error: 'issue not found' });
      }

      // Контейнер и рабочая папка — best-effort: их отсутствие не должно
      // мешать удалению записи задачи из БД.
      try {
        await deps.container.remove(containerNameFor(id));
      } catch (error) {
        console.error('remove container failed', error);
      }
      try {
        await rm(
          workspaceHostDirFor(
            deps.workspaceRoot ?? DEFAULT_WORKSPACE_ROOT,
            id,
          ),
          { recursive: true, force: true },
        );
      } catch (error) {
        console.error('remove workspace failed', error);
      }

      // Дети (repositories/iterations/step_runs/step_outputs) уходят каскадом.
      db.delete(issues).where(eq(issues.id, id)).run();
      return reply.code(204).send();
    },
  );

  app.delete<{ Params: { fileId: string } }>(
    `${API_PATH}/files/:fileId`,
    async (request, reply) => {
      const row = await deleteById(db, request.params.fileId);
      if (!row) {
        return reply.status(404).send({ error: 'file not found' });
      }

      // Файл — best-effort; guard не даёт выйти за папку attachments задачи.
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
        return reply.status(404).send({ error: 'file not found' });
      }

      // Guard: только внутри папки attachments задачи (защита от traversal).
      const path = attachmentsFilePathFor(
        deps.workspaceRoot ?? DEFAULT_WORKSPACE_ROOT,
        row.issue_id,
        row.rel_path,
      );
      if (!path) {
        return reply.status(404).send({ error: 'file not found' });
      }

      let body: Buffer;
      try {
        body = await readFile(path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          return reply.status(404).send({ error: 'file not found' });
        }
        throw error;
      }

      return reply
        .type(row.mime_type || 'application/octet-stream')
        .header('Content-Disposition', attachmentDisposition(row.name))
        .send(body);
    },
  );

  app.post<{ Params: { id: string } }>(
    `${ROUTE_PATH}/:id/iterations`,
    async (request, reply) => {
      const { id } = request.params;

      const requestPayload = await readRequestPayload(request);
      if (!requestPayload.ok) {
        return reply.status(400).send({ error: requestPayload.error });
      }

      const parsed = createIterationRequestSchema.safeParse(
        requestPayload.body,
      );
      if (!parsed.success) {
        return reply.status(400).send({ error: formatZodError(parsed.error) });
      }

      const issue = findIssue(id);
      if (!issue) {
        return reply.status(404).send({ error: 'issue not found' });
      }

      const body = parsed.data;
      const isReviewNeed = body.is_review_need ?? false;
      const reviewContext = body.review_context ?? '';

      const repositories = db
        .select()
        .from(issueRepositories)
        .where(eq(issueRepositories.issue_id, id))
        .all()
        .map((repository) => ({
          repository_url: repository.repository_url,
          base_branch: repository.branch_name,
          create_mr: !!repository.create_mr,
        }));
      const createMr = repositories.some((repository) => repository.create_mr);

      const lastNumber =
        db
          .select({ value: max(iterations.number) })
          .from(iterations)
          .where(eq(iterations.issue_id, id))
          .get()?.value ?? 0;

      const now = new Date().toISOString();
      const iterationId = randomUUID();
      const iteration: Iteration = {
        id: iterationId,
        issue_id: id,
        number: lastNumber + 1,
        context: body.context,
        review_context: reviewContext,
        is_review_need: isReviewNeed,
        steps: applyDesiredResult(
          combineIterationSteps(
            body.steps ?? issue.pipeline_steps,
            createMr,
          ),
          issue.desired_result ?? 'md',
        ),
        model: body.model ?? null,
        step_models: body.step_models,
        thinking_level: body.thinking_level ?? null,
        step_thinking_levels: body.step_thinking_levels,
        status: 'pending',
        created_at: now,
        updated_at: now,
      };

      db.insert(iterations).values(iteration).run();

      await saveAttachments(
        db,
        deps,
        id,
        iterationId,
        iteration.number,
        requestPayload.files,
      );

      // Фоновый прогон: HTTP-ответ не ждёт конвейера.
      void runIssueIteration(db, deps, {
        issue: {
          id,
          title: issue.title,
          pipelineSteps: issue.pipeline_steps,
          description: issue.description ?? '',
          desiredResult: issue.desired_result ?? 'md',
          jiraIssueUrl: issue.jira_issue_url,
        },
        iteration: {
          id: iterationId,
          issueId: id,
          number: iteration.number,
          context: iteration.context,
          steps: iteration.steps,
          reviewContext: iteration.review_context,
          isReviewNeed: iteration.is_review_need,
        },
        repositories,
        model: body.model,
        step_models: body.step_models,
        thinking_level: body.thinking_level,
        step_thinking_levels: body.step_thinking_levels,
      }).catch((error) => console.error('run failed', error));

      return reply.status(201).send(iteration);
    },
  );

  app.post(ROUTE_PATH, async (request, reply) => {
    const requestPayload = await readRequestPayload(request);
    if (!requestPayload.ok) {
      return reply.status(400).send({ error: requestPayload.error });
    }

    const parsed = createIssueRequestSchema.safeParse(requestPayload.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: formatZodError(parsed.error) });
    }

    const body = parsed.data;
    const explicitTitle = body.title?.trim();
    const jiraIssueUrl = body.jira_issue_url ?? null;

    let title = explicitTitle ?? '';
    let additionalContext = body.additional_context ?? '';
    // Описание задачи — исходный additional_context (до Jira-обогащения).
    const description = body.additional_context ?? '';

    // Фаза 6: jira_issue_url без явного title — обогащаемся из Jira.
    // Любая ошибка Jira деградирует до title = ключ, запрос не падает.
    if (!explicitTitle && jiraIssueUrl) {
      const key = extractIssueKeyFromUrl(jiraIssueUrl);
      if (key) {
        try {
          const issue = await jira.fetchIssue(key);
          title = issue.title || key;
          if (issue.summary) {
            additionalContext = additionalContext
              ? `${additionalContext}\n\n${issue.summary}`
              : issue.summary;
          }
        } catch {
          title = key;
        }
      }
    }

    if (!title) {
      return reply.status(400).send({
        error:
          'Не удалось определить title: передайте title или jira_issue_url с ключом тикета',
      });
    }

    const isReviewNeed = body.is_review_need ?? false;
    const reviewContext = body.review_context ?? '';
    const desiredResult: DesiredResult = body.desired_result ?? 'md';
    const createMr = (body.repositories ?? []).some(
      (repository) => repository.create_mr === true,
    );
    const pipelineSteps = applyDesiredResult(
      resolvePipelineSteps(body.pipeline_steps, createMr),
      desiredResult,
    );
    const now = new Date().toISOString();
    const issueId = randomUUID();
    const iterationId = randomUUID();

    const repositories = (body.repositories ?? []).map((repository) => ({
      id: randomUUID(),
      repository_url: repository.repository_url,
      branch_name: repository.base_branch,
      create_mr: repository.create_mr ?? false,
      created_at: now,
      updated_at: now,
    }));

    db.transaction((tx) => {
      tx.insert(issues)
        .values({
          id: issueId,
          title,
          description,
          desired_result: desiredResult,
          jira_issue_url: jiraIssueUrl,
          pipeline_steps: pipelineSteps,
          step_models: body.step_models ?? null,
          thinking_level: body.thinking_level ?? null,
          step_thinking_levels: body.step_thinking_levels ?? null,
          container_name: null,
          source: jiraIssueUrl ? 'jira' : null,
          status: 'pending',
          created_at: now,
          updated_at: now,
        })
        .run();

      if (repositories.length > 0) {
        tx.insert(issueRepositories)
          .values(
            repositories.map((repository) => ({
              ...repository,
              issue_id: issueId,
            })),
          )
          .run();
      }

      tx.insert(iterations)
        .values({
          id: iterationId,
          issue_id: issueId,
          number: 1,
          context: additionalContext,
          review_context: reviewContext,
          is_review_need: isReviewNeed,
          steps: pipelineSteps,
          model: body.model ?? null,
          step_models: body.step_models ?? null,
          thinking_level: body.thinking_level ?? null,
          step_thinking_levels: body.step_thinking_levels ?? null,
          status: 'pending',
          created_at: now,
          updated_at: now,
        })
        .run();
    });

    await saveAttachments(db, deps, issueId, iterationId, 1, requestPayload.files);

    // Фоновый прогон: HTTP-ответ не ждёт конвейера.
    void runIssueIteration(db, deps, {
      issue: {
        id: issueId,
        title,
        pipelineSteps,
        description,
        desiredResult,
        jiraIssueUrl,
      },
      iteration: {
        id: iterationId,
        issueId,
        number: 1,
        context: additionalContext,
        steps: pipelineSteps,
        reviewContext,
        isReviewNeed,
      },
      repositories: body.repositories ?? [],
      model: body.model,
      step_models: body.step_models,
      thinking_level: body.thinking_level,
      step_thinking_levels: body.step_thinking_levels,
    }).catch((error) => console.error('run failed', error));

    return reply.status(201).send({
      id: issueId,
      title,
      description,
      desired_result: desiredResult,
      jira_issue_url: jiraIssueUrl,
      source: jiraIssueUrl ? 'jira' : null,
      repositories,
      pipeline_steps: pipelineSteps,
      step_models: body.step_models,
      thinking_level: body.thinking_level ?? null,
      step_thinking_levels: body.step_thinking_levels,
      status: 'pending',
      created_at: now,
      updated_at: now,
    });
  });
}