import type { Iteration } from "@issue-resolver/shared";
import type { LoadState } from "./types";
import { AsyncStateStatus } from '../../lib/async-state';

export function withIterations(
  state: LoadState,
  iterations: Iteration[],
): LoadState {
  if (state.status !== AsyncStateStatus.ready) return state;
  return {
    ...state,
    data: {
      ...state.data,
      iterations: [...iterations].sort((a, b) => a.number - b.number),
    },
  };
}