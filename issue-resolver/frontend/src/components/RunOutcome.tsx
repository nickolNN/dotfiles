import type {
  SessionStats,
  StepRunStatus,
} from '@issue-resolver/shared';
import { parseStepReport } from '@issue-resolver/shared';
import type { SessionEvent } from '../api/session-events';
import { CacheIcon } from './TokenStats';
import AutoScrollBox from './AutoScrollBox';
import SessionView from './SessionView';
import {
  formatCost,
  formatTokens,
  TokenDownIcon,
  TokenUpIcon,
  type FooterData,
} from './SessionStatsBar';

interface RunOutcomeProps {
  prefix: 'step' | 'report';
  status: StepRunStatus;
  events: SessionEvent[];
  stats: SessionStats | null;
  report: string | null;
  startedAt: string | undefined;
  liveView?: React.ReactNode;
  live?: boolean;
  outcome?: React.ReactNode;
}



const STATUS_COLORS: Record<string, string> = {
  pass: 'text-[#00FF41]',
  blocked: 'text-[#FFB000]',
  fail: 'text-[#FF0033]',
};

export function RunOutcome({
  prefix,
  status,
  events,
  stats,
  report,
  startedAt,
  liveView,
  outcome,
  live = status === 'running' || status === 'pending',
}: RunOutcomeProps) {
  if (live) {
    return (
      <>
        {liveView ?? (
          <AutoScrollBox
            scrollKey={events.length}
            className="mt-2 h-[300px] overflow-auto border border-[#008F11] bg-[#000200] p-2"
          >
            <div data-testid={`${prefix}-session`}>
              <SessionView
                events={events}
                stats={stats}
                running
                startedAt={startedAt}
                showFooter={false}
              />
            </div>
          </AutoScrollBox>
        )}
      </>
    );
  }

  if (outcome) return <>{outcome}</>;

  if ((status as string) === 'aborted') {
    return (
      <div
        data-testid={`${prefix}-aborted`}
        className="mt-2 border border-[#FF0033] bg-[#2A0008] p-2"
      >
        <p className="mb-1 text-[10px] uppercase tracking-wider text-[#FF0033]">
          aborted
        </p>
        <p className="text-[#FF0033]">Прервано</p>
      </div>
    );
  }

  const parsed = parseStepReport(report ?? '');
  if (!parsed) {
    return (
      <p className="mt-2 text-xs text-[#00FF41]/60">Результат отсутствует.</p>
    );
  }

  return (
    <div
      data-testid={`${prefix}-summary`}
      className="mt-2 border border-[#008F11] bg-[#000200] p-2"
    >
      <p
        className={`mb-1 text-[10px] uppercase tracking-wider ${
          STATUS_COLORS[parsed.status] ?? 'text-[#FF0033]'
        }`}
      >
        {parsed.status.toUpperCase()}
      </p>
      <p className="line-clamp-4 whitespace-pre-wrap break-words text-[#00FF41]/80">
        {parsed.summary}
      </p>
    </div>
  );
}

export function RunStatsLine({
  prefix,
  duration,
  cost,
  footer,
}: {
  prefix: 'step' | 'report';
  duration: string;
  cost: number | null | undefined;
  footer: FooterData | null;
}) {
  if (duration === '' && cost == null && !footer) return null;
  return (
    <div
      data-testid={`${prefix}-stats`}
      className="mt-2 flex flex-wrap items-baseline gap-x-3 gap-y-1 border-t border-[#008F11]/40 pt-2 text-[10px] text-[#00FF41]/60"
    >
      {duration !== '' && (
        <span data-testid={`${prefix}-duration`}>⏱ {duration}</span>
      )}
      {cost != null && (
        <span data-testid={`${prefix}-cost`}>· {formatCost(cost)}</span>
      )}
      {footer && (
        <span data-testid={`${prefix}-tokens`}>
          {footer.model !== null && `${footer.model} · `}
          {footer.percent !== null && `CTX ${Math.round(footer.percent)}% · `}
          <span
            data-testid="session-token-in"
            className="inline-flex items-baseline gap-0.5"
          >
            <TokenUpIcon />
            {formatTokens(footer.input)}
          </span>{' '}
          <span
            data-testid="session-token-out"
            className="inline-flex items-baseline gap-0.5"
          >
            <TokenDownIcon />
            {formatTokens(footer.output)}
          </span>{' '}
          <span
            data-testid="session-token-cache"
            className="inline-flex items-baseline gap-0.5"
          >
            <CacheIcon />
            {formatTokens(footer.cached)}
          </span>
        </span>
      )}
    </div>
  );
}
