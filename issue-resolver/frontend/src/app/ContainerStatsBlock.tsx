import type { ContainerStatsPayload } from '../api/sse';
import { formatBytes, healthColor } from '../lib/containerStats';

interface ContainerStatsBlockProps {
  stats: ContainerStatsPayload | null;
  suffix: string;
  className?: string;
}

export default function ContainerStatsBlock({
  stats,
  suffix,
  className,
}: ContainerStatsBlockProps) {
  const cpuPercent = stats?.cpuPercent ?? null;
  const memoryUsageBytes = stats?.memoryUsageBytes ?? null;
  const memoryLimitBytes = stats?.memoryLimitBytes ?? null;
  const memPercent =
    memoryUsageBytes != null && memoryLimitBytes
      ? (memoryUsageBytes / memoryLimitBytes) * 100
      : null;

  return (
    <div
      data-testid={`container-stats${suffix}`}
      className={[
        'flex items-center gap-3 font-mono text-xs text-[#00FF41]/60',
        className ?? '',
      ].join(' ')}
    >
      {stats && cpuPercent != null ? (
        <>
          <span className="flex items-center gap-1">
            <span
              data-testid={`cpu-health${suffix}`}
              className="inline-block h-2 w-2 rounded-full"
              style={{ backgroundColor: healthColor(cpuPercent, 80) }}
            />
            {`CPU ${cpuPercent.toFixed(1)}%`}
          </span>
          <span className="flex items-center gap-1">
            <span
              data-testid={`mem-health${suffix}`}
              className="inline-block h-2 w-2 rounded-full"
              style={{ backgroundColor: healthColor(memPercent ?? 0, 90) }}
            />
            {`MEM ${formatBytes(memoryUsageBytes ?? 0)}`}
          </span>
        </>
      ) : (
        <>
          <span className="flex items-center gap-1">
            <span
              data-testid={`cpu-health${suffix}`}
              className="inline-block h-2 w-2 rounded-full bg-[#00FF41]/20"
            />
            CPU —
          </span>
          <span className="flex items-center gap-1">
            <span
              data-testid={`mem-health${suffix}`}
              className="inline-block h-2 w-2 rounded-full bg-[#00FF41]/20"
            />
            MEM —
          </span>
        </>
      )}
    </div>
  );
}
