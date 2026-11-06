import type { ReactNode } from 'react';
import { AsyncStateStatus, type AsyncState } from '../lib/async-state';
import RetryBlock from './RetryBlock';
import FormError from './FormError';

interface CollectionStateProps<T> {
  state: AsyncState<T>;
  onRetry?: () => void;
  loadingText: string;
  loadingTestId?: string;
  loadingClassName?: string;
  renderError?: (message: string) => ReactNode;
  empty?: ReactNode;
  children: (data: T) => ReactNode;
}

const DEFAULT_LOADING_CLASS = 'text-sm text-[#00FF41]/60';

export default function CollectionState<T>({
  state,
  onRetry,
  loadingText,
  loadingTestId,
  loadingClassName = DEFAULT_LOADING_CLASS,
  renderError,
  empty,
  children,
}: CollectionStateProps<T>) {
  if (state.status === AsyncStateStatus.loading) {
    return (
      <p data-testid={loadingTestId} className={loadingClassName}>
        {loadingText}
      </p>
    );
  }

  if (state.status === AsyncStateStatus.error) {
    if (renderError) return <>{renderError(state.message)}</>;
    if (onRetry) return <RetryBlock error={state.message} onRetry={onRetry} />;
    return (
      <FormError message={state.message} />
    );
  }

  if (state.status === AsyncStateStatus.empty) return <>{empty}</>;

  return <>{children(state.data)}</>;
}