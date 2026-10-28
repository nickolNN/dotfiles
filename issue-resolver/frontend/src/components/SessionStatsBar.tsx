import { useMemo } from 'react';
import type {
  SessionSpeed,
  SessionStats,
  SessionUsage,
} from '@issue-resolver/shared';
import type { SessionEvent } from '../api/session-events';

interface LiveUsage {
  usage: SessionUsage;
  speed?: SessionSpeed;
}

export interface FooterData {
  model: string | null;
  percent: number | null;
  input: number;
  output: number;
  cached: number;
  tokensPerSecond: number | null;
  avgTokensPerSecond: number | null;
  toolCalls?: number;
}

interface SessionStatsBarProps {
  events: SessionEvent[];
  stats?: SessionStats | null;
  className?: string;
}

export function TokenUpIcon() {
  return (
    <svg
      aria-hidden="true"
      className="h-[1em] w-[1em] shrink-0"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={2}
      viewBox="0 0 24 24"
    >
      <path d="M12 19V5M5 12l7-7 7 7" />
    </svg>
  );
}

export function TokenDownIcon() {
  return (
    <svg
      aria-hidden="true"
      className="h-[1em] w-[1em] shrink-0"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={2}
      viewBox="0 0 24 24"
    >
      <path d="M12 5v14M5 12l7 7 7-7" />
    </svg>
  );
}

export default function SessionStatsBar({
  events,
  stats,
  className,
}: SessionStatsBarProps) {
  const footer = useMemo(() => resolveFooter(events, stats), [events, stats]);

  if (!footer) return null;

  const { model, percent, input, output, cached, tokensPerSecond, avgTokensPerSecond } =
    footer;
  const showSpeed = tokensPerSecond !== null || avgTokensPerSecond !== null;

  return (
    <div
      data-testid="session-stats"
      className={`session-stats${className ? ` ${className}` : ''}`}
    >
      {model !== null && (
        <>
          <span>{model}</span>
          <span className="session-stats-sep">·</span>
        </>
      )}
      {percent !== null && (
        <>
          <span>CTX {Math.round(percent)}%</span>
          <span className="session-stats-sep">·</span>
        </>
      )}
      <span
        data-testid="session-token-in"
        className="inline-flex items-baseline gap-0.5"
      >
        <TokenUpIcon />
        {formatTokens(input)}
      </span>
      <span className="session-stats-sep">·</span>
      <span
        data-testid="session-token-out"
        className="inline-flex items-baseline gap-0.5"
      >
        <TokenDownIcon />
        {formatTokens(output)}
      </span>
      <span className="session-stats-sep">·</span>
      <span>кеш {formatTokens(cached)}</span>
      {showSpeed && (
        <>
          <span className="session-stats-sep">·</span>
          <span data-testid="session-speed">
            {tokensPerSecond !== null && `${formatInstantSpeed(tokensPerSecond)} t/s`}
            {tokensPerSecond !== null && avgTokensPerSecond !== null && ' · '}
            {avgTokensPerSecond !== null && `avg ${formatAvgSpeed(avgTokensPerSecond)} t/s`}
          </span>
        </>
      )}
    </div>
  );
}

function lastLiveUsage(events: SessionEvent[]): LiveUsage | null {
  let live: LiveUsage | null = null;
  for (const event of events) {
    if (event.type === 'usage') {
      live = { usage: event.usage, speed: event.speed };
    }
  }
  return live;
}

function lastStatsEvent(events: SessionEvent[]): SessionStats | null {
  let latest: SessionStats | null = null;
  for (const event of events) {
    if (event.type === 'stats') latest = event.stats;
  }
  return latest;
}

export function resolveFooter(
  events: SessionEvent[],
  stats?: SessionStats | null,
): FooterData | null {
  const live = lastLiveUsage(events);
  const liveStats = lastStatsEvent(events);
  if (liveStats) {
    return {
      model: liveStats.model ?? null,
      percent: liveStats.contextUsage?.percent ?? null,
      input: liveStats.tokens.input,
      output: liveStats.tokens.output,
      cached: liveStats.tokens.cacheRead + liveStats.tokens.cacheWrite,
      tokensPerSecond: null,
      avgTokensPerSecond: finiteOrNull(liveStats.avgTokensPerSecond),
      toolCalls: liveStats.toolCalls,
    };
  }
  if (live) {
    return {
      model: stats?.model ?? null,
      percent: stats?.contextUsage?.percent ?? null,
      input: live.usage.input,
      output: live.usage.output,
      cached: live.usage.cacheRead + live.usage.cacheWrite,
      tokensPerSecond: finiteOrNull(live.speed?.tokensPerSecond),
      avgTokensPerSecond: finiteOrNull(live.speed?.avgTokensPerSecond),
      toolCalls: stats?.toolCalls ?? 0,
    };
  }
  if (stats) {
    return {
      model: stats.model ?? null,
      percent: stats.contextUsage?.percent ?? null,
      input: stats.tokens.input,
      output: stats.tokens.output,
      cached: stats.tokens.cacheRead + stats.tokens.cacheWrite,
      tokensPerSecond: null,
      avgTokensPerSecond: finiteOrNull(stats.avgTokensPerSecond),
      toolCalls: stats.toolCalls,
    };
  }
  return null;
}

export function formatInstantSpeed(value: number): string {
  return value.toFixed(1);
}

export function formatAvgSpeed(value: number): string {
  return String(Math.round(value));
}

function finiteOrNull(value: number | undefined | null): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function formatCost(total: number): string {
  if (!Number.isFinite(total) || total <= 0) return '$0';
  return `$${total.toFixed(4).replace(/0+$/, '').replace(/\.$/, '')}`;
}

export function formatTokens(total: number): string {
  if (!Number.isFinite(total) || total <= 0) return '0';
  if (total >= 1_000_000) return `${trimDecimal(total / 1_000_000)}M`;
  if (total >= 1000) return `${trimDecimal(total / 1000)}k`;
  return String(Math.round(total));
}

function trimDecimal(value: number): string {
  return value.toFixed(1).replace(/\.0$/, '');
}