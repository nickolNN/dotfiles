import { messageOf } from './errors';

export const AsyncStateStatus = Object.freeze({
  empty: 'empty',
  loading: 'loading',
  error: 'error',
  ready: 'ready',
} as const);
export type AsyncStateStatus =
  (typeof AsyncStateStatus)[keyof typeof AsyncStateStatus];

export type AsyncState<T> =
  | { status: typeof AsyncStateStatus.empty }
  | { status: typeof AsyncStateStatus.loading }
  | { status: typeof AsyncStateStatus.error; message: string }
  | { status: typeof AsyncStateStatus.ready; data: T };

export function errorState(error: unknown): AsyncState<never> {
  return { status: AsyncStateStatus.error, message: messageOf(error) };
}

export function collectionState<T>(
  query: { isLoading: boolean; error: unknown },
  items: T[] | undefined,
): AsyncState<T[]> {
  if (query.isLoading) return { status: AsyncStateStatus.loading };
  if (query.error) return errorState(query.error);
  const rows = items ?? [];
  return rows.length === 0
    ? { status: AsyncStateStatus.empty }
    : { status: AsyncStateStatus.ready, data: rows };
}