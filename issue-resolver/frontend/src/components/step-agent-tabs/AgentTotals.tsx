import { formatCost, formatTokens } from '../../lib/format';
import { formatDuration } from '../../lib/time';
import CacheIcon from '../icons/CacheIcon';
import TokenDownIcon from '../icons/TokenDownIcon';
import TokenUpIcon from '../icons/TokenUpIcon';
import type { StageGroup, StepTotals } from './types';

interface AgentTotalsProps {
  totals: StepTotals;
  stageGroups: StageGroup[];
}

export default function AgentTotals({ totals, stageGroups }: AgentTotalsProps) {
  return (
    <>
      <p
        data-testid="step-agents-summary"
        className="mb-1 text-[10px] tracking-wider text-[#00FF41]/60"
      >
        Всего:{' '}
        <span className="inline-flex items-baseline gap-0.5">
          <TokenUpIcon />
          {formatTokens(totals.input)}
        </span>{' '}
        <span className="inline-flex items-baseline gap-0.5">
          <TokenDownIcon />
          {formatTokens(totals.output)}
        </span>{' '}
        <span className="inline-flex items-baseline gap-0.5">
          <CacheIcon />
          {formatTokens(totals.cacheRead + totals.cacheWrite)}
        </span>{' '}
        · {formatCost(totals.cost, totals.costEstimate)} ·{' '}
        {totals.wallMs === null ? '—' : formatDuration(totals.wallMs)}
      </p>
      {stageGroups.length > 0 && (
        <div data-testid="stage-agents-summary" className="mb-1 space-y-0.5">
          {stageGroups.map((group) => (
            <p
              key={group.stage}
              data-testid="stage-agents-group"
              data-stage={group.stage}
              data-stage-name={group.name}
              className="text-[10px] tracking-wider text-[#00FF41]/60"
            >
              <span
                data-testid="stage-agents-name"
                className="text-[#00FF41]/80"
              >
                {group.name}
              </span>{' '}
              ·{' '}
              <span
                data-testid="stage-agents-tokens"
                className="inline-flex items-baseline gap-0.5"
              >
                <TokenUpIcon />
                {formatTokens(group.input)}
              </span>{' '}
              <span className="inline-flex items-baseline gap-0.5">
                <TokenDownIcon />
                {formatTokens(group.output)}
              </span>{' '}
              <span className="inline-flex items-baseline gap-0.5">
                <CacheIcon />
                {formatTokens(group.cacheRead + group.cacheWrite)}
              </span>{' '}
              ·{' '}
              <span data-testid="stage-agents-cost">
                {formatCost(group.cost, group.costEstimate)}
              </span>{' '}
              ·{' '}
              <span data-testid="stage-agents-duration">
                {group.wallMs === null ? '—' : formatDuration(group.wallMs)}
              </span>{' '}
              ·{' '}
              <span data-testid="stage-agents-models">
                {group.models.length > 0 ? group.models.join(', ') : '—'}
              </span>
              {group.contextPercent !== null && (
                <>
                  {' '}
                  ·{' '}
                  <span data-testid="stage-agents-context">
                    CTX {Math.round(group.contextPercent)}%
                  </span>
                </>
              )}
            </p>
          ))}
        </div>
      )}
    </>
  );
}