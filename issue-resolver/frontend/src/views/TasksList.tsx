import { useCallback, useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { TaskStatus, type Issue } from '@issue-resolver/shared';

import { getIssues, stopDevServers } from '../api/client';
import DeleteTimeoutNotice from '../components/DeleteTimeoutNotice';
import CollectionState from '../components/CollectionState';
import QueryBoundary from '../components/QueryBoundary';
import { messageOf } from '../lib/errors';
import { AsyncStateStatus, collectionState } from '../lib/async-state';
import { queryKeys } from '../lib/query-keys';
import { useRepositories } from '../stores/queries';
import { useNow } from '../lib/time';
import { showsRepoReadiness } from './tasks-list/format';
import TaskCard from './tasks-list/TaskCard';
import type {
  CardActions,
  IssueWithActiveStep,
  LoadState,
  TasksListProps,
} from './tasks-list/types';
import { useIssueDelete } from './tasks-list/useIssueDelete';
import { useIssueProgress } from './tasks-list/useIssueProgress';

export type { TasksListProps } from './tasks-list/types';

export default function TasksList(props: TasksListProps) {
  return (
    <QueryBoundary>
      <TasksListView {...props} />
    </QueryBoundary>
  );
}

function TasksListView({ onOpenTask, onOpenResult }: TasksListProps) {
  const queryClient = useQueryClient();

  const {
    data: fetchedIssues,
    isLoading: issuesLoading,
    error: issuesFetchError,
    refetch,
  } = useQuery({ queryKey: queryKeys.issues, queryFn: getIssues });

  const [localIssues, setLocalIssues] = useState<IssueWithActiveStep[]>([]);

  useEffect(() => {
    if (fetchedIssues) setLocalIssues(fetchedIssues);
  }, [fetchedIssues]);

  const state: LoadState = collectionState(
    { isLoading: issuesLoading, error: issuesFetchError },
    localIssues,
  );

  useIssueProgress(setLocalIssues);

  const removeFromList = useCallback(
    (issueId: string) => {
      setLocalIssues((current) =>
        current.filter((issue) => issue.id !== issueId),
      );
      queryClient.setQueryData<Issue[]>(queryKeys.issues, (current) =>
        current ? current.filter((issue) => issue.id !== issueId) : current,
      );
    },
    [queryClient],
  );

  const {
    deletingIds,
    deletingPhases,
    timeoutNotice: deleteTimeoutNotice,
    error: deleteError,
    removeIssue,
  } = useIssueDelete(removeFromList);

  const [stopError, setStopError] = useState<string | null>(null);

  const now = useNow(
    state.status === AsyncStateStatus.ready &&
      state.data.some((issue) => issue.status === TaskStatus.running),
  );

  const needsRepoReadiness =
    state.status === AsyncStateStatus.ready && state.data.some(showsRepoReadiness);

  const { data: savedRepos = null } = useRepositories(needsRepoReadiness);

  const handleStopDevServers = useCallback(async (issueId: string) => {
    setStopError(null);
    try {
      await stopDevServers(issueId);
      setLocalIssues((current) =>
        current.map((issue) =>
          issue.id === issueId ? { ...issue, dev_server_port: null } : issue,
        ),
      );
    } catch (error: unknown) {
      setStopError(messageOf(error));
    }
  }, []);

  const actions = useMemo<CardActions>(
    () => ({
      open: (issueId) => onOpenTask?.(issueId),
      openResult: (issueId) => onOpenResult?.(issueId),
      remove: (issueId) => {
        void removeIssue(issueId);
      },
      stopDevServers: (issueId) => {
        void handleStopDevServers(issueId);
      },
    }),
    [handleStopDevServers, onOpenResult, onOpenTask, removeIssue],
  );

  return (
    <div className="mx-auto max-w-4xl">
      <div className="py-4">
        {deleteError && (
          <p role="alert" className="mb-4 text-sm font-medium text-[#FF0033]">
            Не удалось удалить задачу: {deleteError}
          </p>
        )}

        <DeleteTimeoutNotice message={deleteTimeoutNotice} />

        {stopError && (
          <p role="alert" className="mb-4 text-sm font-medium text-[#FF0033]">
            Не удалось остановить dev-серверы: {stopError}
          </p>
        )}

        <CollectionState
          state={state}
          onRetry={() => void refetch()}
          loadingText="Загрузка…"
          empty={
            <div className="rounded-none border border-dashed border-[#008F11] p-8 text-center text-sm text-[#00FF41]/60">
              Пока нет ни одной задачи.
            </div>
          }
        >
          {(issues) => (
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              {issues.map((issue, index) => (
                <TaskCard
                  key={issue.id}
                  issue={issue}
                  index={index}
                  savedRepos={savedRepos}
                  now={now}
                  deleting={deletingIds.has(issue.id)}
                  deletingPhase={deletingPhases[issue.id]}
                  actions={actions}
                />
              ))}
            </div>
          )}
        </CollectionState>
      </div>
    </div>
  );
}