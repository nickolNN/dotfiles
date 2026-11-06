import type { NoticeEvent } from './types';

const LEVEL_STYLES: Record<NoticeEvent['level'], string> = {
  info: 'border-[#00B4FF]/60 bg-[#001018] text-[#00B4FF]',
  warning: 'border-[#FFB000]/60 bg-[#1A1000] text-[#FFB000]',
  error: 'border-[#FF0033]/60 bg-[#2A0008] text-[#FF0033]',
};

export default function NoticeBanner({ event }: { event: NoticeEvent }) {
  return (
    <div
      data-testid="session-notice"
      data-level={event.level}
      className={`border px-2 py-1 text-xs ${LEVEL_STYLES[event.level]}`}
    >
      {event.message}
    </div>
  );
}