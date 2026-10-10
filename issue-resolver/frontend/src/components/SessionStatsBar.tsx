import { useMemo } from 'react';
import type { SessionStats, SessionUsage } from '@issue-resolver/shared';
import type { SessionEvent } from '../api/session-events';

/** Последнее usage из стрима (легаси-источник до первого `stats`). */
interface LiveUsage {
  usage: SessionUsage;
}

/** Нормализованные поля строки статистики (live-stats, live-usage или prop). */
export interface FooterData {
  /** Метка модели, которой реально шла сессия (`name || id`), или null. */
  model: string | null;
  percent: number | null;
  input: number;
  output: number;
  cached: number;
  /** Число вызовов инструментов из stats/usage; 0, если данных нет. */
  toolCalls?: number;
}

interface SessionStatsBarProps {
  events: SessionEvent[];
  /** Статистика pi-сессии шага (`get_session_stats`) или null. */
  stats?: SessionStats | null;
  /** Дополнительные классы обёртки (например, чтобы закрепить в модалке). */
  className?: string;
}

/** Маленькая стрелка вверх — отправленные (input) токены. Монохромна: наследует
 * `currentColor` неонового футера (в стиле inline-SVG из `App.tsx`). */
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

/**
 * Строка статистики сессии: «{model} · CTX {p}% · ↑ input · ↓ output · кеш».
 * Показывает свежайшее `stats`-событие, иначе легаси `usage`-событие,
 * иначе статичный prop `stats`; при отсутствии данных не рендерится.
 * `model` и `CTX {p}%` рендерятся только при наличии значения.
 */
export default function SessionStatsBar({
  events,
  stats,
  className,
}: SessionStatsBarProps) {
  const footer = useMemo(() => resolveFooter(events, stats), [events, stats]);

  if (!footer) return null;

  const { model, percent, input, output, cached } = footer;

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
    </div>
  );
}

/** Последнее `usage`-событие в логе (кумулятивный снапшот) или null. */
function lastLiveUsage(events: SessionEvent[]): LiveUsage | null {
  let live: LiveUsage | null = null;
  for (const event of events) {
    if (event.type === 'usage') {
      live = { usage: event.usage };
    }
  }
  return live;
}

/** Последнее `stats`-событие сессии (периодический `get_session_stats`). */
function lastStatsEvent(events: SessionEvent[]): SessionStats | null {
  let latest: SessionStats | null = null;
  for (const event of events) {
    if (event.type === 'stats') latest = event.stats;
  }
  return latest;
}

/**
 * Источник строки статистики: свежайшее `stats`-событие (опрос ~3s) → легаси
 * `usage` (контекст% и число вызовов при этом берём из prop stats) → статичный
 * prop `stats`. Экспортирован, чтобы футер шага мог рендерить ту же строку,
 * не монтируя `SessionStatsBar` (в блоке она выключена через showFooter).
 */
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
      toolCalls: liveStats.toolCalls,
    };
  }
  if (live) {
    return {
      // usage-событие модели/вызовов не несёт — берём их из статичного prop `stats`.
      model: stats?.model ?? null,
      percent: stats?.contextUsage?.percent ?? null,
      input: live.usage.input,
      output: live.usage.output,
      cached: live.usage.cacheRead + live.usage.cacheWrite,
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
      toolCalls: stats.toolCalls,
    };
  }
  return null;
}

/** Компактный формат токенов: 950 → "950", 105000 → "105k", 1200000 → "1.2M". */
export function formatTokens(total: number): string {
  if (!Number.isFinite(total) || total <= 0) return '0';
  if (total >= 1_000_000) return `${trimDecimal(total / 1_000_000)}M`;
  if (total >= 1000) return `${trimDecimal(total / 1000)}k`;
  return String(Math.round(total));
}

/** Округляет до одного знака, убирая лишний ".0" (105.0 → 105). */
function trimDecimal(value: number): string {
  return value.toFixed(1).replace(/\.0$/, '');
}