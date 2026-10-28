import { PassThrough } from 'node:stream';
import type Dockerode from 'dockerode';
import type {
  ContainerSpec,
  ContainerStats,
  ContainerStatsPayload,
  SpawnContainerResult,
} from '@issue-resolver/shared';

export interface ContainerController {
  spawn(spec: ContainerSpec): Promise<SpawnContainerResult>;
  remove(containerName: string): Promise<void>;
  stats(containerName: string): Promise<ContainerStats>;
  statsStream(containerName: string): Promise<NodeJS.ReadableStream>;
}

export interface DockerStatsJson {
  cpu_stats?: {
    cpu_usage?: { total_usage?: number };
    system_cpu_usage?: number;
    online_cpus?: number;
  };
  precpu_stats?: {
    cpu_usage?: { total_usage?: number };
    system_cpu_usage?: number;
  };
  memory_stats?: { usage?: number; limit?: number };
  pids_stats?: { current?: number };
}

export function toContainerStatsPayload(
  data: DockerStatsJson,
): ContainerStatsPayload {
  const cpuDelta =
    (data.cpu_stats?.cpu_usage?.total_usage ?? 0) -
    (data.precpu_stats?.cpu_usage?.total_usage ?? 0);
  const systemDelta =
    (data.cpu_stats?.system_cpu_usage ?? 0) -
    (data.precpu_stats?.system_cpu_usage ?? 0);
  const numCpus = data.cpu_stats?.online_cpus ?? 1;
  const cpuPercent =
    systemDelta > 0 ? (cpuDelta / systemDelta) * numCpus * 100 : null;
  return {
    cpuPercent:
      cpuPercent !== null ? Math.round(cpuPercent * 100) / 100 : null,
    memoryUsageBytes: data.memory_stats?.usage ?? 0,
    memoryLimitBytes: data.memory_stats?.limit ?? 0,
    pids: data.pids_stats?.current ?? 0,
  };
}

export class FakeContainerController implements ContainerController {
  private readonly containers = new Map<string, string>();
  private pendingError: Error | null = null;

  failNextWith(err: Error): void {
    this.pendingError = err;
  }

  async spawn(spec: ContainerSpec): Promise<SpawnContainerResult> {
    this.throwIfPending();
    const containerId = `cid-${spec.containerName}`;
    this.containers.set(spec.containerName, containerId);
    return {
      containerId,
      containerName: spec.containerName,
      workspacePath: spec.workspaceHostPath,
    };
  }

  async remove(containerName: string): Promise<void> {
    this.throwIfPending();
    this.containers.delete(containerName);
  }

  async stats(containerName: string): Promise<ContainerStats> {
    this.throwIfPending();
    return {
      containerName,
      cpuPercent: 0,
      memoryUsageBytes: 0,
      memoryLimitBytes: 0,
      pids: 0,
    };
  }

  async statsStream(_containerName: string): Promise<NodeJS.ReadableStream> {
    this.throwIfPending();
    return new PassThrough();
  }

  private throwIfPending(): void {
    if (this.pendingError) {
      const err = this.pendingError;
      this.pendingError = null;
      throw err;
    }
  }
}

export class DockerodeContainerController implements ContainerController {
  constructor(private readonly docker: Dockerode) {}

  async spawn(spec: ContainerSpec): Promise<SpawnContainerResult> {
    const workspacePath = `/workspaces/${spec.issueId}`;
    const memoryVolumeName = spec.memoryVolumeName ?? 'agent-memory';
    const memoryMountPath =
      spec.memoryMountPath ?? '/home/agent/.pi/agent/memory';
    const container = await this.docker.createContainer({
      name: spec.containerName,
      Image: spec.image,
      HostConfig: {
        Binds: [
          `${spec.workspaceHostPath}:${workspacePath}`,
          `${memoryVolumeName}:${memoryMountPath}`,
        ],
      },
    });
    await container.start();
    return {
      containerId: container.id,
      containerName: spec.containerName,
      workspacePath,
    };
  }

  async remove(containerName: string): Promise<void> {
    await this.docker.getContainer(containerName).remove({ force: true });
  }

  async stats(containerName: string): Promise<ContainerStats> {
    const container = this.docker.getContainer(containerName);
    const data = await container.stats({ stream: false });
    return { containerName, ...toContainerStatsPayload(data) };
  }

  async statsStream(containerName: string): Promise<NodeJS.ReadableStream> {
    return this.docker.getContainer(containerName).stats({ stream: true });
  }
}