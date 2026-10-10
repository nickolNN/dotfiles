import type { FastifyInstance } from 'fastify';
import { modelSourceFromEnv } from '../models/source';

const ROUTE_PATH = '/issue-resolver/api/v1/models';

export async function modelsRoutes(app: FastifyInstance): Promise<void> {
  app.get(ROUTE_PATH, async () => modelSourceFromEnv().list());
}