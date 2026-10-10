import { mkdir, rm } from 'node:fs/promises';
import type {
  ContainerSpec,
  SpawnContainerResult,
} from '@issue-resolver/shared';
import type { ContainerController } from './controller';

/**
 * Локальный «контроллер контейнеров» без Docker: рабочая папка задачи — это
 * host-директория, а pi запускается прямо в ней (transport 'local').
 *
 * Позволяет прогонять конвейер там, где нет docker CLI/socket (dev-контейнер),
 * сохраняя тот же порт `ContainerController`.
 */
export class LocalContainerController implements ContainerController {
  private readonly workspaces = new Map<string, string>();

  async spawn(spec: ContainerSpec): Promise<SpawnContainerResult> {
    await mkdir(spec.workspaceHostPath, { recursive: true });
    this.workspaces.set(spec.containerName, spec.workspaceHostPath);
    return {
      containerId: `local-${spec.containerName}`,
      containerName: spec.containerName,
      workspacePath: spec.workspaceHostPath,
    };
  }

  async remove(containerName: string): Promise<void> {
    const workspacePath = this.workspaces.get(containerName);
    this.workspaces.delete(containerName);
    if (workspacePath) {
      await rm(workspacePath, { recursive: true, force: true });
    }
  }
}