import { readFile } from 'node:fs/promises';
import type { FastifyReply } from 'fastify';
import { eq } from 'drizzle-orm';
import type { Db } from '../db/client';
import { iterations } from '../db/schema';

export const notFound = (reply: FastifyReply, error: string) =>
  reply.status(404).send({ error });

export const badRequest = (reply: FastifyReply, error: string) =>
  reply.status(400).send({ error });

export const conflict = (reply: FastifyReply, error: string) =>
  reply.status(409).send({ error });

export const unprocessable = (reply: FastifyReply, error: string) =>
  reply.status(422).send({ error });

export function draftOnlyConflict(
  reply: FastifyReply,
  db: Db,
  issueId: string,
): FastifyReply | null {
  const existing = db
    .select({ id: iterations.id })
    .from(iterations)
    .where(eq(iterations.issue_id, issueId))
    .get();
  return existing ? conflict(reply, 'issue already has iterations — not a draft') : null;
}

export async function sendFileOr404(
  reply: FastifyReply,
  path: string,
  options: { type: string; disposition: string },
): Promise<FastifyReply> {
  let body: Buffer;
  try {
    body = await readFile(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return notFound(reply, 'file not found');
    }
    throw error;
  }
  return reply
    .type(options.type)
    .header('Content-Disposition', options.disposition)
    .send(body);
}

export function getIterationRow(db: Db, id: string) {
  return db.select().from(iterations).where(eq(iterations.id, id)).get() ?? null;
}