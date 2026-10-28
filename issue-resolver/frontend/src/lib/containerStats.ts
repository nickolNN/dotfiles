const BYTES_PER_MB = 1024 * 1024;
const BYTES_PER_GB = 1024 * BYTES_PER_MB;

export function formatBytes(bytes: number): string {
  if (bytes < BYTES_PER_GB) {
    return `${(bytes / BYTES_PER_MB).toFixed(1)} MB`;
  }
  return `${(bytes / BYTES_PER_GB).toFixed(1)} GB`;
}

export function healthColor(value: number, threshold: number): string {
  if (value < threshold * 0.5) return '#00FF41';
  if (value < threshold * 0.8) return '#FFB000';
  return '#FF0033';
}