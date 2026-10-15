import type {
  RepoBranchesResponse,
  RepoPlatform,
  RepoValidationResult,
  SavedRepo,
} from '@issue-resolver/shared';
import type { FastifyInstance } from 'fastify';
import type { Db } from '../db/client';
import {
  deleteRepository,
  getRepository,
  insertRepository,
  listRepositories,
  updateRepository,
  type RepositoryWrite,
} from '../db/repositories.repo';
import type { RepoResolverFactory } from '../repo-resolver/resolver';
import {
  createReposValidator,
  validateRepos,
  type ReposValidator,
} from '../repo-resolver/validate';
import {
  createRepoRequestSchema,
  formatZodError,
  validateReposRequestSchema,
} from '../validation';

const API_PATH = '/issue-resolver/api/v1';
const REPOSITORIES_PATH = `${API_PATH}/repositories`;

export interface ReposRoutesDeps {
  /** Валидатор батча URL для POST /repos/validate; по умолчанию — сеть. */
  validate?: ReposValidator;
  /** Фабрика резолверов для CRUD; по умолчанию — сетевые резолверы. */
  resolverFactory?: RepoResolverFactory;
  /** Окружение для резолверов (токены платформ); по умолчанию process.env. */
  env?: NodeJS.ProcessEnv;
}

/**
 * Результат валидации → записываемые поля. Успех — метаданные + status 'ok';
 * ошибка — метаданные обнуляются, status 'error' (URL сохраняется, чтобы
 * пользователь видел проблемный репозиторий и мог перевалидировать).
 */
function writeFromResult(
  url: string,
  result: RepoValidationResult,
): RepositoryWrite {
  const platform: RepoPlatform | null =
    result.platform === 'unknown' ? null : result.platform;

  if (!result.valid || !result.info) {
    return {
      url,
      platform,
      fullName: null,
      defaultBranch: null,
      cloneUrl: null,
      language: null,
      description: null,
      isPrivate: null,
      connectionStatus: 'error',
      lastValidatedAt: new Date().toISOString(),
      writeAccess: false,
    };
  }

  const info = result.info;
  return {
    url,
    platform: info.platform,
    fullName: info.fullName,
    defaultBranch: info.defaultBranch,
    cloneUrl: info.cloneUrl,
    language: info.language,
    description: info.description,
    isPrivate: info.isPrivate,
    connectionStatus: 'ok',
    lastValidatedAt: new Date().toISOString(),
    writeAccess: info.writeAccess ?? false,
  };
}

/**
 * Роуты репозиториев: батч-валидация (`/repos/validate`) и CRUD сохранённых
 * репозиториев (`/repositories`). Валидация идёт через существующие резолверы
 * (`validateRepos` → `createRepoResolver`), без дублирования сетевой логики.
 */
export async function reposRoutes(
  app: FastifyInstance,
  db: Db,
  deps: ReposRoutesDeps = {},
): Promise<void> {
  const validate = deps.validate ?? createReposValidator(process.env);
  const env = deps.env ?? process.env;
  const factory = deps.resolverFactory;

  const resolveOne = async (url: string): Promise<RepoValidationResult> => {
    const [result] = await validateRepos([url], env, factory);
    return result;
  };

  app.post(`${API_PATH}/repos/validate`, async (request, reply) => {
    const parsed = validateReposRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: formatZodError(parsed.error) });
    }
    const results = await validate(parsed.data.urls);
    return { results };
  });

  // GET /repositories — список всех сохранённых.
  app.get(REPOSITORIES_PATH, async () => listRepositories(db));

  // POST /repositories — создать: валидировать URL и сохранить результат.
  app.post(REPOSITORIES_PATH, async (request, reply) => {
    const parsed = createRepoRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: formatZodError(parsed.error) });
    }
    const url = parsed.data.url.trim();
    const result = await resolveOne(url);
    const saved: SavedRepo = insertRepository(db, writeFromResult(url, result));
    if (saved.connectionStatus !== 'ok') {
      return reply
        .status(422)
        .send({ error: result.error ?? 'repository not accessible', repository: saved });
    }
    return reply.status(201).send(saved);
  });

  // PUT /repositories/:id — заменить URL и перевалидировать.
  app.put<{ Params: { id: string } }>(
    `${REPOSITORIES_PATH}/:id`,
    async (request, reply) => {
      const parsed = createRepoRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: formatZodError(parsed.error) });
      }
      const { id } = request.params;
      if (!getRepository(db, id)) {
        return reply.status(404).send({ error: 'repository not found' });
      }
      const url = parsed.data.url.trim();
      const result = await resolveOne(url);
      const saved = updateRepository(db, id, writeFromResult(url, result));
      if (!saved) {
        return reply.status(404).send({ error: 'repository not found' });
      }
      if (saved.connectionStatus !== 'ok') {
        return reply
          .status(422)
          .send({ error: result.error ?? 'repository not accessible', repository: saved });
      }
      return saved;
    },
  );

  // DELETE /repositories/:id — удалить.
  app.delete<{ Params: { id: string } }>(
    `${REPOSITORIES_PATH}/:id`,
    async (request, reply) => {
      if (!deleteRepository(db, request.params.id)) {
        return reply.status(404).send({ error: 'repository not found' });
      }
      return reply.code(204).send();
    },
  );

  // POST /repositories/:id/validate — перепроверить соединение (live).
  app.post<{ Params: { id: string } }>(
    `${REPOSITORIES_PATH}/:id/validate`,
    async (request, reply) => {
      const existing = getRepository(db, request.params.id);
      if (!existing) {
        return reply.status(404).send({ error: 'repository not found' });
      }
      const result = await resolveOne(existing.url);
      const saved = updateRepository(
        db,
        existing.id,
        writeFromResult(existing.url, result),
      );
      if (!saved) {
        return reply.status(404).send({ error: 'repository not found' });
      }
      // Статус соединения — в теле ответа; 200 и при 'error', чтобы UI мог
      // отрисовать сохранённую сущность с пометкой проблемы.
      return reply.status(200).send(saved);
    },
  );

  // GET /repositories/:id/branches — ветки live через резолвер (не из кеша).
  app.get<{ Params: { id: string } }>(
    `${REPOSITORIES_PATH}/:id/branches`,
    async (request, reply) => {
      const existing = getRepository(db, request.params.id);
      if (!existing) {
        return reply.status(404).send({ error: 'repository not found' });
      }
      const result = await resolveOne(existing.url);
      if (!result.valid || !result.info) {
        return reply
          .status(502)
          .send({ error: result.error ?? 'repository not accessible' });
      }
      const response: RepoBranchesResponse = { branches: result.info.branches };
      return response;
    },
  );
}