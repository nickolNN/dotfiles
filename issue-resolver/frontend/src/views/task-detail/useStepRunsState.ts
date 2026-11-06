import { useEffect } from "react";
import { messageOf } from "../../lib/errors";
import { useStepRuns } from "../../stores/queries";
import { useInvalidateOnTick } from "./useInvalidateOnTick";
import type { StepRunsState } from "./types";
import { AsyncStateStatus } from '../../lib/async-state';

interface UseStepRunsStateInput {
  activeIterationId: string | null;
  refreshTick: number;
  resetLiveStatus: () => void;
}

export function useStepRunsState({
  activeIterationId,
  refreshTick,
  resetLiveStatus,
}: UseStepRunsStateInput): StepRunsState {
  const stepRunsQuery = useStepRuns(activeIterationId);

  useEffect(() => {
    resetLiveStatus();
  }, [activeIterationId]);

  useInvalidateOnTick(refreshTick, activeIterationId, "step-runs");

  if (!activeIterationId) return { status: AsyncStateStatus.empty };
  if (stepRunsQuery.isLoading) return { status: AsyncStateStatus.loading };
  if (stepRunsQuery.isError) {
    return {
      status: AsyncStateStatus.error,
      message: messageOf(stepRunsQuery.error),
    };
  }
  const rows = Array.isArray(stepRunsQuery.data) ? stepRunsQuery.data : [];
  return rows.length === 0
    ? { status: AsyncStateStatus.empty }
    : { status: AsyncStateStatus.ready, data: rows };
}

