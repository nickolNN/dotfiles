import type { FastifyInstance } from 'fastify';

import type { ModelDescriptor } from '@issue-resolver/shared';

import { createModelsProbe } from '../pi/models-probe';
import { modelSourceFromEnv } from '../models/source';

const ROUTE_PATH = '/issue-resolver/api/v1/models';

/**
 * Live list from Pi first, static `models.json` second. The static file is a
 * guess about the config path; the probe is what the agent will actually run on.
 * `PI_MODELS_PROBE=off` keeps the endpoint file-only (cheap, deterministic).
 */
export async function modelsRoutes(app: FastifyInstance): Promise<void> {
  const probe = createModelsProbe();

  app.get(ROUTE_PATH, async (): Promise<ModelDescriptor[]> => {
    if (process.env.PI_MODELS_PROBE?.toLowerCase() !== 'off') {
      const probed = await probe.list();
      if (probed.length > 0) return probed;
    }
    return modelSourceFromEnv().list();
  });
}
