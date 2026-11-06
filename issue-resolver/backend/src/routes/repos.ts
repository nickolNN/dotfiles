import { isKnownRepoPlatform } from '@issue-resolver/shared';
import type { RepoBranchesResponse, RepoPlatform, RepoValidationResult, SavedRepo } from '@issue-resolver/shared';
import type { FastifyInstance } from 'fastify';
import type { Db } from '../db/client';
import {
  deleteRepository,
  getRepository,
  insertRepository,
  listRepositories,
  updateRepository,
  updateRepositoryTestCredentials,
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
  repoCredentialsSchema,
  validateReposRequestSchema,
} from '../validation';
import { parseBody } from './parse-body';
import { RepoConnectionStatus } from '@issue-resolver/shared';
import { notFound } from './params';
import { nowIso } from '../db/rows';

const API_PATH = '/issue-resolver/api/v1';
const REPOSITORIES_PATH = `${API_PATH}/repositories`;

export interface ReposRoutesDeps {
  validate?: ReposValidator;
  resolverFactory?: RepoResolverFactory;
  env?: NodeJS.ProcessEnv;
}

function writeFromResult(
  url: string,
  result: RepoValidationResult,
): RepositoryWrite {
  const platform: RepoPlatform | null = isKnownRepoPlatform(result.platform)
    ? result.platform
    : null;

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
      connectionStatus: RepoConnectionStatus.error,
      lastValidatedAt: nowIso(),
      writeAccess: false,
    };
  }

  const info = result.info;
  return {
    url,
    platform: info.platform,
    fullName: info.fullName,
    defaultBranch: info.defaultBranch || null,
    cloneUrl: info.cloneUrl,
    language: info.language,
    description: info.description,
    isPrivate: info.isPrivate,
    connectionStatus: RepoConnectionStatus.ok,
    lastValidatedAt: nowIso(),
    writeAccess: info.writeAccess ?? false,
  };
}

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
    const parsed = parseBody(reply, validateReposRequestSchema, request.body);
    if (!parsed.ok) return parsed.reply;
    const results = await validate(parsed.data.urls);
    return { results };
  });

  app.get(REPOSITORIES_PATH, async () => listRepositories(db));

  app.post(REPOSITORIES_PATH, async (request, reply) => {
    const parsed = parseBody(reply, createRepoRequestSchema, request.body);
    if (!parsed.ok) return parsed.reply;
    const url = parsed.data.url.trim();
    const result = await resolveOne(url);
    const saved: SavedRepo = insertRepository(db, writeFromResult(url, result));
    if (saved.connectionStatus !== RepoConnectionStatus.ok) {
      return reply
        .status(422)
        .send({ error: result.error ?? 'repository not accessible', repository: saved });
    }
    return reply.status(201).send(saved);
  });

  app.put<{ Params: { id: string } }>(
    `${REPOSITORIES_PATH}/:id`,
    async (request, reply) => {
      const parsed = parseBody(reply, createRepoRequestSchema, request.body);
      if (!parsed.ok) return parsed.reply;
      const { id } = request.params;
      if (!getRepository(db, id)) {
        return notFound(reply, 'repository not found');
      }
      const url = parsed.data.url.trim();
      const result = await resolveOne(url);
      const saved = updateRepository(db, id, writeFromResult(url, result));
      if (!saved) {
        return notFound(reply, 'repository not found');
      }
      if (saved.connectionStatus !== RepoConnectionStatus.ok) {
        return reply
          .status(422)
          .send({ error: result.error ?? 'repository not accessible', repository: saved });
      }
      return saved;
    },
  );

  app.put<{ Params: { id: string } }>(
    `${REPOSITORIES_PATH}/:id/credentials`,
    async (request, reply) => {
      const parsed = parseBody(reply, repoCredentialsSchema, request.body);
      if (!parsed.ok) return parsed.reply;
      const raw = parsed.data.testCredentials?.trim() ?? '';
      const saved = updateRepositoryTestCredentials(
        db,
        request.params.id,
        raw === '' ? null : raw,
      );
      if (!saved) {
        return notFound(reply, 'repository not found');
      }
      return saved;
    },
  );

  app.delete<{ Params: { id: string } }>(
    `${REPOSITORIES_PATH}/:id`,
    async (request, reply) => {
      if (!deleteRepository(db, request.params.id)) {
        return notFound(reply, 'repository not found');
      }
      return reply.code(204).send();
    },
  );

  app.post<{ Params: { id: string } }>(
    `${REPOSITORIES_PATH}/:id/validate`,
    async (request, reply) => {
      const existing = getRepository(db, request.params.id);
      if (!existing) {
        return notFound(reply, 'repository not found');
      }
      const result = await resolveOne(existing.url);
      const saved = updateRepository(
        db,
        existing.id,
        writeFromResult(existing.url, result),
      );
      if (!saved) {
        return notFound(reply, 'repository not found');
      }
      return reply.status(200).send(saved);
    },
  );

  app.get<{ Params: { id: string } }>(
    `${REPOSITORIES_PATH}/:id/branches`,
    async (request, reply) => {
      const existing = getRepository(db, request.params.id);
      if (!existing) {
        return notFound(reply, 'repository not found');
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