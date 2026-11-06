import { useCallback, useEffect, useRef, useState } from 'react';
import { IssueDeletingPhase } from '@issue-resolver/shared';
import { deleteIssue } from '../../api/client';
import { DELETE_TIMEOUT_MS, subscribeToIssueEvents } from '../../api/sse';
import { messageOf } from '../../lib/errors';
import { DELETE_TIMEOUT_MESSAGE } from './constants';

interface IssueDelete {
  deletingIds: Set<string>;
  deletingPhases: Record<string, IssueDeletingPhase>;
  timeoutNotice: string | null;
  error: string | null;
  removeIssue: (issueId: string) => Promise<void>;
}

export function useIssueDelete(
  onRemoved: (issueId: string) => void,
): IssueDelete {
  const [error, setError] = useState<string | null>(null);
  const [timeoutNotice, setTimeoutNotice] = useState<string | null>(null);
  const [deletingIds, setDeletingIds] = useState<Set<string>>(() => new Set());
  const [deletingPhases, setDeletingPhases] = useState<
    Record<string, IssueDeletingPhase>
  >({});
  const streamsRef = useRef<Map<string, () => void>>(new Map());
  const timeoutsRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(
    new Map(),
  );

  useEffect(() => {
    const streams = streamsRef.current;
    const timeouts = timeoutsRef.current;
    return () => {
      for (const unsubscribe of streams.values()) unsubscribe();
      streams.clear();
      for (const timer of timeouts.values()) clearTimeout(timer);
      timeouts.clear();
    };
  }, []);

  const stopStream = useCallback((issueId: string) => {
    const unsubscribe = streamsRef.current.get(issueId);
    if (!unsubscribe) return;
    unsubscribe();
    streamsRef.current.delete(issueId);
  }, []);

  const clearTimeoutFor = useCallback((issueId: string) => {
    const timer = timeoutsRef.current.get(issueId);
    if (timer === undefined) return;
    clearTimeout(timer);
    timeoutsRef.current.delete(issueId);
  }, []);

  const clearDeleting = useCallback(
    (issueId: string) => {
      clearTimeoutFor(issueId);
      setDeletingIds((current) => {
        if (!current.has(issueId)) return current;
        const next = new Set(current);
        next.delete(issueId);
        return next;
      });
      setDeletingPhases((current) => {
        if (!(issueId in current)) return current;
        const next = { ...current };
        delete next[issueId];
        return next;
      });
    },
    [clearTimeoutFor],
  );

  const removeIssue = useCallback(
    async (issueId: string) => {
      if (!window.confirm('Удалить задачу и всю её рабочую папку?')) return;

      setError(null);
      setTimeoutNotice(null);
      setDeletingIds((current) => new Set(current).add(issueId));

      clearTimeoutFor(issueId);
      timeoutsRef.current.set(
        issueId,
        setTimeout(() => {
          timeoutsRef.current.delete(issueId);
          clearDeleting(issueId);
          setTimeoutNotice(DELETE_TIMEOUT_MESSAGE);
        }, DELETE_TIMEOUT_MS),
      );

      if (!streamsRef.current.has(issueId)) {
        const unsubscribe = subscribeToIssueEvents(issueId, {
          onIssueDeleting: (payload) => {
            if (payload.phase === IssueDeletingPhase.error) {
              stopStream(payload.issueId);
              clearDeleting(payload.issueId);
              setError(payload.message ?? 'Не удалось удалить задачу');
              return;
            }
            setDeletingPhases((current) => ({
              ...current,
              [payload.issueId]: payload.phase,
            }));
          },
          onIssueDeleted: (payload) => {
            stopStream(payload.issueId);
            clearDeleting(payload.issueId);
            onRemoved(payload.issueId);
          },
        });
        streamsRef.current.set(issueId, unsubscribe);
      }

      try {
        await deleteIssue(issueId);
      } catch (caught: unknown) {
        stopStream(issueId);
        clearDeleting(issueId);
        setError(messageOf(caught));
      }
    },
    [clearDeleting, clearTimeoutFor, onRemoved, stopStream],
  );

  return {
    deletingIds,
    deletingPhases,
    timeoutNotice,
    error,
    removeIssue,
  };
}