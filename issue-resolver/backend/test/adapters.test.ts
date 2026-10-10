import { describe, expect, it } from 'vitest';
import Dockerode from 'dockerode';
import type { ContainerSpec } from '@issue-resolver/shared';
import {
  DockerodeContainerController,
  FakeContainerController,
} from '../src/docker/controller';
import { FakeGitService, GitCliService } from '../src/git/service';

const spec = (name: string): ContainerSpec => ({
  issueId: 'issue-1',
  containerName: name,
  image: 'issue-resolver-runner:latest',
  workspaceHostPath: '/tmp/workspaces/issue-1',
  repoUrls: ['https://example.com/a.git', 'https://example.com/b.git'],
});

describe('FakeContainerController', () => {
  it('spawn → возвращает containerId, containerName, workspacePath по spec', async () => {
    const controller = new FakeContainerController();

    const result = await controller.spawn(spec('ir-issue-1'));

    expect(result).toEqual({
      containerId: 'cid-ir-issue-1',
      containerName: 'ir-issue-1',
      workspacePath: '/tmp/workspaces/issue-1',
    });
  });

  it('remove удаляет контейнер, повторный remove не падает', async () => {
    const controller = new FakeContainerController();

    await controller.spawn(spec('ir-issue-1'));
    await expect(controller.remove('ir-issue-1')).resolves.toBeUndefined();
    await expect(controller.remove('ir-issue-1')).resolves.toBeUndefined();
  });

  it('failNextWith → spawn rejects', async () => {
    const controller = new FakeContainerController();
    const error = new Error('docker unavailable');
    controller.failNextWith(error);

    await expect(controller.spawn(spec('ir-issue-1'))).rejects.toThrow(
      'docker unavailable',
    );
  });
});

describe('FakeGitService', () => {
  it('prepare → repoWorkspaces по числу repoUrls, path содержит workspacePath, branch = baseBranches[i]', async () => {
    const service = new FakeGitService();

    const result = await service.prepare({
      repoUrls: ['https://example.com/a.git', 'https://example.com/b.git'],
      baseBranches: ['main', 'develop'],
      workspacePath: '/tmp/workspaces/issue-1',
    });

    expect(result.repoWorkspaces).toHaveLength(2);
    expect(result.repoWorkspaces[0]).toEqual({
      repoUrl: 'https://example.com/a.git',
      path: '/tmp/workspaces/issue-1/a',
      branch: 'main',
    });
    expect(result.repoWorkspaces[1]).toEqual({
      repoUrl: 'https://example.com/b.git',
      path: '/tmp/workspaces/issue-1/b',
      branch: 'develop',
    });
    for (const workspace of result.repoWorkspaces) {
      expect(workspace.path).toContain('/tmp/workspaces/issue-1');
    }
  });

  it('commitAndPush → { pushed: true, branchName }', async () => {
    const service = new FakeGitService();

    const result = await service.commitAndPush({
      repoPath: '/tmp/workspaces/issue-1/a',
      branchName: 'issue-resolver/issue-1',
      commitMessage: 'fix: issue-1',
    });

    expect(result).toEqual({ pushed: true, branchName: 'issue-resolver/issue-1' });
  });

  it('failNextWith → commitAndPush rejects', async () => {
    const service = new FakeGitService();
    const error = new Error('push rejected');
    service.failNextWith(error);

    await expect(
      service.commitAndPush({
        repoPath: '/tmp/workspaces/issue-1/a',
        branchName: 'issue-resolver/issue-1',
        commitMessage: 'fix: issue-1',
      }),
    ).rejects.toThrow('push rejected');
  });
});

describe('DockerodeContainerController — Binds (workspace + общая память)', () => {
  function captureDocker(): { configs: unknown[]; docker: Dockerode } {
    const configs: unknown[] = [];
    const docker = {
      createContainer: async (config: unknown) => {
        configs.push(config);
        return { id: 'cid-1', start: async () => undefined };
      },
    } as unknown as Dockerode;
    return { configs, docker };
  }

  const bindsOf = (config: unknown): string[] =>
    (config as { HostConfig: { Binds: string[] } }).HostConfig.Binds;

  it('memoryVolumeName задан → workspace-bind + memory-bind', async () => {
    const { configs, docker } = captureDocker();
    const controller = new DockerodeContainerController(docker);

    await controller.spawn({
      ...spec('ir-issue-1'),
      memoryVolumeName: 'agent-memory',
    });

    expect(bindsOf(configs[0])).toEqual([
      '/tmp/workspaces/issue-1:/workspaces/issue-1',
      'agent-memory:/home/agent/.pi/agent/memory',
    ]);
  });

  it('memoryVolumeName/mountPath не заданы → дефолты agent-memory:/home/agent/.pi/agent/memory', async () => {
    const { configs, docker } = captureDocker();
    const controller = new DockerodeContainerController(docker);

    await controller.spawn(spec('ir-issue-1'));

    expect(bindsOf(configs[0])).toContain(
      'agent-memory:/home/agent/.pi/agent/memory',
    );
  });

  it('memoryVolumeName/mountPath заданы явно → используются они', async () => {
    const { configs, docker } = captureDocker();
    const controller = new DockerodeContainerController(docker);

    await controller.spawn({
      ...spec('ir-issue-1'),
      memoryVolumeName: 'shared-memory',
      memoryMountPath: '/custom/memory',
    });

    expect(bindsOf(configs[0])).toContain('shared-memory:/custom/memory');
  });
});

describe('реальные адаптеры (smoke: конструирование без реальных вызовов)', () => {
  it('DockerodeContainerController конструируется с инъецированным docker-клиентом', () => {
    expect(new DockerodeContainerController(new Dockerode())).toBeInstanceOf(
      DockerodeContainerController,
    );
  });

  it('GitCliService конструируется с путём воркспейса', () => {
    expect(new GitCliService()).toBeInstanceOf(GitCliService);
  });
});