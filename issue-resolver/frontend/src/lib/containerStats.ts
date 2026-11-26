const BYTES_PER_MB = 1024 * 1024;
const BYTES_PER_GB = 1024 * BYTES_PER_MB;

export function formatBytes(bytes: number): string {
  if (bytes < BYTES_PER_GB) {
    return `${(bytes / BYTES_PER_MB).toFixed(1)} MB`;
  }
  return `${(bytes / BYTES_PER_GB).toFixed(1)} GB`;
}

export function formatBytesPair(used: number, limit: number): string {
  const per = used < BYTES_PER_GB ? BYTES_PER_MB : BYTES_PER_GB;
  const unit = per === BYTES_PER_MB ? 'MB' : 'GB';
  return `${(used / per).toFixed(1)}/${(limit / per).toFixed(1)}${unit}`;
}

export function cpuLoadPercent(
  cpuPercent: number | null,
  cpuLimitPercent: number,
): number | null {
  if (cpuPercent == null || cpuLimitPercent <= 0) return null;
  return (cpuPercent / cpuLimitPercent) * 100;
}

export function healthColor(value: number, threshold: number): string {
  if (value < threshold * 0.5) return '#00FF41';
  if (value < threshold * 0.8) return '#FFB000';
  return '#FF0033';
}