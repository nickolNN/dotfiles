import type { FastifyInstance } from 'fastify';
import type { Db } from '../db/client';
import { getSetting, setSetting } from '../db/settings.repo';
import { formatZodError, updateHostnameRequestSchema } from '../validation';

const API_PATH = '/issue-resolver/api/v1';
const HOSTNAME_KEY = 'hostname';
const HOSTNAME_PATH = `${API_PATH}/settings/hostname`;

export async function settingsRoutes(
  app: FastifyInstance,
  db: Db,
): Promise<void> {
  app.get(HOSTNAME_PATH, async () => ({
    hostname: getSetting(db, HOSTNAME_KEY) ?? '',
  }));

  app.put(HOSTNAME_PATH, async (request, reply) => {
    const parsed = updateHostnameRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: formatZodError(parsed.error) });
    }
    setSetting(db, HOSTNAME_KEY, parsed.data.hostname);
    return { hostname: parsed.data.hostname };
  });
}