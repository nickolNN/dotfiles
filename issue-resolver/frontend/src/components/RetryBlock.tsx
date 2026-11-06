import { messageOf } from '../lib/errors';
import { btnSecondary } from './buttonStyles';
import FormError from './FormError';

export default function RetryBlock({
  error,
  onRetry,
}: {
  error: unknown;
  onRetry: () => void;
}) {
  return (
    <div className="space-y-2">
      <FormError message={messageOf(error)} />
      <button type="button" className={btnSecondary} onClick={onRetry}>
        Повторить
      </button>
    </div>
  );
}