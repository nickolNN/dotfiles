import type { Db } from '../../db/client';
import type { ContainerController } from '../../docker/controller';
import type { StepSessionRegistry } from '../../pi/session-registry';
import type { SseHub } from '../../sse/hub';

export const ISSUES_PATH = '/issue-resolver/api/v1/issues';
export const ITERATIONS_PATH = '/issue-resolver/api/v1/iterations';
export const GLOBAL_STREAM_PATH = '/issue-resolver/api/v1/stream';
export const GLOBAL_CONTAINER_STATS_PATH =
  '/issue-resolver/api/v1/container-stats-stream';

export interface StreamDeps {
  db: Db;
  hub: SseHub;
  control: StepSessionRegistry;
  container: ContainerController;
}