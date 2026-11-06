import type { FastifyInstance } from 'fastify';
import type { Db } from '../db/client';
import type { ContainerController } from '../docker/controller';
import type { StepSessionRegistry } from '../pi/session-registry';
import type { SseHub } from '../sse/hub';
import { registerChannels } from './stream/channels';
import { registerContainerStats } from './stream/container-stats';
import { registerIterationControls } from './stream/iteration-control';

export async function streamRoutes(
  app: FastifyInstance,
  db: Db,
  hub: SseHub,
  control: StepSessionRegistry,
  container: ContainerController,
): Promise<void> {
  const deps = { db, hub, control, container };
  registerChannels(app, deps);
  registerContainerStats(app, deps);
  registerIterationControls(app, deps);
}