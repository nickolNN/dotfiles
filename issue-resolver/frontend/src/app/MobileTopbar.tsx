import type { ContainerStatsPayload } from '../api/sse';
import PlusIcon from '../components/icons/PlusIcon';
import ContainerStatsBlock from './ContainerStatsBlock';

interface MobileTopbarProps {
  stats: ContainerStatsPayload | null;
  primaryLabel: string;
  onPrimary: () => void;
}

export default function MobileTopbar({
  stats,
  primaryLabel,
  onPrimary,
}: MobileTopbarProps) {
  return (
    <div
      data-testid="mobile-topbar"
      className="flex items-center justify-between gap-2 border-b border-[#008F11]/40 px-2 py-1 sm:hidden"
    >
      <ContainerStatsBlock stats={stats} suffix="-mobile" />
      <button
        type="button"
        data-testid="primary-action-mobile"
        aria-label={primaryLabel}
        title={primaryLabel}
        className="group inline-flex min-h-10 min-w-10 shrink-0 items-center justify-center rounded-full text-[#00FF41] transition-transform primary-action-btn"
        onClick={onPrimary}
      >
        <PlusIcon className="h-5 w-5 shrink-0" />
      </button>
    </div>
  );
}
