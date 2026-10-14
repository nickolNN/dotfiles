import { existsSync, readFileSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { PassThrough } from 'node:stream';
import type {
  ContainerSpec,
  ContainerStats,
  SpawnContainerResult,
} from '@issue-resolver/shared';
import type { ContainerController, DockerStatsJson } from './controller';

/** Интервал опроса cgroup — совпадает с интервалом docker stats. */
const CGROUP_POLL_INTERVAL_MS = 1000;

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

  /**
   * One-shot метрики в локальном режиме остаются нулями (`cpuPercent: null`),
   * чтобы роут container-stats работал без падения. Живые метрики этого
   * контейнера отдаёт `statsStream` через cgroup.
   */
  async stats(containerName: string): Promise<ContainerStats> {
    return {
      containerName,
      cpuPercent: null,
      memoryUsageBytes: 0,
      memoryLimitBytes: 0,
      pids: 0,
    };
  }

  /**
   * Поток реальных метрик этого контейнера из Linux cgroup (v2, fallback v1).
   * Отдаёт NDJSON в формате docker-stats — его разбирает
   * `toContainerStatsPayload` в роуте `container-stats-stream`.
   */
  async statsStream(_containerName: string): Promise<NodeJS.ReadableStream> {
    const stream = new PassThrough();
    let prevCpuUsage: number | null = null;
    let prevSystemUsage = 0;
    let prevTime = Date.now();
    let timer: NodeJS.Timeout | undefined;

    const emit = (): void => {
      const cgroup = readCgroupStats();
      const now = Date.now();
      const elapsedUs = Math.max(0, (now - prevTime) * 1000);
      const systemUsage = prevSystemUsage + elapsedUs * cgroup.numCpus;
      const firstFrame = prevCpuUsage === null;

      const frame: DockerStatsJson = {
        cpu_stats: {
          cpu_usage: { total_usage: cgroup.cpuUsage },
          // Дельты в тех же единицах (мкс), что и cpu. Множитель numCpus
          // компенсируется `online_cpus` внутри toContainerStatsPayload.
          system_cpu_usage: systemUsage,
          online_cpus: cgroup.numCpus,
        },
        precpu_stats: {
          cpu_usage: { total_usage: prevCpuUsage ?? cgroup.cpuUsage },
          system_cpu_usage: firstFrame ? systemUsage : prevSystemUsage,
        },
        memory_stats: { usage: cgroup.memoryUsage, limit: cgroup.memoryLimit },
        pids_stats: { current: cgroup.pids },
      };

      prevCpuUsage = cgroup.cpuUsage;
      prevSystemUsage = systemUsage;
      prevTime = now;

      if (!stream.destroyed) {
        stream.push(`${JSON.stringify(frame)}\n`);
      }
    };

    const stop = (): void => {
      if (timer) {
        clearInterval(timer);
        timer = undefined;
      }
    };

    // Первый кадр отдаём сразу (память/pids), CPU появится со второго —
    // дельту для первого кадра считать не от чего.
    try {
      emit();
    } catch (error) {
      stream.destroy(error instanceof Error ? error : new Error(String(error)));
      return stream;
    }

    timer = setInterval(() => {
      if (stream.destroyed) {
        stop();
        return;
      }
      try {
        emit();
      } catch (error) {
        stop();
        stream.destroy(error instanceof Error ? error : new Error(String(error)));
      }
    }, CGROUP_POLL_INTERVAL_MS);

    stream.on('close', stop);
    stream.on('end', stop);

    return stream;
  }
}

interface CgroupStats {
  /** Накопленное CPU-время cgroup, микросекунды. */
  cpuUsage: number;
  memoryUsage: number;
  memoryLimit: number;
  numCpus: number;
  pids: number;
}

/** Число CPU из cpuset-списка вида `0-3,8` (диапазоны и одиночные id). */
function countCpus(cpuset: string): number {
  let count = 0;
  for (const part of cpuset.split(',')) {
    const range = part.trim();
    if (!range) continue;
    const [startRaw, endRaw] = range.split('-');
    const start = Number.parseInt(startRaw ?? '', 10);
    if (!Number.isFinite(start)) continue;
    const end = endRaw === undefined ? start : Number.parseInt(endRaw, 10);
    if (!Number.isFinite(end)) continue;
    count += Math.max(0, end - start + 1);
  }
  return count > 0 ? count : 1;
}

function readInt(path: string): number {
  const value = Number.parseInt(readFileSync(path, 'utf8').trim(), 10);
  return Number.isFinite(value) ? value : 0;
}

/** Host memory в байтах — лимит контейнера при cgroup v2 `memory.max=max`. */
function readHostMemoryLimit(): number {
  try {
    const match = readFileSync('/proc/meminfo', 'utf8').match(
      /MemTotal:\s+(\d+)\s*kB/,
    );
    return match ? Number.parseInt(match[1], 10) * 1024 : 0;
  } catch {
    return 0;
  }
}

/**
 * Читает метрики текущего cgroup: v2 (`/sys/fs/cgroup`, unified) с fallback на
 * v1 (legacy hierarchy). CPU всегда нормализуется в микросекунды.
 */
function readCgroupStats(): CgroupStats {
  if (existsSync('/sys/fs/cgroup/cpu.stat')) {
    const cpuRaw = readFileSync('/sys/fs/cgroup/cpu.stat', 'utf8');
    const usageMatch = cpuRaw.match(/usage_usec\s+(\d+)/);
    const cpuUsage = usageMatch ? Number.parseInt(usageMatch[1], 10) : 0;
    const memoryUsage = readInt('/sys/fs/cgroup/memory.current');
    const memoryMax = readFileSync('/sys/fs/cgroup/memory.max', 'utf8').trim();
    const parsedLimit =
      memoryMax === 'max'
        ? readHostMemoryLimit()
        : Number.parseInt(memoryMax, 10);
    const pids = readInt('/sys/fs/cgroup/pids.current');
    const cpuset = readFileSync(
      '/sys/fs/cgroup/cpuset.cpus.effective',
      'utf8',
    ).trim();
    return {
      cpuUsage,
      memoryUsage,
      memoryLimit: Number.isFinite(parsedLimit) ? parsedLimit : 0,
      numCpus: countCpus(cpuset),
      pids,
    };
  }

  // cgroup v1 (legacy hierarchy).
  return {
    cpuUsage: Math.round(readInt('/sys/fs/cgroup/cpu/cpuacct.usage') / 1000),
    memoryUsage: readInt('/sys/fs/cgroup/memory/memory.usage_in_bytes'),
    memoryLimit: readInt('/sys/fs/cgroup/memory/memory.limit_in_bytes'),
    numCpus: countCpus(
      readFileSync('/sys/fs/cgroup/cpuset/cpuset.cpus', 'utf8').trim(),
    ),
    pids: readInt('/sys/fs/cgroup/pids/pids.current'),
  };
}