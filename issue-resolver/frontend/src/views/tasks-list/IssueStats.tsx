import { useEffect, useState } from 'react';
import {
  TaskStatus,
  type Issue,
  type Iteration,
  type StepRunWithLog,
} from '@issue-resolver/shared';
import { getIterations, getStepRuns } from '../../api/client';
import { formatAvgSpeed, formatTokens } from '../../lib/format';
import { formatDuration, sumStepRunWorkMs } from '../../lib/time';
import { AsyncStateStatus, errorState } from '../../lib/async-state';
import type { IssueStatsData, IssueStatsState } from './types';

interface IssueStatsNumbers {
  tokensInput: number;
  tokensOutput: number;
  tokensCache: number;
  hasTokenStats: boolean;
  avgSpeed: number | null;
}

function latestIteration(iterations: Iteration[]): Iteration | null {
  return iterations.reduce<Iteration | null>(
    (latest, iteration) =>
      latest === null || iteration.number > latest.number ? iteration : latest,
    null,
  );
}

function statsOfCompletedRun(
  runs: StepRunWithLog[],
  iteration: Iteration | null,
): IssueStatsNumbers {
  const numbers: IssueStatsNumbers = {
    tokensInput: 0,
    tokensOutput: 0,
    tokensCache: 0,
    hasTokenStats: false,
    avgSpeed: null,
  };
  const speeds: number[] = [];

  for (const run of runs) {
    if (run.iteration_id !== iteration?.id) continue;
    const stats = run.stats;
    if (!stats) continue;
    numbers.hasTokenStats = true;
    numbers.tokensInput += stats.tokens?.input ?? 0;
    numbers.tokensOutput += stats.tokens?.output ?? 0;
    numbers.tokensCache +=
      (stats.tokens?.cacheRead ?? 0) + (stats.tokens?.cacheWrite ?? 0);
    if (typeof stats.avgTokensPerSecond === 'number') {
      speeds.push(stats.avgTokensPerSecond);
    }
  }

  numbers.avgSpeed =
    speeds.length > 0
      ? speeds.reduce((sum, speed) => sum + speed, 0) / speeds.length
      : null;
  return numbers;
}

async function loadIssueStats(
  issueId: string,
  status: TaskStatus,
): Promise<IssueStatsData> {
  const iterations = await getIterations(issueId);
  const lastIteration = latestIteration(iterations);

  let runs: StepRunWithLog[] | null = null;
  let numbers: IssueStatsNumbers = {
    tokensInput: 0,
    tokensOutput: 0,
    tokensCache: 0,
    hasTokenStats: false,
    avgSpeed: null,
  };

  if (
    status === TaskStatus.running ||
    status === TaskStatus.completed
  ) {
    const batches = await Promise.all(
      iterations.map((iteration) => getStepRuns(iteration.id)),
    );
    runs = batches.flat();

    if (
      status === TaskStatus.completed &&
      lastIteration?.status === TaskStatus.completed
    ) {
      numbers = statsOfCompletedRun(runs, lastIteration);
    }
  }

  return {
    iterations: iterations.length,
    runs,
    ...numbers,
  };
}

function TokensInline(data: IssueStatsData) {
  if (!data.hasTokenStats) return null;
  return (
    <>
      <span
        aria-label={`${formatTokens(data.tokensInput)} входящих токенов`}
        title={`${formatTokens(data.tokensInput)} входящих`}
      >
        ↓{formatTokens(data.tokensInput)}
      </span>{' '}
      <span
        aria-label={`${formatTokens(data.tokensOutput)} исходящих токенов`}
        title={`${formatTokens(data.tokensOutput)} исходящих`}
      >
        ↑{formatTokens(data.tokensOutput)}
      </span>{' '}
      <span
        aria-label={`${formatTokens(data.tokensCache)} кеш-токенов`}
        title={`${formatTokens(data.tokensCache)} кеш`}
      >
        ⤓{formatTokens(data.tokensCache)}
      </span>
    </>
  );
}

export default function IssueStats({
  issue,
  now,
  activeStep,
  activeModel,
}: {
  issue: Issue;
  now: number;
  activeStep?: string;
  activeModel?: string | null;
}) {
  const [state, setState] = useState<IssueStatsState>({ status: AsyncStateStatus.loading });

  useEffect(() => {
    let cancelled = false;
    setState({ status: AsyncStateStatus.loading });

    void (async () => {
      try {
        const data = await loadIssueStats(issue.id, issue.status);
        if (!cancelled) setState({ status: AsyncStateStatus.ready, data });
      } catch (error: unknown) {
        if (!cancelled) setState(errorState(error));
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [issue.id, issue.status]);

  if (state.status === AsyncStateStatus.loading) {
    return (
      <span
        data-testid="issue-stats"
        className="whitespace-nowrap text-[#00FF41]/40"
      >
        Загрузка статистики…
      </span>
    );
  }

  if (state.status === AsyncStateStatus.error) return null;

  if (state.status !== AsyncStateStatus.ready) return null;

  const workMs = sumStepRunWorkMs(state.data.runs, Math.max(now, Date.now()));
  const workTime = workMs === null ? '' : formatDuration(workMs);

  return (
    <>
      {workTime && (
        <span data-testid="issue-timer" className="whitespace-nowrap">
          ⏱ {workTime}
        </span>
      )}
      {activeStep && (
        <span
          data-testid="active-step"
          className="whitespace-nowrap font-mono text-xs text-[#00FF41]/70"
        >
          {activeStep}
          {activeModel ? ` · ${activeModel}` : ''}
        </span>
      )}
      <span data-testid="issue-stats" className="whitespace-nowrap">
        {workTime ? '· ' : ''}↻ {state.data.iterations}{' '}
        <TokensInline {...state.data} />
        {state.data.avgSpeed != null && (
          <>{' '}· ⚡{formatAvgSpeed(state.data.avgSpeed)} t/s</>
        )}
      </span>
    </>
  );
}