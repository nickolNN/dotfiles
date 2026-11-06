import type { ReactNode } from 'react';
import {
  formatAvgSpeed,
  formatCost,
  formatInstantSpeed,
  formatTokens,
} from '../lib/format';
import CacheIcon from './icons/CacheIcon';
import TokenDownIcon from './icons/TokenDownIcon';
import TokenUpIcon from './icons/TokenUpIcon';
import type { FooterData } from './SessionStatsBar';
import type { RunPrefix } from './RunOutcome';

export default function RunStatsLine({
  prefix,
  duration,
  cost,
  footer,
  children,
}: {
  prefix: RunPrefix;
  duration: string;
  cost: number | null | undefined;
  footer: FooterData | null;
  children?: ReactNode;
}) {
  if (duration === '' && cost == null && !footer && !children) return null;
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
          </span>{' '}
          <span className="session-stats-sep">·</span>{' '}
          {footer.toolCalls ?? 0} вызовов
          {(footer.tokensPerSecond !== null ||
            footer.avgTokensPerSecond !== null) && (
            <>
              {' '}
              <span className="session-stats-sep">·</span>{' '}
              <span data-testid={`${prefix}-speed`}>
                {footer.tokensPerSecond !== null &&
                  `${formatInstantSpeed(footer.tokensPerSecond)} t/s`}
                {footer.tokensPerSecond !== null &&
                  footer.avgTokensPerSecond !== null &&
                  ' · '}
                {footer.avgTokensPerSecond !== null &&
                  `avg ${formatAvgSpeed(footer.avgTokensPerSecond)} t/s`}
              </span>
            </>
          )}
        </span>
      )}
      {children}
    </div>
  );
}