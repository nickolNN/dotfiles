import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import { PassThrough } from 'node:stream';
import Dockerode from 'dockerode';
import type { ContainerSpec } from '@issue-resolver/shared';
import {
  DockerodeContainerController,
  FakeContainerController,
  toContainerStatsPayload,
} from '../src/docker/controller';
import { LocalContainerController } from '../src/docker/local-controller';
import { FakeGitService, GitCliService } from '../src/git/service';

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    existsSync: vi.fn(),
    readFileSync: vi.fn(),
  };
});

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

  it('stats → нули с тем же containerName (Docker не трогается)', async () => {
    const controller = new FakeContainerController();

    await expect(controller.stats('ir-issue-1')).resolves.toEqual({
      containerName: 'ir-issue-1',
      cpuPercent: 0,
      memoryUsageBytes: 0,
      memoryLimitBytes: 0,
      pids: 0,
    });
  });

  it('failNextWith → stats rejects', async () => {
    const controller = new FakeContainerController();
    controller.failNextWith(new Error('docker unavailable'));

    await expect(controller.stats('ir-issue-1')).rejects.toThrow(
      'docker unavailable',
    );
  });

  it('statsStream → пустой Readable, Docker не трогается', async () => {
    const controller = new FakeContainerController();

    const stream = await controller.statsStream('ir-issue-1');

    expect(typeof stream.on).toBe('function');
    (stream as NodeJS.ReadableStream & { destroy?: () => void }).destroy?.();
  });

  it('failNextWith → statsStream rejects', async () => {
    const controller = new FakeContainerController();
    controller.failNextWith(new Error('docker unavailable'));

    await expect(controller.statsStream('ir-issue-1')).rejects.toThrow(
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

describe('DockerodeContainerController.stats', () => {
  function statsDocker(data: unknown): Dockerode {
    return {
      getContainer: () => ({ stats: async () => data }),
    } as unknown as Dockerode;
  }

  const sample = {
    cpu_stats: {
      cpu_usage: { total_usage: 300 },
      system_cpu_usage: 5000,
      online_cpus: 2,
    },
    precpu_stats: {
      cpu_usage: { total_usage: 100 },
      system_cpu_usage: 1000,
    },
    memory_stats: { usage: 1024, limit: 2048 },
    pids_stats: { current: 7 },
  };

  it('cpuPercent по дельтам (cpu/system/online_cpus), память и pids переносятся', async () => {
    const controller = new DockerodeContainerController(statsDocker(sample));

    await expect(controller.stats('ir-issue-1')).resolves.toEqual({
      containerName: 'ir-issue-1',
      cpuPercent: 10,
      memoryUsageBytes: 1024,
      memoryLimitBytes: 2048,
      pids: 7,
    });
  });

  it('systemDelta = 0 → cpuPercent null', async () => {
    const controller = new DockerodeContainerController(
      statsDocker({
        ...sample,
        precpu_stats: { ...sample.precpu_stats, system_cpu_usage: 5000 },
      }),
    );

    const stats = await controller.stats('ir-issue-1');

    expect(stats.cpuPercent).toBeNull();
  });

  it('пустой stats-JSON → 0/null без падения', async () => {
    const controller = new DockerodeContainerController(statsDocker({}));

    await expect(controller.stats('ir-issue-1')).resolves.toEqual({
      containerName: 'ir-issue-1',
      cpuPercent: null,
      memoryUsageBytes: 0,
      memoryLimitBytes: 0,
      pids: 0,
    });
  });
});

describe('DockerodeContainerController.statsStream', () => {
  it('открывает поток контейнера через stats({ stream: true })', async () => {
    const stream = new PassThrough();
    const calls: Array<{ name: string; options: unknown }> = [];
    const docker = {
      getContainer: (name: string) => ({
        stats: async (options: unknown) => {
          calls.push({ name, options });
          return stream;
        },
      }),
    } as unknown as Dockerode;
    const controller = new DockerodeContainerController(docker);

    await expect(controller.statsStream('ir-issue-1')).resolves.toBe(stream);
    expect(calls).toEqual([{ name: 'ir-issue-1', options: { stream: true } }]);
  });
});

describe('LocalContainerController.statsStream', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.resetAllMocks();
  });

  it('reads cgroup, шлёт NDJSON docker-stats и считает CPU по дельтам', async () => {
    vi.useFakeTimers();

    let cpuReads = 0;
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockImplementation(((path: unknown): string => {
      const file = String(path);
      if (file.endsWith('/cpu.stat')) {
        cpuReads += 1;
        const usage = cpuReads === 1 ? 1_000_000 : 1_500_000;
        return `usage_usec ${usage}\nuser_usec 0\nsystem_usec 0\n`;
      }
      if (file.endsWith('/memory.current')) return '1048576\n';
      if (file.endsWith('/memory.max')) return '2097152\n';
      if (file.endsWith('/pids.current')) return '3\n';
      if (file.endsWith('/cpuset.cpus.effective')) return '0-1\n';
      throw new Error(`unexpected cgroup read: ${file}`);
    }) as never);

    const controller = new LocalContainerController();
    const stream = await controller.statsStream('ir-issue-2');

    const chunks: string[] = [];
    stream.on('data', (chunk: Buffer) => chunks.push(chunk.toString()));

    await vi.advanceTimersByTimeAsync(1000);

    expect(chunks).toHaveLength(2);
    const first = toContainerStatsPayload(JSON.parse(chunks[0]));
    expect(first).toEqual({
      cpuPercent: null,
      memoryUsageBytes: 1048576,
      memoryLimitBytes: 2097152,
      pids: 3,
    });
    const second = toContainerStatsPayload(JSON.parse(chunks[1]));
    expect(second).toEqual({
      cpuPercent: 50,
      memoryUsageBytes: 1048576,
      memoryLimitBytes: 2097152,
      pids: 3,
    });

    expect(fs.existsSync).toHaveBeenCalledWith('/sys/fs/cgroup/cpu.stat');
    (stream as NodeJS.ReadableStream & { destroy?: () => void }).destroy?.();
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