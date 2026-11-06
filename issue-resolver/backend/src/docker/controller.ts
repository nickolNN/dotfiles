import { PassThrough } from 'node:stream';
import type Dockerode from 'dockerode';
import type {
  ContainerSpec,
  ContainerStats,
  ContainerStatsPayload,
  SpawnContainerResult,
} from '@issue-resolver/shared';
import { num } from '@issue-resolver/shared';
import { workspaceContainerDirFor } from '../workspace/paths';
import { asRecord } from '../util/records';
import { PendingFailure } from '../util/pending-failure';

export interface ContainerController {
  spawn(spec: ContainerSpec): Promise<SpawnContainerResult>;
  remove(containerName: string): Promise<void>;
  stats(containerName: string): Promise<ContainerStats>;
  statsStream(containerName: string): Promise<NodeJS.ReadableStream>;
}

export function toContainerStatsPayload(data: unknown): ContainerStatsPayload {
  const stats = asRecord(data);
  const cpuStats = asRecord(stats?.cpu_stats);
  const cpuUsage = asRecord(cpuStats?.cpu_usage);
  const precpuStats = asRecord(stats?.precpu_stats);
  const precpuUsage = asRecord(precpuStats?.cpu_usage);
  const memory = asRecord(stats?.memory_stats);
  const pids = asRecord(stats?.pids_stats);
  const cpuDelta =
    num(cpuUsage?.total_usage) - num(precpuUsage?.total_usage);
  const systemDelta =
    num(cpuStats?.system_cpu_usage) - num(precpuStats?.system_cpu_usage);
  const numCpus = num(cpuStats?.online_cpus) || 1;
  const cpuPercent =
    systemDelta > 0 ? (cpuDelta / systemDelta) * numCpus * 100 : null;
  return {
    cpuPercent:
      cpuPercent !== null ? Math.round(cpuPercent * 100) / 100 : null,
    memoryUsageBytes: num(memory?.usage),
    memoryLimitBytes: num(memory?.limit),
    pids: num(pids?.current),
  };
}

export class FakeContainerController
  extends PendingFailure
  implements ContainerController
{
  private readonly containers = new Map<string, string>();

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
}

export class DockerodeContainerController implements ContainerController {
  constructor(private readonly docker: Dockerode) {}

  async spawn(spec: ContainerSpec): Promise<SpawnContainerResult> {
    const workspacePath = workspaceContainerDirFor(spec.issueId);
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