import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { RepoConnectionStatus, type SavedRepo } from '@issue-resolver/shared';

import { saveRepositoryCredentials, validateRepository } from '../api/client';
import {
  useCreateRepository,
  useDeleteRepository,
  useRepositories,
  useUpdateRepository,
  writeRepositoryToCache,
} from '../stores/queries';
import CollectionState from '../components/CollectionState';
import PageNotice from '../components/PageNotice';
import QueryBoundary from '../components/QueryBoundary';
import { collectionState, type AsyncState } from '../lib/async-state';
import { deleteWithNotice } from '../lib/delete-with-notice';
import { messageOf } from '../lib/errors';
import RepositoryCard from './repositories/RepositoryCard';
import RepoFormDialog from './repositories/RepoFormDialog';
import type { DialogState, RepositoriesProps } from './repositories/types';

export type { RepositoriesProps } from './repositories/types';

export default function Repositories(props: RepositoriesProps) {
  return (
    <QueryBoundary>
      <RepositoriesView {...props} />
    </QueryBoundary>
  );
}

function RepositoriesView({ createSignal }: RepositoriesProps) {
  const queryClient = useQueryClient();
  const { data, isLoading, error, refetch } = useRepositories();
  const repos = Array.isArray(data) ? data : [];
  const listState: AsyncState<SavedRepo[]> = collectionState(
    { isLoading, error },
    repos,
  );

  const createMutation = useCreateRepository();
  const updateMutation = useUpdateRepository();
  const deleteMutation = useDeleteRepository();

  const [dialog, setDialog] = useState<DialogState | null>(null);
  const [dialogError, setDialogError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const saving = createMutation.isPending || updateMutation.isPending;

  const requestDelete = deleteWithNotice({
    mutation: deleteMutation,
    setBusyId,
    setNotice,
  });

  useEffect(() => {
    if (createSignal && createSignal > 0) openCreate();
  }, [createSignal]);

  function openCreate() {
    setDialogError(null);
    setDialog({ mode: 'create' });
  }

  function openEdit(repo: SavedRepo) {
    setDialogError(null);
    setDialog({ mode: 'edit', repo });
  }

  function finishSave(repo: SavedRepo) {
    setDialog(null);
    setNotice(
      repo.connectionStatus === RepoConnectionStatus.ok
        ? null
        : `Репозиторий ${repo.url} сохранён, но соединение не подтверждено`,
    );
  }

  function handleSave(url: string) {
    setDialogError(null);
    const onError = (err: unknown) =>
      setDialogError(messageOf(err));
    if (dialog?.mode === 'edit') {
      updateMutation.mutate(
        { id: dialog.repo.id, url },
        { onSuccess: finishSave, onError },
      );
    } else {
      createMutation.mutate(url, { onSuccess: finishSave, onError });
    }
  }

  async function handleValidate(repo: SavedRepo) {
    setBusyId(repo.id);
    setNotice(null);
    try {
      const saved = await validateRepository(repo.id);
      writeRepositoryToCache(queryClient, saved);
    } catch (err) {
      setNotice(messageOf(err));
    } finally {
      setBusyId(null);
    }
  }

  async function handleSaveCredentials(repo: SavedRepo, value: string) {
    setBusyId(repo.id);
    setNotice(null);
    try {
      const trimmed = value.trim();
      const saved = await saveRepositoryCredentials(
        repo.id,
        trimmed === '' ? null : value,
      );
      writeRepositoryToCache(queryClient, saved);
    } catch (err) {
      setNotice(messageOf(err));
    } finally {
      setBusyId(null);
    }
  }

  function handleDelete(repo: SavedRepo) {
    requestDelete(repo.id, `Удалить репозиторий ${repo.url}?`);
  }

  return (
    <div data-testid="repositories-page" className="mx-auto max-w-4xl py-4">
      {notice && (
        <PageNotice testId="repo-notice">{notice}</PageNotice>
      )}

      <CollectionState
        state={listState}
        onRetry={() => void refetch()}
        loadingText="Загружаем репозитории…"
        empty={
          <p data-testid="repo-list-empty" className="text-sm text-[#00FF41]/50">
            Пока нет сохранённых репозиториев. Добавьте первый.
          </p>
        }
      >
        {(rows) => (
          <ul className="grid grid-cols-1 gap-2">
            {rows.map((repo, index) => (
              <RepositoryCard
                key={repo.id}
                repo={repo}
                index={index}
                busy={busyId === repo.id}
                onValidate={() => void handleValidate(repo)}
                onEdit={() => openEdit(repo)}
                onDelete={() => void handleDelete(repo)}
                onSaveCredentials={(value) =>
                  void handleSaveCredentials(repo, value)
                }
              />
            ))}
          </ul>
        )}
      </CollectionState>

      {dialog && (
        <RepoFormDialog
          title={
            dialog.mode === 'edit'
              ? 'Редактировать репозиторий'
              : 'Добавить репозиторий'
          }
          initialUrl={dialog.mode === 'edit' ? dialog.repo.url : ''}
          saving={saving}
          error={dialogError}
          onCancel={() => setDialog(null)}
          onSubmit={(url) => void handleSave(url)}
        />
      )}
    </div>
  );
}