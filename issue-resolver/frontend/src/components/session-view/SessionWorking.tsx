import { formatDuration } from '../../lib/time';
import { phaseLabel } from './phase';
import type { WorkingPhase } from './types';

export default function SessionWorking({
  phase,
  elapsedMs,
}: {
  phase: WorkingPhase;
  elapsedMs: number | null;
}) {
  return (
    <div
      data-testid="session-working"
      data-phase={phase.kind}
      className="flex flex-wrap items-center gap-x-2 border-t border-[#008F11]/40 bg-[#000200] px-2 py-1 text-[10px] uppercase tracking-wider text-[#00FF41]/50"
    >
      <span aria-hidden="true" className="animate-pulse-subtle">
        ◐
      </span>
      <span data-testid="session-working-phase">
        {phaseLabel(phase)}
        <span className="animate-pulse-subtle">…</span>
      </span>
      {elapsedMs !== null && (
        <span
          data-testid="session-working-elapsed"
          className="text-[#00FF41]/40"
        >
          {formatDuration(elapsedMs)}
        </span>
      )}
    </div>
  );
}