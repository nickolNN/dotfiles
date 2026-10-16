import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import Fastify from 'fastify';
import type {
  FastifyError,
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
} from 'fastify';
import { FakeContainerController } from './docker/controller';
import { FakeGitService } from './git/service';
import { FakePiRunner } from './pi/runner';
import { FakeMrClient } from './pr/mr';
import { InMemorySseHub } from './sse/hub';
import { FakeJiraClient, type JiraClient } from './jira/client';
import { InMemoryStepSessionRegistry } from './pi/session-registry';
import { controlRoutes } from './routes/control';
import { healthRoutes } from './routes/health';
import { issuesRoutes } from './routes/issues';
import { iterationsRoutes } from './routes/iterations';
import { modelsRoutes } from './routes/models';
import { adminRoutes } from './routes/admin';
import { reposRoutes } from './routes/repos';
import { settingsRoutes } from './routes/settings';
import { tagsRoutes } from './routes/tags';
import { streamRoutes } from './routes/stream';
import { DEFAULT_WORKSPACE_ROOT } from './workspace/paths';
import type { ReposValidator } from './repo-resolver/validate';
import type { RepoResolverFactory } from './repo-resolver/resolver';
import type { Db } from './db/client';
import type { IterationRunDeps } from './workflow/run-iteration.service';

declare module 'fastify' {
  interface FastifyInstance {
    iterationRunDeps: IterationRunDeps;
  }
}

const MIN_HTTP_STATUS = 400;
const MAX_HTTP_STATUS = 599;

/** Лимиты multipart-загрузок: до 10 файлов по 25 МБ. */
const MAX_UPLOAD_FILE_SIZE = 25 * 1024 * 1024;
const MAX_UPLOAD_FILES = 10;

function resolveStatusCode(error: FastifyError): number {
  const { statusCode } = error;
  if (
    typeof statusCode === 'number' &&
    statusCode >= MIN_HTTP_STATUS &&
    statusCode <= MAX_HTTP_STATUS
  ) {
    return statusCode;
  }
  return 500;
}

/**
 * Безопасные дефолты: фейковые адаптеры, никаких реальных docker/git/pi и не
 * разделяемая шина. Продовый wiring подставляет настоящие реализации через deps.
 */
function defaultRunDeps(): IterationRunDeps {
  return {
    container: new FakeContainerController(),
    git: new FakeGitService(),
    pi: new FakePiRunner(),
    sse: new InMemorySseHub(),
    mr: new FakeMrClient(),
    control: new InMemoryStepSessionRegistry(),
    local: false,
    workspaceRoot: DEFAULT_WORKSPACE_ROOT,
  };
}

export interface AppDeps extends Partial<IterationRunDeps> {
  /** Jira-клиент для обогащения задачи (Фаза 6); по умолчанию — фейк. */
  jira?: JiraClient;
  /** Валидатор репозиториев для POST /repos/validate; по умолчанию — сеть. */
  repos?: ReposValidator;
  /** Фабрика резолверов для CRUD /repositories; по умолчанию — сеть. */
  repoResolverFactory?: RepoResolverFactory;
}

export function buildApp(
  db: Db,
  deps: AppDeps = {},
): FastifyInstance {
  const { jira = new FakeJiraClient(), repos, repoResolverFactory, ...runOverrides } = deps;
  const runDeps: IterationRunDeps = { ...defaultRunDeps(), ...runOverrides };
  const app = Fastify({ logger: false });

  // Доступ к deps для роутов и тестов (заодно виден из Fastify-инстанса).
  app.decorate('iterationRunDeps', runDeps);

  app.register(cors, { origin: true });

  app.register(multipart, {
    limits: { fileSize: MAX_UPLOAD_FILE_SIZE, files: MAX_UPLOAD_FILES },
  });

  app.setErrorHandler(
    (error: FastifyError, request: FastifyRequest, reply: FastifyReply) => {
      const statusCode = resolveStatusCode(error);

      console.error(
        `[error] ${request.method} ${request.url} → ${statusCode}: ${error.message}`,
      );

      return reply.status(statusCode).send({
        error: statusCode >= 500 ? 'Internal Server Error' : error.message,
      });
    },
  );

  app.register(healthRoutes);

  app.register(modelsRoutes);

  app.register(async (instance) => {
    await issuesRoutes(instance, db, runDeps, jira);
    await reposRoutes(instance, db, {
      validate: repos,
      resolverFactory: repoResolverFactory,
    });
    await tagsRoutes(instance, db);
    await settingsRoutes(instance, db);
    await adminRoutes(instance, db, runDeps.workspaceRoot);
    await iterationsRoutes(instance, db, runDeps);
    await controlRoutes(instance, runDeps.control);
    await streamRoutes(instance, db, runDeps.sse, runDeps.control, runDeps.container);
  });

  return app;
}