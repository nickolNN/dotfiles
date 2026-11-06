import type { CreateTagRequest, UpdateTagRequest } from '@issue-resolver/shared';
import type { FastifyInstance } from 'fastify';
import type { Db } from '../db/client';
import {
  deleteTag,
  getTag,
  insertTag,
  listTags,
  updateTag,
} from '../db/tags.repo';
import {
  createTagRequestSchema,
  updateTagRequestSchema,
} from '../validation';
import { parseBody } from './parse-body';
import { notFound } from './params';

const API_PATH = '/issue-resolver/api/v1';
const TAGS_PATH = `${API_PATH}/tags`;

export async function tagsRoutes(
  app: FastifyInstance,
  db: Db,
): Promise<void> {
  app.get(TAGS_PATH, async () => listTags(db));

  app.post(TAGS_PATH, async (request, reply) => {
    const parsed = parseBody(reply, createTagRequestSchema, request.body);
    if (!parsed.ok) return parsed.reply;
    const input: CreateTagRequest = parsed.data;
    return reply.status(201).send(insertTag(db, input));
  });

  app.get<{ Params: { id: string } }>(
    `${TAGS_PATH}/:id`,
    async (request, reply) => {
      const tag = getTag(db, request.params.id);
      if (!tag) {
        return notFound(reply, 'tag not found');
      }
      return tag;
    },
  );

  app.put<{ Params: { id: string } }>(
    `${TAGS_PATH}/:id`,
    async (request, reply) => {
      const parsed = parseBody(reply, updateTagRequestSchema, request.body);
      if (!parsed.ok) return parsed.reply;
      const input: UpdateTagRequest = parsed.data;
      const updated = updateTag(db, request.params.id, input);
      if (!updated) {
        return notFound(reply, 'tag not found');
      }
      return updated;
    },
  );

  app.delete<{ Params: { id: string } }>(
    `${TAGS_PATH}/:id`,
    async (request, reply) => {
      if (!deleteTag(db, request.params.id)) {
        return notFound(reply, 'tag not found');
      }
      return reply.code(204).send();
    },
  );
}