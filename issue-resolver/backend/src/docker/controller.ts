import type Dockerode from 'dockerode';
import type { ContainerSpec, SpawnContainerResult } from '@issue-resolver/shared';

/**
 * Управление контейнерами прогона. Реализации: in-memory fake для юнит-тестов
 * и тонкая обёртка над dockerode (клиент инъецируется снаружи — DI).
 */
export interface ContainerController {
  spawn(spec: ContainerSpec): Promise<SpawnContainerResult>;
  remove(containerName: string): Promise<void>;
}

/**
 * In-memory-реализация для тестов: контейнеры живут в Map, реальный Docker
 * не трогается. `failNextWith` (см. ниже) позволяет проверить путь ошибки.
 */
export class FakeContainerController implements ContainerController {
  private readonly containers = new Map<string, string>();
  private pendingError: Error | null = null;

  /** Следующая операция (spawn/remove) отклонится этой ошибкой. */
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
    // Map.delete идемпотентен: повторный remove не падает.
    this.containers.delete(containerName);
  }

  private throwIfPending(): void {
    if (this.pendingError) {
      const err = this.pendingError;
      this.pendingError = null;
      throw err;
    }
  }
}

/**
 * Реальная обёртка над `dockerode`. Клиент передаётся снаружи (DI), чтобы
 * фабрика подставила сокет, а юнит-тесты — фейк. Реальные вызовы в юнит-тестах
 * не выполняются — это интеграционный путь.
 *
 * TODO(§5): проброс stdout/stderr контейнера (attach) в SSE-шину прогона.
 */
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
}