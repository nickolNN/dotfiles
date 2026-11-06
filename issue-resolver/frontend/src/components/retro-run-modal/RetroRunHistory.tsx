import type { RetroRun } from '@issue-resolver/shared';
import { retroStatusColor } from '../../theme';
import { formatStamp } from './format';
import { ACTIVE_STATUSES, STATUS_LABEL } from './status';

interface RetroRunHistoryProps {
  history: RetroRun[];
  onOpen: (id: string) => void;
}

export default function RetroRunHistory({
  history,
  onOpen,
}: RetroRunHistoryProps) {
  return (
    <section className="space-y-2">
      <h3 className="text-sm font-semibold">История</h3>
      {history.length === 0 ? (
        <p className="text-xs text-[#00FF41]/50">Прогонов ещё не было</p>
      ) : (
        <ul data-testid="retro-history" className="space-y-1">
          {history.map((item) => (
            <li key={item.id}>
              <button
                type="button"
                className="flex w-full items-center justify-between gap-3 border border-[#008F11]/30 px-2 py-1 text-left text-xs hover:bg-[#008F11]/10"
                onClick={() => onOpen(item.id)}
              >
                <span style={{ color: retroStatusColor[item.status] }}>
                  {STATUS_LABEL[item.status]}
                </span>
                <span className="text-[#00FF41]/60">
                  {formatStamp(item.created_at)}
                </span>
                <span className="text-[#00FF41]/40">
                  {item.model ?? 'по умолчанию'}
                </span>
                {item.session_limit && (
                  <span className="text-[#00FF41]/40">
                    {item.session_limit} сессий
                  </span>
                )}
                {item.thinking_level && (
                  <span className="text-[#00FF41]/40">
                    {item.thinking_level}
                  </span>
                )}
                {!ACTIVE_STATUSES.has(item.status) && item.report && (
                  <span className="text-[#00FF41]/40">md</span>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}