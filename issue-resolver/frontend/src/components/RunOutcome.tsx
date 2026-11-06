import type { ReactNode } from 'react';
import type { SessionStats } from '@issue-resolver/shared';
import { parseStepReport, StepRunStatus } from '@issue-resolver/shared';
import type { SessionEvent } from '../api/session-events';
import { stepStatusColor } from '../theme';
import AutoScrollBox from './AutoScrollBox';
import { STATUS_META } from './step-report/meta';
import SessionView from './SessionView';

export type RunPrefix = 'step' | 'report' | 'devops' | 'retro';

const LIVE_CLASS =
  'mt-2 h-[300px] overflow-auto border border-[#008F11] bg-[#000200] p-2';

interface RunOutcomeProps {
  prefix: RunPrefix;
  status: StepRunStatus;
  events: SessionEvent[];
  stats: SessionStats | null;
  report: string | null;
  startedAt: string | undefined;
  liveView?: ReactNode;
  live?: boolean;
  body?: ReactNode;
  headerExtra?: ReactNode;
  liveClassName?: string;
  liveTestId?: string;
}

export default function RunOutcome({
  prefix,
  status,
  events,
  stats,
  report,
  startedAt,
  liveView,
  body,
  headerExtra,
  liveClassName,
  liveTestId,
  live = status === StepRunStatus.running || status === StepRunStatus.pending,
}: RunOutcomeProps) {
  if (live) {
    const view =
      liveView !== undefined ? (
        liveView
      ) : (
        <AutoScrollBox
          scrollKey={events.length}
          className={liveClassName ?? LIVE_CLASS}
        >
          <div data-testid={liveTestId ?? `${prefix}-session`}>
            <SessionView
              events={events}
              stats={stats}
              running
              startedAt={startedAt}
              showFooter={false}
            />
          </div>
        </AutoScrollBox>
      );
    return <>{view}</>;
  }

  if (status === StepRunStatus.aborted) {
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

  if (body == null) {
    const parsed = parseStepReport(report ?? '');
    if (!parsed) {
      return (
        <p className="mt-2 text-xs text-[#00FF41]/60">Результат отсутствует.</p>
      );
    }
    return (
      <ResultFrame
        prefix={prefix}
        label={parsed.status.toUpperCase()}
        labelClass={STATUS_META[parsed.status]?.textClass ?? 'text-[#FF0033]'}
        headerExtra={headerExtra}
      >
        <p className="line-clamp-4 whitespace-pre-wrap break-words text-[#00FF41]/80">
          {parsed.summary}
        </p>
      </ResultFrame>
    );
  }

  return (
    <ResultFrame
      prefix={prefix}
      label={status.toUpperCase()}
      labelColor={stepStatusColor[status]}
      headerExtra={headerExtra}
    >
      {body}
    </ResultFrame>
  );
}

function ResultFrame({
  prefix,
  label,
  labelClass,
  labelColor,
  headerExtra,
  children,
}: {
  prefix: RunPrefix;
  label: string;
  labelClass?: string;
  labelColor?: string;
  headerExtra?: ReactNode;
  children: ReactNode;
}) {
  const statusLabel = (
    <p
      className={
        headerExtra == null
          ? `mb-1 text-[10px] uppercase tracking-wider ${labelClass ?? ''}`
          : `text-[10px] uppercase tracking-wider ${labelClass ?? ''}`
      }
      style={labelColor ? { color: labelColor } : undefined}
    >
      {label}
    </p>
  );

  return (
    <div
      data-testid={`${prefix}-summary`}
      className="mt-2 border border-[#008F11] bg-[#000200] p-2"
    >
      {headerExtra == null ? (
        statusLabel
      ) : (
        <div className="mb-1 flex items-center justify-between gap-3">
          {statusLabel}
          {headerExtra}
        </div>
      )}
      {children}
    </div>
  );
}
