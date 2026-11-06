import { useEffect, useState } from 'react';
import type { Tag } from '@issue-resolver/shared';
import {
  useCreateTag,
  useDeleteTag,
  useSavedRepos,
  useTags,
  useUpdateTag,
} from '../stores/queries';
import CollectionState from '../components/CollectionState';
import PageNotice from '../components/PageNotice';
import QueryBoundary from '../components/QueryBoundary';
import { collectionState, type AsyncState } from '../lib/async-state';
import { deleteWithNotice } from '../lib/delete-with-notice';
import { messageOf } from '../lib/errors';
import TagCard from './tags/TagCard';
import TagForm from './tags/TagForm';
import { draftFromTag } from './tags/draft';
import type { FormState, TagDraft, TagsProps } from './tags/types';

export type { TagsProps } from './tags/types';

export default function Tags(props: TagsProps) {
  return (
    <QueryBoundary>
      <TagsView {...props} />
    </QueryBoundary>
  );
}

function TagsView({ createSignal }: TagsProps) {
  const { data, isLoading, error, refetch } = useTags();
  const tags = Array.isArray(data) ? data : [];
  const listState: AsyncState<Tag[]> = collectionState(
    { isLoading, error },
    tags,
  );
  const { data: savedReposData, isLoading: savedReposLoading } = useSavedRepos();
  const savedRepos = Array.isArray(savedReposData) ? savedReposData : [];

  const createMutation = useCreateTag();
  const updateMutation = useUpdateTag();
  const deleteMutation = useDeleteTag();

  const [form, setForm] = useState<FormState>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const saving = createMutation.isPending || updateMutation.isPending;

  const requestDelete = deleteWithNotice({
    mutation: deleteMutation,
    setBusyId,
    setNotice,
  });

  useEffect(() => {
    if (createSignal && createSignal > 0) {
      setFormError(null);
      setForm({ mode: 'create' });
    }
  }, [createSignal]);

  function openEdit(tag: Tag) {
    setFormError(null);
    setNotice(null);
    setForm({ mode: 'edit', tag });
  }

  function handleSave(draft: TagDraft) {
    if (!form) return;
    setFormError(null);
    const payload = {
      name: draft.name,
      description: draft.description || undefined,
      run_instructions: draft.run_instructions || undefined,
      repositories: draft.repositories,
    };
    const onSuccess = () => setForm(null);
    const onError = (err: unknown) =>
      setFormError(messageOf(err));
    if (form.mode === 'edit') {
      updateMutation.mutate(
        { id: form.tag.id, request: payload },
        { onSuccess, onError },
      );
    } else {
      createMutation.mutate(payload, { onSuccess, onError });
    }
  }

  function handleDelete(tag: Tag) {
    requestDelete(tag.id, `Удалить тег «${tag.name}»?`);
  }

  const formProps = {
    savedRepos,
    savedReposLoading,
    saving,
    error: formError,
    onCancel: () => setForm(null),
    onSubmit: (draft: TagDraft) => void handleSave(draft),
  };

  return (
    <div data-testid="tags-page" className="mx-auto max-w-4xl py-4">
      {notice && (
        <PageNotice testId="tag-notice" className="mb-3">
          {notice}
        </PageNotice>
      )}

      {form?.mode === 'create' && (
        <div className="mb-4">
          <TagForm
            {...formProps}
            initial={{
              name: '',
              description: '',
              run_instructions: '',
              repositories: [],
            }}
            submitLabel="Создать тег"
          />
        </div>
      )}

      <CollectionState
        state={listState}
        onRetry={() => void refetch()}
        loadingText="Загружаем теги…"
        empty={
          <p data-testid="tag-list-empty" className="text-sm text-[#00FF41]/50">
            Пока нет тегов. Создайте первый.
          </p>
        }
      >
        {(rows) => (
          <ul className="space-y-2">
            {rows.map((tag) => {
              const busy = busyId === tag.id;
              const expanded = expandedId === tag.id;
              if (form?.mode === 'edit' && form.tag.id === tag.id) {
                return (
                  <li key={tag.id}>
                    <TagForm
                      {...formProps}
                      initial={draftFromTag(tag)}
                      submitLabel="Сохранить"
                    />
                  </li>
                );
              }
              return (
                <TagCard
                  key={tag.id}
                  tag={tag}
                  busy={busy}
                  expanded={expanded}
                  onToggleExpanded={() =>
                    setExpandedId(expanded ? null : tag.id)
                  }
                  onEdit={() => openEdit(tag)}
                  onDelete={() => void handleDelete(tag)}
                />
              );
            })}
          </ul>
        )}
      </CollectionState>
    </div>
  );
}