import type { SessionInfo, SessionQueue } from './types';

type QueueItemKind = 'steer' | 'follow-up';

interface QueueItem {
  kind: QueueItemKind;
  text: string;
  index: number;
}

function queueItems(queue: SessionQueue): QueueItem[] {
  const items: QueueItem[] = [];
  queue.steering.forEach((text, index) =>
    items.push({ kind: 'steer', text, index }),
  );
  queue.followUp.forEach((text, index) =>
    items.push({ kind: 'follow-up', text, index }),
  );
  return items;
}

function queueTitle(queue: SessionQueue): string {
  const parts: string[] = [];
  if (queue.steering.length > 0) {
    parts.push(`steer: ${queue.steering.join(' | ')}`);
  }
  if (queue.followUp.length > 0) {
    parts.push(`follow-up: ${queue.followUp.join(' | ')}`);
  }
  return parts.join('\n');
}

export default function SessionInfoBar({
  info,
  onRecallQueued,
}: {
  info: SessionInfo;
  onRecallQueued?: (text: string) => void;
}) {
  if (
    info.sessionName === null &&
    info.thinkingLevel === null &&
    info.queue === null &&
    info.statuses.length === 0
  ) {
    return null;
  }

  return (
    <div
      data-testid="session-info"
      className="flex flex-wrap items-center gap-x-3 gap-y-1 border border-[#008F11]/50 bg-[#000200] px-2 py-1 text-[10px] text-[#00FF41]/70"
    >
      {info.sessionName !== null && (
        <span data-testid="session-name" className="break-words">
          сессия: <span className="text-[#00FF41]">{info.sessionName}</span>
        </span>
      )}
      {info.thinkingLevel !== null && (
        <span data-testid="session-thinking-level">
          thinking:{' '}
          <span className="text-[#00B4FF]">{info.thinkingLevel}</span>
        </span>
      )}
      {info.queue !== null && (
        <span
          data-testid="session-queue"
          title={queueTitle(info.queue)}
          className="text-[#FFB000]"
        >
          очередь: steer {info.queue.steering.length} · follow-up{' '}
          {info.queue.followUp.length}
        </span>
      )}
      {onRecallQueued &&
        info.queue !== null &&
        queueItems(info.queue).map((item) => (
          <button
            key={`${item.kind}-${item.index}`}
            type="button"
            data-testid={`queue-recall-${item.kind}-${item.index}`}
            title={`Вернуть в поле ввода: ${item.text}`}
            onClick={() => onRecallQueued(item.text)}
            className="max-w-[16rem] truncate border border-[#FFB000]/60 px-1 text-[#FFB000] hover:bg-[#FFB000] hover:text-[#0D0208]"
          >
            ↩ {item.text}
          </button>
        ))}
      {info.statuses.map((status) => (
        <span
          key={status.key}
          data-testid={`session-status-${status.key}`}
          className="border border-[#008F11] px-1"
        >
          {status.key}: {status.text}
        </span>
      ))}
    </div>
  );
}