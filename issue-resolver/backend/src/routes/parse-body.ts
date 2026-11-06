import type { FastifyReply } from 'fastify';
import type { z } from 'zod';
import { formatZodError } from '../validation';

export type ParsedBody<T> =
  | { ok: true; data: T }
  | { ok: false; reply: FastifyReply };

export function parseBody<S extends z.ZodTypeAny>(
  reply: FastifyReply,
  schema: S,
  body: unknown,
): ParsedBody<z.infer<S>> {
  const parsed = schema.safeParse(body);
  if (parsed.success) return { ok: true, data: parsed.data };
  return {
    ok: false,
    reply: reply.status(400).send({ error: formatZodError(parsed.error) }),
  };
}
