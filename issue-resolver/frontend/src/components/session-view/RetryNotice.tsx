import type { RetryEvent } from './types';

export default function RetryNotice({ event }: { event: RetryEvent }) {
  const kind = event.kind === 'summarization' ? 'суммаризация' : 'авто';

  if (event.type === 'retry_start') {
    return (
      <div
        data-testid="session-retry"
        data-state="start"
        className="border border-[#00B4FF]/60 bg-[#001018] px-2 py-1 text-xs text-[#00B4FF]"
      >
        ретрай ({kind})
        {event.attempt !== null &&
          event.maxAttempts !== null &&
          ` · попытка ${event.attempt}/${event.maxAttempts}`}
        {event.delayMs !== null && ` · через ${event.delayMs}ms`}
        {event.errorMessage !== null && (
          <span className="ml-2 text-[#FF0033]">{event.errorMessage}</span>
        )}
      </div>
    );
  }

  return (
    <div
      data-testid="session-retry"
      data-state="end"
      data-success={event.success === null ? 'unknown' : String(event.success)}
      className={`border px-2 py-1 text-xs ${
        event.success === false
          ? 'border-[#FF0033]/60 bg-[#2A0008] text-[#FF0033]'
          : 'border-[#00FF41]/60 bg-[#003B00] text-[#00FF41]'
      }`}
    >
      ретрай ({kind}): {event.success === false ? 'ошибка' : 'успех'}
      {event.finalError !== null && (
        <span className="ml-2">{event.finalError}</span>
      )}
    </div>
  );
}