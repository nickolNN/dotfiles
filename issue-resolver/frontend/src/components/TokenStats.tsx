import type { ReactNode } from 'react';

/** Иконка рециклинга (circular arrows) — кеш-токены. */
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

/** Пара иконка-значение: ↑ 1.2k / ↓ 500 / кеш 1M */
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

/** Маленькая стрелка вверх — отправленные (input) токены. */
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

/** Маленькая стрелка вниз — полученные (output) токены. */
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

/** Компактный формат: 950 → "950", 105000 → "105k", 1200000 → "1.2M". */
export function formatTokens(total: number): string {
  if (!Number.isFinite(total) || total <= 0) return '0';
  if (total >= 1_000_000) return `${trimDecimal(total / 1_000_000)}M`;
  if (total >= 1000) return `${trimDecimal(total / 1000)}k`;
  return String(Math.round(total));
}

function trimDecimal(value: number): string {
  return value.toFixed(1).replace(/\.0$/, '');
}

/** Мгновенная скорость: один знак после запятой (63.5 → "63.5"). */
export function formatInstantSpeed(value: number): string {
  return value.toFixed(1);
}

/** Средняя скорость: округление до целого (63.5 → "64"). */
export function formatAvgSpeed(value: number): string {
  return String(Math.round(value));
}

/** Compact cost: `$0` / `$0.0123` / `$1.5`; null/NaN/≤0 → `$0`. */
export function formatCost(total: number): string {
  if (!Number.isFinite(total) || total <= 0) return '$0';
  return `$${total.toFixed(4).replace(/0+$/, '').replace(/\.$/, '')}`;
}

export interface TokenStatsData {
  /** ↑ Отправленные токены. */
  input: number;
  /** ↓ Полученные токены. */
  output: number;
  /** Кеш-токены (read + write). */
  cached: number;
}

export interface TokenStatsProps {
  data: TokenStatsData;
  /** Модель (опционально). */
  model?: string | null;
  /** CTX процент использования (опционально). */
  contextPercent?: number | null;
  /** Число вызовов инструментов (опционально). */
  toolCalls?: number;
  /** Мгновенная скорость t/s (опционально). */
  tokensPerSecond?: number | null;
  /** Средняя скорость t/s (опционально). */
  avgTokensPerSecond?: number | null;
  /** data-testid для span-обёртки. */
  testId?: string;
}

/**
 * Унифицированная строка токенов: модель · CTX% · ↑ input · ↓ output · кеш
 * cached · N вызовов · скорость t/s.
 *
 * Каждый сегмент опционален и рендерится только при наличии значения (не
 * null/undefined; число 0 рендерится как «0»).
 */
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