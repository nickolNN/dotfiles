import type { ReactNode } from 'react';

export function CacheIcon() {
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
      <path d="M1 4v6h6" />
      <path d="M3.5 15.5a9 9 0 0 0 14.8-3.5" />
      <path d="M23 20v-6h-6" />
      <path d="M20.5 8.5a9 9 0 0 0-14.8 3.5" />
    </svg>
  );
}

function TokenSpan({
  icon,
  label,
  'data-testid': testId,
}: {
  icon: ReactNode;
  label: string;
  'data-testid'?: string;
}) {
  return (
    <span data-testid={testId} className="inline-flex items-baseline gap-0.5">
      {icon}
      {label}
    </span>
  );
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

export function formatTokens(total: number): string {
  if (!Number.isFinite(total) || total <= 0) return '0';
  if (total >= 1_000_000) return `${trimDecimal(total / 1_000_000)}M`;
  if (total >= 1000) return `${trimDecimal(total / 1000)}k`;
  return String(Math.round(total));
}

function trimDecimal(value: number): string {
  return value.toFixed(1).replace(/\.0$/, '');
}

export function formatInstantSpeed(value: number): string {
  return value.toFixed(1);
}

export function formatAvgSpeed(value: number): string {
  return String(Math.round(value));
}

export function formatCost(total: number): string {
  if (!Number.isFinite(total) || total <= 0) return '$0';
  return `$${total.toFixed(4).replace(/0+$/, '').replace(/\.$/, '')}`;
}

export interface TokenStatsData {
  input: number;
  output: number;
  cached: number;
}

export interface TokenStatsProps {
  data: TokenStatsData;
  model?: string | null;
  contextPercent?: number | null;
  toolCalls?: number;
  tokensPerSecond?: number | null;
  avgTokensPerSecond?: number | null;
  testId?: string;
}

export default function TokenStats({
  data,
  model,
  contextPercent,
  toolCalls,
  tokensPerSecond,
  avgTokensPerSecond,
  testId,
}: TokenStatsProps) {
  const segments: ReactNode[] = [];

  if (model !== null && model !== undefined) {
    segments.push(<span key="model">{model}</span>);
  }
  if (contextPercent !== null && contextPercent !== undefined) {
    segments.push(<span key="ctx">{`CTX ${Math.round(contextPercent)}%`}</span>);
  }

  segments.push(
    <span key="tokens">
      <TokenSpan
        icon={<TokenUpIcon />}
        label={formatTokens(data.input)}
      />{' '}
      <TokenSpan
        icon={<TokenDownIcon />}
        label={formatTokens(data.output)}
      />{' '}
      <TokenSpan
        icon={<CacheIcon />}
        label={formatTokens(data.cached)}
      />
    </span>,
  );

  if (toolCalls !== undefined) {
    segments.push(<span key="calls">{`${toolCalls} вызовов`}</span>);
  }

  if (tokensPerSecond !== null && tokensPerSecond !== undefined) {
    segments.push(
      <span key="speed">{`${formatInstantSpeed(tokensPerSecond)} t/s`}</span>,
    );
  }

  if (avgTokensPerSecond !== null && avgTokensPerSecond !== undefined) {
    segments.push(
      <span key="avg">{`avg ${formatAvgSpeed(avgTokensPerSecond)} t/s`}</span>,
    );
  }

  return (
    <span data-testid={testId}>
      {segments.reduce((prev, curr) => (
        <>
          {prev} <span className="session-stats-sep">·</span> {curr}
        </>
      ))}
    </span>
  );
}