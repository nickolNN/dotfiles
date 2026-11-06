import type { RepoConnectionStatus } from '@issue-resolver/shared';
import { STATUS_META } from './status';

export default function StatusDot({ status }: { status: RepoConnectionStatus }) {
  const meta = STATUS_META[status];
  return (
    <span
      data-testid={`repo-status-${status}`}
      role="img"
      aria-label={meta.label}
      title={meta.label}
      className="inline-block h-3 w-3 shrink-0 rounded-full border"
      style={{ backgroundColor: meta.color, borderColor: meta.color }}
    />
  );
}