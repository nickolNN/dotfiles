import { useEffect, useState, type FormEvent } from 'react';
import type { SavedRepo, Tag } from '@issue-resolver/shared';
import {
  useCreateTag,
  useDeleteTag,
  useSavedRepos,
  useTags,
  useUpdateTag,
} from '../stores/queries';
import QueryBoundary from '../components/QueryBoundary';

const inputClass =
  'w-full rounded-none border border-[#008F11] bg-[#0D0208] px-3 py-2 text-sm text-[#00FF41] outline-none placeholder:text-[#008F11] focus:border-[#00FF41] focus:shadow-[0_0_8px_rgba(0,255,65,0.35)]';
const labelClass = 'mb-1 block text-sm font-medium text-[#00FF41]/80';

const btnPrimary =
  'min-h-12 rounded-none border border-[#00FF41] bg-[#003B00] px-4 py-2 text-sm font-medium text-[#00FF41] hover:bg-[#00FF41] hover:text-[#0D0208] disabled:opacity-50';
const btnSecondary =
  'min-h-12 rounded-none border border-[#008F11] px-4 py-2 text-sm font-medium text-[#00FF41]/80 hover:bg-[#008F11]/20 hover:text-[#00FF41] disabled:opacity-50';

function PencilIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
    </svg>
  );
}

function TrashIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M4 7h16" />
      <path d="M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
      <path d="M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12" />
      <path d="M10 11v6M14 11v6" />
    </svg>
  );
}

interface TagRepoDraft {
  repository_id: string;
  bootstrap_enabled: boolean;
}

interface TagDraft {
  name: string;
  description: string;
  run_instructions: string;
  repositories: TagRepoDraft[];
}

type FormState =
  | { mode: 'create' }
  | { mode: 'edit'; tag: Tag }
  | null;

interface TagsProps {
  createSignal?: number;
}

function Toggle({
  checked,
  label,
  onToggle,
}: {
  checked: boolean;
  label: string;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={onToggle}
      className="flex min-h-12 items-center gap-3 text-sm font-medium text-[#00FF41]/80"
    >
      <span
        aria-hidden="true"
        className={`relative inline-flex h-6 w-11 shrink-0 items-center border transition-colors ${
          checked ? 'border-[#00FF41] bg-[#003B00]' : 'border-[#008F11] bg-[#0D0208]'
        }`}
      >
        <span
          className={`absolute h-4 w-4 transition-transform ${
            checked ? 'translate-x-6 bg-[#00FF41]' : 'translate-x-1 bg-[#008F11]'
          }`}
        />
      </span>
      {label}
    </button>
  );
}

function draftFromTag(tag: Tag): TagDraft {
  return {
    name: tag.name,
    description: tag.description ?? '',
    run_instructions: tag.run_instructions ?? '',
    repositories: tag.repositories.map((tr) => ({
      repository_id: tr.repository_id,
      bootstrap_enabled: tr.bootstrap_enabled,
    })),
  };
}

interface TagFormProps {
  initial: TagDraft;
  savedRepos: SavedRepo[];
  savedReposLoading: boolean;
  saving: boolean;
  error: string | null;
  submitLabel: string;
  onCancel: () => void;
  onSubmit: (draft: TagDraft) => void;
}

function TagForm({
  initial,
  savedRepos,
  savedReposLoading,
  saving,
  error,
  submitLabel,
  onCancel,
  onSubmit,
}: TagFormProps) {
  const [name, setName] = useState(initial.name);
  const [description, setDescription] = useState(initial.description);
  const [runInstructions, setRunInstructions] = useState(initial.run_instructions);
  const [repos, setRepos] = useState<TagRepoDraft[]>(initial.repositories);

  function toggleRepo(repoId: string) {
    setRepos((current) =>
      current.some((repo) => repo.repository_id === repoId)
        ? current.filter((repo) => repo.repository_id !== repoId)
        : [...current, { repository_id: repoId, bootstrap_enabled: true }],
    );
  }

  function toggleBootstrap(repoId: string) {
    setRepos((current) =>
      current.map((repo) =>
        repo.repository_id === repoId
          ? { ...repo, bootstrap_enabled: !repo.bootstrap_enabled }
          : repo,
      ),
    );
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!name.trim() || saving) return;
    onSubmit({ name: name.trim(), description: description.trim(), run_instructions: runInstructions.trim() || '', repositories: repos });
  }

  const selected = new Set(repos.map((repo) => repo.repository_id));

  return (
    <form
      data-testid="tag-form"
      className="space-y-3 border border-[#008F11]/40 p-3"
      onSubmit={handleSubmit}
    >
      <div>
        <label className={labelClass} htmlFor="tag-name">
          Имя
        </label>
        <input
          id="tag-name"
          data-testid="tag-name"
          className={inputClass}
          type="text"
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="Например: Frontend"
        />
      </div>

      <div>
        <label className={labelClass} htmlFor="tag-description">
          Описание
        </label>
        <textarea
          id="tag-description"
          data-testid="tag-description"
          className={inputClass}
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          placeholder="Зачем нужен этот тег"
          rows={3}
        />
      </div>

      <div>
        <label className={labelClass} htmlFor="tag-instructions">
          Run-инструкции (Markdown) — как запускать весь набор репозиториев
          вместе: прокси, порты, переменные окружения
        </label>
        <textarea
          id="tag-instructions"
          data-testid="tag-run-instructions"
          className={inputClass}
          value={runInstructions}
          onChange={(event) => setRunInstructions(event.target.value)}
          placeholder="## Прокси&#10;```bash&#10;ssh -L 4300:localhost:4300 ...&#10;```&#10;&#10;## Порты&#10;- Репо A: 5100&#10;- Репо B: 5200"
          rows={6}
        />
      </div>

      <div>
        <span className={labelClass}>Репозитории</span>
        {savedReposLoading ? (
          <p className="text-xs text-[#00FF41]/50">Загружаем репозитории…</p>
        ) : savedRepos.length === 0 ? (
          <p className="text-xs text-[#00FF41]/50">
            Нет сохранённых репозиториев — добавьте их на странице «Репозитории»
          </p>
        ) : (
          <div className="space-y-2">
            {savedRepos.map((repo) => {
              const isSelected = selected.has(repo.id);
              const draft = repos.find((item) => item.repository_id === repo.id);
              return (
                <div
                  key={repo.id}
                  className="border border-[#008F11]/30 p-2"
                >
                  <label className="flex cursor-pointer items-center gap-2 text-sm text-[#00FF41]/80">
                    <input
                      type="checkbox"
                      className="accent-[#00FF41]"
                      data-testid={`tag-repo-${repo.id}`}
                      checked={isSelected}
                      onChange={() => toggleRepo(repo.id)}
                    />
                    <span className="truncate">
                      {repo.fullName ?? repo.url}
                    </span>
                  </label>
                  {draft && (
                    <div className="mt-1 pl-6">
                      <Toggle
                        checked={draft.bootstrap_enabled}
                        label="Запустить (установка зависимостей)"
                        onToggle={() => toggleBootstrap(repo.id)}
                      />
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {error && (
        <p role="alert" className="text-sm font-medium text-[#FF0033]">
          {error}
        </p>
      )}

      <div className="flex flex-col gap-2 sm:flex-row">
        <button type="submit" className={btnPrimary} disabled={saving || !name.trim()}>
          {saving ? 'Сохраняем…' : submitLabel}
        </button>
        <button
          type="button"
          className={btnSecondary}
          onClick={onCancel}
          disabled={saving}
        >
          Отмена
        </button>
      </div>
    </form>
  );
}

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
      setFormError(err instanceof Error ? err.message : String(err));
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
    if (!window.confirm(`Удалить тег «${tag.name}»?`)) return;
    setBusyId(tag.id);
    setNotice(null);
    deleteMutation.mutate(tag.id, {
      onError: (err) =>
        setNotice(err instanceof Error ? err.message : String(err)),
      onSettled: () => setBusyId(null),
    });
  }

  return (
    <div data-testid="tags-page" className="mx-auto max-w-4xl py-4">
      {notice && (
        <p
          data-testid="tag-notice"
          role="status"
          className="mb-3 border border-[#FFB000] px-3 py-2 text-sm text-[#FFB000]"
        >
          {notice}
        </p>
      )}

      {form?.mode === 'create' && (
        <div className="mb-4">
          <TagForm
            initial={{ name: '', description: '', run_instructions: '', repositories: [] }}
            savedRepos={savedRepos}
            savedReposLoading={savedReposLoading}
            saving={saving}
            error={formError}
            submitLabel="Создать тег"
            onCancel={() => setForm(null)}
            onSubmit={(draft) => void handleSave(draft)}
          />
        </div>
      )}

      {isLoading && (
        <p className="text-sm text-[#00FF41]/60">Загружаем теги…</p>
      )}

      {error && !isLoading && (
        <div className="space-y-2">
          <p role="alert" className="text-sm font-medium text-[#FF0033]">
            {error instanceof Error ? error.message : String(error)}
          </p>
          <button
            type="button"
            className={btnSecondary}
            onClick={() => void refetch()}
          >
            Повторить
          </button>
        </div>
      )}

      {!isLoading && !error && tags.length === 0 && (
        <p data-testid="tag-list-empty" className="text-sm text-[#00FF41]/50">
          Пока нет тегов. Создайте первый.
        </p>
      )}

      {!isLoading && !error && tags.length > 0 && (
        <ul className="space-y-2">
          {tags.map((tag) => {
            const busy = busyId === tag.id;
            const expanded = expandedId === tag.id;
            if (form?.mode === 'edit' && form.tag.id === tag.id) {
              return (
                <li key={tag.id}>
                  <TagForm
                    initial={draftFromTag(tag)}
                    savedRepos={savedRepos}
                    savedReposLoading={savedReposLoading}
                    saving={saving}
                    error={formError}
                    submitLabel="Сохранить"
                    onCancel={() => setForm(null)}
                    onSubmit={(draft) => void handleSave(draft)}
                  />
                </li>
              );
            }
            return (
              <li
                key={tag.id}
                data-testid="tag-card"
                className="border border-[#008F11]/20 p-2.5"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div
                      data-testid="tag-name-label"
                      className="truncate text-sm font-bold text-[#00FF41]"
                    >
                      {tag.name}
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <button
                      type="button"
                      data-testid="tag-edit"
                      aria-label="Редактировать тег"
                      title="Редактировать"
                      className="min-h-6 p-1 text-[#008F11]/60 transition-base hover:bg-transparent hover:text-[#00FF41] focus-visible:text-[#00FF41]"
                      onClick={() => openEdit(tag)}
                      disabled={busy}
                    >
                      <PencilIcon className="h-4 w-4" />
                    </button>
                    <button
                      type="button"
                      data-testid="tag-delete"
                      aria-label="Удалить тег"
                      title="Удалить"
                      className="min-h-6 p-1 text-[#008F11]/60 transition-base hover:bg-transparent hover:text-[#FF0033] focus-visible:text-[#FF0033]"
                      onClick={() => void handleDelete(tag)}
                      disabled={busy}
                    >
                      <TrashIcon className="h-4 w-4" />
                    </button>
                  </div>
                </div>

                {tag.description && (
                  <div
                    data-testid="tag-description-label"
                    className="mt-0.5 text-xs text-[#00FF41]/50"
                  >
                    {tag.description}
                  </div>
                )}

                {tag.run_instructions && (
                  <div
                    data-testid="tag-instructions-label"
                    className="mt-0.5 text-xs text-[#00FF41]/60"
                  >
                    инструкции: {tag.run_instructions_status === 'generated' ? '✅' : '⏳'} ({tag.run_instructions.length} симв.)
                  </div>
                )}

                {tag.repositories.length > 0 && (
                  <div className="mt-1">
                    <button
                      type="button"
                      data-testid="tag-repositories-toggle"
                      className="text-xs font-medium text-[#008F11] underline hover:text-[#00FF41]"
                      aria-expanded={expanded}
                      onClick={() => setExpandedId(expanded ? null : tag.id)}
                    >
                      {expanded ? '▾' : '▸'} Репозитории ({tag.repositories.length})
                    </button>
                    {expanded && (
                      <ul className="mt-1 space-y-1">
                        {tag.repositories.map((tr) => (
                          <li
                            key={tr.id}
                            data-testid="tag-repository"
                            className="border border-[#008F11]/20 px-2 py-1 text-xs text-[#00FF41]/70"
                          >
                            <div className="truncate">
                              {tr.repository.fullName ?? tr.repository.url}
                            </div>
                            <div className="text-[10px] text-[#00FF41]/40">
                              bootstrap:{' '}
                              {tr.bootstrap_enabled ? 'включён' : 'выключен'}
                            </div>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}