import { useCallback, useEffect, useState } from 'react';
import { fetchMergeRequests, type MergeRequestInfo } from '../api/client';

export interface UseMergeRequestsResult {
  mergeRequests: MergeRequestInfo[];
  loading: boolean;
  error: string | null;
  /** Принудительная перезагрузка списка (после создания новой итерации и т.п.). */
  reload: () => void;
}

/**
 * Список MR/PR задачи (`GET /issues/:id/merge-requests`). Сеть best-effort:
 * ошибка не роняет страницу — карточки репозиториев просто не покажут MR.
 *
 * `refreshKey` позволяет родителю дёрнуть перезагрузку вместе с остальными
 * данными (например, по `refreshTick` после старта новой итерации).
 */
export function useMergeRequests(
  issueId: string | null | undefined,
  refreshKey: number = 0,
): UseMergeRequestsResult {
  const [mergeRequests, setMergeRequests] = useState<MergeRequestInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reloadTick, setReloadTick] = useState(0);

  const reload = useCallback(() => setReloadTick((tick) => tick + 1), []);

  useEffect(() => {
    if (!issueId) {
      setMergeRequests([]);
      setLoading(false);
      setError(null);
      return;
    }

    let cancelled = false;
    setLoading(true);

    fetchMergeRequests(issueId)
      .then((list) => {
        if (cancelled) return;
        setMergeRequests(list);
        setError(null);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setMergeRequests([]);
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [issueId, refreshKey, reloadTick]);

  return { mergeRequests, loading, error, reload };
}