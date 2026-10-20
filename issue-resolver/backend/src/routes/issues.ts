import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { readFile, rm } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type {
  DesiredResult,
  Iteration,
  PipelineStep,
} from '@issue-resolver/shared';
import { extractIssueKeyFromUrl, type TaskStatus } from '@issue-resolver/shared';
import { and, eq, max } from 'drizzle-orm';
import type { IssueService } from '../issues/service';
import type { FastifyInstance } from 'fastify';
import type { Db } from '../db/client';
import {
  deleteById,
  getById,
  insertMany,
  listByIssue,
  type NewIssueFile,
} from '../db/issue-files.repo';
import { getRepository } from '../db/repositories.repo';
import { issueRepositories, issues, iterations } from '../db/schema';
import type { JiraClient, JiraIssueFull } from '../jira/client';
import {
  createIssueRequestSchema,
  createIterationRequestSchema,
  formatZodError,
  validateJiraUrlSchema,
} from '../validation';
import type { IterationRunDeps } from '../workflow/run-iteration.service';
import {
  prepareIssueWorkspace,
  runIssueIteration,
} from '../workflow/run-iteration.service';
import {
  attachmentsFilePathFor,
  saveUpload,
  type UploadInput,
} from '../workspace/attachments';
import { releaseIssueDevPorts } from '../port-allocator';
import { mimeForFilename, workspaceFilePathFor } from '../workspace/workspace-files';
import { readRequestPayload } from './multipart';
import {
  containerNameFor,
  DEFAULT_WORKSPACE_ROOT,
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

/** Нормализованный репозиторий задачи: URL + ветка (repo_id → url/defaultBranch). */
interface ResolvedIssueRepository {
  repository_url: string;
  base_branch: string;
  create_mr: boolean;
  /** false — репозиторий клонируется, но install/анализ запуска пропускаются. */
  bootstrap_enabled: boolean;
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
    worker_count: row.worker_count ?? undefined,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/**
 * Сохраняет загруженные файлы в папку задачи/итерации и пишет строки в БД.
 * Вызывать до `runIssueIteration`, чтобы файлы уже лежали в cwd агента.
 */
async function saveAttachments(
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
  service: IssueService,
): Promise<void> {
  const config = service.resolveConfig(deps);

  /** Собирает человекочитаемый Markdown из полных данных Jira. */
  function buildJiraMarkdown(full: JiraIssueFull): string {
    const issue = full.issue;
    const raw = issue.raw as Record<string, unknown> | undefined;
    const fields = raw?.fields as Record<string, unknown> | undefined;

    const parts: string[] = [
      `# ${issue.title}`,
      '',
      `**Ключ:** ${issue.key}`,
    ];

    // Статус, приоритет, исполнитель
    if (fields) {
      const status = (fields.status as { name?: string } | undefined)?.name;
      const priority = (fields.priority as { name?: string } | undefined)?.name;
      const assignee = (fields.assignee as { displayName?: string } | undefined)?.displayName;
      if (status || priority || assignee) {
        parts.push('');
        if (status) parts.push(`**Статус:** ${status}`);
        if (priority) parts.push(`**Приоритет:** ${priority}`);
        if (assignee) parts.push(`**Исполнитель:** ${assignee}`);
      }
    }

    // Описание
    parts.push('', '## Описание', '', issue.summary || '_Описания нет_');

    // Комментарии
    if (full.comments.length > 0) {
      parts.push('', '## Комментарии', '');
      for (const c of full.comments) {
        const date = c.created ? new Date(c.created).toLocaleString('ru-RU') : '';
        parts.push(`### ${c.author} — ${date}`, '', c.body, '');
      }
    }

    // История изменений (последние 30 записей)
    if (full.changelog.length > 0) {
      parts.push('', '## История изменений', '');
      const recent = full.changelog.slice(0, 30);
      for (const entry of recent) {
        const date = entry.created
          ? new Date(entry.created).toLocaleString('ru-RU')
          : '';
        const itemDescs = entry.items.map(
          (i) => `  - ${i.field}: _${i.fromString ?? '—'}_ → **${i.toString ?? '—'}**`,
        );
        parts.push(`**${entry.author}** — ${date}`, ...itemDescs, '');
      }
    }

    return parts.join('\n');
  }

  app.get(ROUTE_PATH, async () => service.listIssues(db, config));

  app.get<{ Params: { id: string } }>(
    `${ROUTE_PATH}/:id`,
    async (request, reply) => {
      const issue = service.getIssue(db, config, request.params.id);
      if (!issue) {
        return reply.status(404).send({ error: 'issue not found' });
      }
      return issue;
    },
  );

  /**
   * Живая статистика контейнера задачи (CPU/память/pids). Контейнера нет
   * (Dockerode отвечает 404) → `{ containerName, error: 'container_not_found' }`;
   * прочие сбои не роняем — отдаём `ContainerStats` с null/нулевыми полями.
   */
  app.get<{ Params: { id: string } }>(
    `${ROUTE_PATH}/:id/container-stats`,
    async (request, reply) => {
      const { id } = request.params;
      if (!service.getIssue(db, config, id)) {
        return reply.status(404).send({ error: 'issue not found' });
      }

      const containerName = containerNameFor(id);
      try {
        return await deps.container.stats(containerName);
      } catch (error) {
        if ((error as { statusCode?: number }).statusCode === 404) {
          return { containerName, error: 'container_not_found' };
        }
        console.error('container stats failed', error);
        return {
          containerName,
          cpuPercent: null,
          memoryUsageBytes: 0,
          memoryLimitBytes: 0,
          pids: 0,
        };
      }
    },
  );

  app.post<{ Params: { id: string } }>(
    `${ROUTE_PATH}/:id/stop-dev-servers`,
    async (request, reply) => {
      const { id } = request.params;
      const issue = service.getIssue(db, config, id);
      if (!issue) {
        return reply.status(404).send({ error: 'issue not found' });
      }

      const pid =
        db
          .select({ dev_server_pid: issues.dev_server_pid })
          .from(issues)
          .where(eq(issues.id, id))
          .get()?.dev_server_pid ?? null;
      if (pid) {
        // Процесс запущен detached — это лидер группы, поэтому SIGTERM/SIGKILL
        // шлём группе (-pid), а при её отсутствии — самому PID.
        const signal = (sig: NodeJS.Signals): void => {
          try {
            process.kill(-pid, sig);
          } catch {
            try {
              process.kill(pid, sig);
            } catch {
              // Процесс уже мёртв — это нормально.
            }
          }
        };
        signal('SIGTERM');
        await new Promise((resolve) => setTimeout(resolve, 500));
        signal('SIGKILL');
      }

      releaseIssueDevPorts(id);
      db.update(issues)
        .set({ dev_server_port: null, dev_server_pid: null })
        .where(eq(issues.id, id))
        .run();

      return { ok: true };
    },
  );

  app.get<{ Params: { id: string } }>(
    `${ROUTE_PATH}/:id/jira-preview`,
    async (request, reply) => {
      const { id } = request.params;
      const issue = service.getIssue(db, config, id);
      if (!issue) {
        return reply.status(404).send({ error: 'issue not found' });
      }
      if (!issue.jira_issue_url) {
        return reply.status(404).send({ error: 'no jira issue attached' });
      }
      const key = extractIssueKeyFromUrl(issue.jira_issue_url);
      if (!key) {
        return reply.status(404).send({ error: 'cannot extract issue key' });
      }
      const wsDir = workspaceHostDirFor(
        deps.workspaceRoot ?? DEFAULT_WORKSPACE_ROOT,
        id,
      );
      const mdPath = join(wsDir, 'jira', `${key}.md`);
      try {
        const content = await readFile(mdPath, 'utf8');
        return reply.type('text/markdown; charset=utf-8').send(content);
      } catch {
        return reply.status(404).send({ error: 'jira preview not found' });
      }
    },
  );

  app.get<{ Params: { id: string } }>(
    `${ROUTE_PATH}/:id/result`,
    async (request, reply) => {
      const { id } = request.params;
      const issue = service.getIssue(db, config, id);
      if (!issue) {
        return reply.status(404).send({ error: 'issue not found' });
      }

      const result = await service.getResultArtifact(db, config, id);
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
      const issue = service.getIssue(db, config, id);
      if (!issue) {
        return reply.status(404).send({ error: 'issue not found' });
      }

      const result = await service.getResultArtifact(db, config, id);
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
      const issue = service.getIssue(db, config, id);
      if (!issue) {
        return reply.status(404).send({ error: 'issue not found' });
      }

      const files = await service.getResultFiles(db, config, id);
      if (!files) {
        return reply.status(404).send({ error: 'result not found' });
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
        return reply.status(404).send({ error: 'issue not found' });
      }

      let buf: Buffer | null;
      try {
        buf = await service.getResultArchive(db, config, id);
      } catch {
        return reply.status(404).send({ error: 'result not found' });
      }
      if (!buf) {
        return reply.status(404).send({ error: 'result not found' });
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
        return reply.status(404).send({ error: 'issue not found' });
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
      if (!service.getIssue(db, config, id)) {
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
      if (!service.getIssue(db, config, id)) {
        return reply.status(404).send({ error: 'issue not found' });
      }

      return listByIssue(db, id);
    },
  );

  app.delete<{ Params: { id: string } }>(
    `${ROUTE_PATH}/:id`,
    async (request, reply) => {
      const { id } = request.params;
      if (!service.getIssue(db, config, id)) {
        return reply.status(404).send({ error: 'issue not found' });
      }

      // Удаление — фоновая операция: сразу отвечаем 202, а прогресс/финал
      // уходят в SSE (`issue_deleting` → `issue_deleted`).
      void service.deleteIssue(db, config, id);
      return reply.code(202).send({ ok: true });
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

      const issue = service.getIssue(db, config, id);
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
          bootstrap_enabled: repository.bootstrap_enabled ?? true,
        }));

      // Если в запросе присутствует pr_repository_ids — обновляем create_mr
      // флаги в таблице репозиториев задачи ДО чтения. Так шаг pr видит
      // актуальный per-repo выбор из UI итерации. Пустой массив — тоже
      // авторитетен (снимаем все галочки), иначе снятие выбора не долетало бы
      // до БД и `pr` возвращался бы в шаги из старых флагов.
      if (body.pr_repository_ids !== undefined) {
        const prIdSet = new Set(body.pr_repository_ids);
        // Сбрасываем create_mr у всех репозиториев этой задачи.
        db.update(issueRepositories)
          .set({ create_mr: false, updated_at: new Date().toISOString() })
          .where(eq(issueRepositories.issue_id, id))
          .run();
        // Включаем create_mr только у выбранных.
        for (const repoId of prIdSet) {
          db.update(issueRepositories)
            .set({ create_mr: true, updated_at: new Date().toISOString() })
            .where(
              and(
                eq(issueRepositories.issue_id, id),
                eq(issueRepositories.id, repoId),
              ),
            )
            .run();
        }
        // Перечитываем репозитории после обновления create_mr.
        repositories.length = 0;
        const updated = db
          .select()
          .from(issueRepositories)
          .where(eq(issueRepositories.issue_id, id))
          .all();
        for (const repo of updated) {
          repositories.push({
            repository_url: repo.repository_url,
            base_branch: repo.branch_name,
            create_mr: !!repo.create_mr,
            bootstrap_enabled: repo.bootstrap_enabled ?? true,
          });
        }
      }

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
        steps: combineIterationSteps(
          body.steps ?? issue.pipeline_steps,
          createMr,
        ),
        model: body.model ?? null,
        step_models: body.step_models,
        thinking_level: body.thinking_level ?? null,
        step_thinking_levels: body.step_thinking_levels,
        worker_count: body.worker_count ?? undefined,
        status: 'pending',
        created_at: now,
        updated_at: now,
      };

      // Принцип: только одна активная + максимум одна запланированная итерация.
      // Проверяем ДО вставки новой итерации: иначе при отказе (409) только что
      // созданная строка оставалась бы в БД «фантомной» итерацией.
      const hasRunning = db
        .select({ id: iterations.id })
        .from(iterations)
        .where(
          and(
            eq(iterations.issue_id, id),
            eq(iterations.status, 'running'),
          ),
        )
        .get();

      if (hasRunning) {
        const hasPlanned = db
          .select({ id: iterations.id })
          .from(iterations)
          .where(
            and(
              eq(iterations.issue_id, id),
              eq(iterations.status, 'pending'),
            ),
          )
          .get();
        if (hasPlanned) {
          return reply.status(409).send({
            error: 'A pending iteration already exists — wait for it to start',
          });
        }
        const hasDraft = db
          .select({ id: iterations.id })
          .from(iterations)
          .where(
            and(
              eq(iterations.issue_id, id),
              eq(iterations.status, 'draft'),
            ),
          )
          .get();
        if (hasDraft) {
          return reply.status(409).send({
            error: 'A draft iteration already exists — edit or delete it first',
          });
        }
      }

      db.insert(iterations).values(iteration).run();

      await saveAttachments(
        db,
        deps,
        id,
        iterationId,
        iteration.number,
        requestPayload.files,
      );

      const prepareDeps = {
        container: deps.container,
        git: deps.git,
        sse: deps.sse,
        local: deps.local,
        ...(deps.bootstrapperFactory
          ? { bootstrapperFactory: deps.bootstrapperFactory }
          : {}),
        bootstrapperModel: body.bootstrapper_model,
        bootstrapperTimeoutMs: deps.bootstrapperTimeoutMs,
        workspaceRoot: deps.workspaceRoot,
      };
      if (hasRunning) {
        // Создаём черновик.
        db.update(iterations)
          .set({ status: 'draft', updated_at: now })
          .where(eq(iterations.id, iterationId))
          .run();

        return reply.status(201).send({ ...iteration, status: 'draft' });
      }

      // Нет активной итерации — создаём pending и запускаем.
      // Подготовка + конвейер — фоновый прогон.
      void (async () => {
        try {
          const ws = await prepareIssueWorkspace(db, prepareDeps, {
            issueId: id,
            iterationId,
            repositories,
          });
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
            repoWorkspaces: ws,
            model: body.model,
            step_models: body.step_models,
            thinking_level: body.thinking_level,
            step_thinking_levels: body.step_thinking_levels,
          }).catch((error) => console.error('run failed', error));
        } catch (error) {
          console.error('preparation failed, issue set to failed', error);
        }
      })();

      return reply.status(201).send(iteration);
    },
  );

  // POST /issues/validate-jira — живая проверка ссылки на Jira:
  // извлекает ключ из URL, дёргает Jira API и возвращает данные задачи.
  app.post(`${ROUTE_PATH}/validate-jira`, async (request, reply) => {
    const parsed = validateJiraUrlSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: formatZodError(parsed.error) });
    }

    const url = parsed.data.url.trim();
    const key = extractIssueKeyFromUrl(url);

    if (!key) {
      return { url, valid: false, error: 'Не удалось извлечь ключ задачи из URL' };
    }

    try {
      const issue = await jira.fetchIssue(key);
      return { url, valid: true, key, issue };
    } catch (err) {
      return {
        url,
        valid: false,
        key,
        error: `Jira недоступна: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  });

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
    // Данные Jira для сохранения в workspace (подтягиваются один раз).
    let jiraFull: JiraIssueFull | null = null;

    // Фаза 6: jira_issue_url без явного title — обогащаемся из Jira.
    // Любая ошибка Jira деградирует до title = ключ, запрос не падает.
    if (!explicitTitle && jiraIssueUrl) {
      const key = extractIssueKeyFromUrl(jiraIssueUrl);
      if (key) {
        try {
          const full = await jira.fetchIssueFull(key);
          jiraFull = full;
          title = full.issue.title || key;
          if (full.issue.summary) {
            additionalContext = additionalContext
              ? `${additionalContext}\n\n${full.issue.summary}`
              : full.issue.summary;
          }
        } catch {
          title = key;
        }
      }
    }

    // Даже если title задан явно, подтягиваем данные Jira для сохранения в workspace.
    if (!jiraFull && jiraIssueUrl) {
      const key = extractIssueKeyFromUrl(jiraIssueUrl);
      if (key) {
        try {
          jiraFull = await jira.fetchIssueFull(key);
        } catch {
          // Jira недоступна — задача создаётся без файла.
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
    // Репозитории адресуются либо ссылкой на сохранённый (`repo_id`, приоритет),
    // либо явным URL (старый формат). Нормализуем оба варианта в пару
    // (url, base_branch) до записи в БД.
    const repositories: ResolvedIssueRepository[] = [];
    for (const repository of body.repositories ?? []) {
      const repoId = 'repo_id' in repository ? repository.repo_id : undefined;
      let repositoryUrl = repository.repository_url;
      let baseBranch = repository.base_branch;
      if (repoId) {
        const saved = getRepository(db, repoId);
        if (!saved) {
          return reply.status(422).send({ error: 'Repository not found' });
        }
        repositoryUrl = saved.cloneUrl ?? saved.url;
        baseBranch = baseBranch ?? saved.defaultBranch ?? undefined;
      }
      if (!repositoryUrl) {
        return reply
          .status(400)
          .send({ error: 'repository_url обязателен, если не указан repo_id' });
      }
      if (!baseBranch) {
        return reply.status(422).send({
          error: `Repository ${repoId ?? repositoryUrl} не содержит default branch — укажите base_branch`,
        });
      }
      repositories.push({
        repository_url: repositoryUrl,
        base_branch: baseBranch,
        create_mr: repository.create_mr ?? false,
        bootstrap_enabled: repository.bootstrap_enabled ?? true,
      });
    }

    const runImmediately = body.run_immediately !== false;
    const createMr = repositories.some((repository) => repository.create_mr);
    const pipelineSteps = resolvePipelineSteps(body.pipeline_steps, createMr);
    const now = new Date().toISOString();
    const issueId = randomUUID();
    const iterationId = runImmediately ? randomUUID() : null;
    const issueStatus: TaskStatus = runImmediately ? 'pending' : 'draft';

    const repositoryRows = repositories.map((repository) => ({
      id: randomUUID(),
      repository_url: repository.repository_url,
      branch_name: repository.base_branch,
      create_mr: repository.create_mr,
      bootstrap_enabled: repository.bootstrap_enabled,
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
          tag_id: body.tag_id ?? null,
          status: issueStatus,
          created_at: now,
          updated_at: now,
        })
        .run();

      if (repositoryRows.length > 0) {
        tx.insert(issueRepositories)
          .values(
            repositoryRows.map((repository) => ({
              ...repository,
              issue_id: issueId,
            })),
          )
          .run();
      }

      if (runImmediately) {
        tx.insert(iterations)
          .values({
            id: iterationId!,
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
            worker_count: body.worker_count ?? undefined,
            status: 'pending',
            created_at: now,
            updated_at: now,
          })
          .run();
      }
    });

    // Файлы сохраняются всегда (и для черновика, и для immediate-запуска).
    await saveAttachments(db, deps, issueId, iterationId, 1, requestPayload.files);

    if (runImmediately) {
      const prepareDeps = {
        container: deps.container,
        git: deps.git,
        sse: deps.sse,
        local: deps.local,
        ...(deps.bootstrapperFactory
          ? { bootstrapperFactory: deps.bootstrapperFactory }
          : {}),
        bootstrapperModel: body.bootstrapper_model,
        bootstrapperTimeoutMs: deps.bootstrapperTimeoutMs,
        workspaceRoot: deps.workspaceRoot,
      };
      // Подготовка + конвейер — фоновый прогон. HTTP-ответ возвращается
      // немедленно; прогресс и статус идут через SSE.
      void (async () => {
        try {
          // Сохраняем данные Jira в workspace-папку задачи ДО подготовки
          // репозиториев — агенты видят их как файлы, к Jira API доступа нет.
          if (jiraFull) {
            const wsDir = workspaceHostDirFor(
              deps.workspaceRoot ?? DEFAULT_WORKSPACE_ROOT,
              issueId,
            );
            mkdirSync(join(wsDir, 'jira'), { recursive: true });

            // Полный JSON: issue.raw + comments + changelog.
            const fullRaw = {
              issue: jiraFull.issue.raw ?? jiraFull.issue,
              comments: jiraFull.comments,
              changelog: jiraFull.changelog,
            };
            writeFileSync(
              join(wsDir, 'jira', `${jiraFull.issue.key}.json`),
              JSON.stringify(fullRaw, null, 2),
              'utf8',
            );

            // Расширенный .md: заголовок, статус, описание, комментарии, история.
            const issue = jiraFull.issue;
            const md = buildJiraMarkdown(jiraFull);
            writeFileSync(
              join(wsDir, 'jira', `${issue.key}.md`),
              md,
              'utf8',
            );
          }

          const ws = await prepareIssueWorkspace(db, prepareDeps, {
            issueId,
            iterationId: iterationId!,
            repositories,
          });
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
              id: iterationId!,
              issueId,
              number: 1,
              context: additionalContext,
              steps: pipelineSteps,
              reviewContext,
              isReviewNeed,
            },
            repositories,
            repoWorkspaces: ws,
            model: body.model,
            step_models: body.step_models,
            thinking_level: body.thinking_level,
            step_thinking_levels: body.step_thinking_levels,
          }).catch((error) => console.error('run failed', error));
        } catch (error) {
          console.error('preparation failed, issue set to failed', error);
        }
      })();
    }

    return reply.status(201).send({
      id: issueId,
      title,
      description,
      desired_result: desiredResult,
      jira_issue_url: jiraIssueUrl,
      source: jiraIssueUrl ? 'jira' : null,
      repositories: repositoryRows,
      pipeline_steps: pipelineSteps,
      step_models: body.step_models,
      thinking_level: body.thinking_level ?? null,
      step_thinking_levels: body.step_thinking_levels,
      status: issueStatus,
      created_at: now,
      updated_at: now,
    });
  });

  // POST /issues/:id/start — запуск сохранённого черновика.
  app.post<{ Params: { id: string } }>(
    `${ROUTE_PATH}/:id/start`,
    async (request, reply) => {
      const { id } = request.params;

      const issue = service.getIssue(db, config, id);
      if (!issue) {
        return reply.status(404).send({ error: 'issue not found' });
      }
      if (issue.status !== 'draft') {
        return reply
          .status(409)
          .send({ error: 'only draft issues can be started' });
      }

      // Проверяем, что итераций нет (черновик не запускался).
      const existingIteration = db
        .select({ id: iterations.id })
        .from(iterations)
        .where(eq(iterations.issue_id, id))
        .get();
      if (existingIteration) {
        return reply
          .status(409)
          .send({ error: 'issue already has iterations — not a draft' });
      }

      const repositories = db
        .select()
        .from(issueRepositories)
        .where(eq(issueRepositories.issue_id, id))
        .all()
        .map((repository) => ({
          repository_url: repository.repository_url,
          base_branch: repository.branch_name,
          create_mr: !!repository.create_mr,
          bootstrap_enabled: repository.bootstrap_enabled ?? true,
        }));

      const createMr = repositories.some(
        (repository) => repository.create_mr,
      );
      const pipelineSteps = resolvePipelineSteps(
        issue.pipeline_steps,
        createMr,
      );
      const now = new Date().toISOString();
      const iterationId = randomUUID();

      db.transaction((tx) => {
        tx.update(issues)
          .set({ status: 'pending', updated_at: now })
          .where(eq(issues.id, id))
          .run();

        tx.insert(iterations)
          .values({
            id: iterationId,
            issue_id: id,
            number: 1,
            context: issue.description ?? '',
            review_context: '',
            is_review_need: false,
            steps: pipelineSteps,
            model: null,
            step_models: issue.step_models ?? null,
            thinking_level: issue.thinking_level ?? null,
            step_thinking_levels: issue.step_thinking_levels ?? null,
            status: 'pending',
            created_at: now,
            updated_at: now,
          })
          .run();
      });

      const prepareDeps = {
        container: deps.container,
        git: deps.git,
        sse: deps.sse,
        local: deps.local,
        ...(deps.bootstrapperFactory
          ? { bootstrapperFactory: deps.bootstrapperFactory }
          : {}),
        bootstrapperModel: undefined,
        bootstrapperTimeoutMs: deps.bootstrapperTimeoutMs,
        workspaceRoot: deps.workspaceRoot,
      };

      void (async () => {
        try {
          const ws = await prepareIssueWorkspace(db, prepareDeps, {
            issueId: id,
            iterationId,
            repositories,
          });
          void runIssueIteration(db, deps, {
            issue: {
              id,
              title: issue.title,
              pipelineSteps,
              description: issue.description ?? '',
              desiredResult: issue.desired_result ?? 'md',
              jiraIssueUrl: issue.jira_issue_url,
            },
            iteration: {
              id: iterationId,
              issueId: id,
              number: 1,
              context: issue.description ?? '',
              steps: pipelineSteps,
              reviewContext: '',
              isReviewNeed: false,
            },
            repositories,
            repoWorkspaces: ws,
            model: undefined,
            step_models: issue.step_models ?? undefined,
            thinking_level: issue.thinking_level ?? undefined,
            step_thinking_levels: issue.step_thinking_levels ?? undefined,
          }).catch((error) => console.error('run failed', error));
        } catch (error) {
          console.error('preparation failed, issue set to failed', error);
          db.update(issues)
            .set({ status: 'failed', updated_at: new Date().toISOString() })
            .where(eq(issues.id, id))
            .run();
        }
      })();

      return { ok: true, iterationId };
    },
  );
}