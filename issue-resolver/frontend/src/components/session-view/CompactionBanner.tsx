import { formatCompactionTokens } from '../../lib/format';
import type { CompactionEvent } from './types';

export default function CompactionBanner({ event }: { event: CompactionEvent }) {
  if (event.type === 'compaction_start') {
    return (
      <div
        data-testid="session-compaction"
        data-state="start"
        className="flex items-center gap-2 border border-[#FFB000]/60 bg-[#1A1000] px-2 py-1 text-xs text-[#FFB000]"
      >
        <span aria-hidden="true" className="animate-pulse-subtle">
          ◐
        </span>
        <span>контекст сжимается · {event.reason}</span>
      </div>
    );
  }

  const header =
    event.tokensBefore !== null
      ? `сжато с ${formatCompactionTokens(event.tokensBefore)} токенов`
      : `компакция: ${event.reason}`;

  return (
    <div
      data-testid="session-compaction"
      data-state="end"
      className="border border-[#FFB000]/60 bg-[#1A1000] px-2 py-1 text-xs text-[#FFB000]"
    >
      <div className="flex flex-wrap items-center gap-2">
        <span>{header}</span>
        {event.aborted && <span>отменена</span>}
        {event.willRetry && <span>повтор</span>}
        {(event.tokensBefore !== null ||
          event.estimatedTokensAfter !== null) && (
          <span className="text-[#FFB000]/80">
            {formatCompactionTokens(event.tokensBefore)} →{' '}
            {formatCompactionTokens(event.estimatedTokensAfter)}
          </span>
        )}
        {event.errorMessage !== null && (
          <span className="text-[#FF0033]">{event.errorMessage}</span>
        )}
      </div>
      {event.summary !== null && (
        <div
          data-testid="session-compaction-summary"
          className="mt-1 whitespace-pre-wrap break-words text-[#FFB000]/80"
        >
          {event.summary}
        </div>
      )}
    </div>
  );
}