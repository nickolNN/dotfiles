import type { RepoPlatform } from '@issue-resolver/shared';
import { PLATFORM_CHIP_CLASSES, PLATFORM_LABELS } from './platform';

interface PlatformChipProps {
  platform?: RepoPlatform | null;
}

export default function PlatformChip({ platform }: PlatformChipProps) {
  if (!platform) {
    return (
      <span className="border border-[#008F11] px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-[#00FF41]/70">
        Repo
      </span>
    );
  }
  return (
    <span
      data-testid="repo-platform"
      className={`border px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide ${PLATFORM_CHIP_CLASSES[platform]}`}
    >
      {PLATFORM_LABELS[platform]}
    </span>
  );
}