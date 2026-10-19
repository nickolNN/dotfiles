import { useEffect, useState, type FormEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  extractRepoNameFromUrl,
  formatRelativeTime,
  type RepoConnectionStatus,
  type RepoInfo,
  type SavedRepo,
} from '@issue-resolver/shared';
import { validateRepository } from '../api/client';
import {
  useCreateRepository,
  useDeleteRepository,
  useRepositories,
  useUpdateRepository,
  writeRepositoryToCache,
} from '../stores/queries';
import QueryBoundary from '../components/QueryBoundary';
import RepoUrlInput, {
  PLATFORM_CHIP_CLASSES,
  PLATFORM_LABELS,
} from '../components/RepoUrlInput';

const btnPrimary =
  'min-h-12 rounded-none border border-[#00FF41] bg-[#003B00] px-4 py-2 text-sm font-medium text-[#00FF41] hover:bg-[#00FF41] hover:text-[#0D0208] disabled:opacity-50';
const btnSecondary =
  'min-h-12 rounded-none border border-[#008F11] px-4 py-2 text-sm font-medium text-[#00FF41]/80 hover:bg-[#008F11]/20 hover:text-[#00FF41] disabled:opacity-50';

/** Staggered-классы появления карточек (d1…d8, дальше — без задержки). */
const CARD_ANIMATIONS = [
  'animate-fade-in-up-d1',
  'animate-fade-in-up-d2',
  'animate-fade-in-up-d3',
  'animate-fade-in-up-d4',
  'animate-fade-in-up-d5',
  'animate-fade-in-up-d6',
  'animate-fade-in-up-d7',
  'animate-fade-in-up-d8',
] as const;

function cardAnimation(index: number): string {
  return CARD_ANIMATIONS[index] ?? 'animate-fade-in-up';
}

const STATUS_META: Record<
  RepoConnectionStatus,
  { color: string; label: string }
> = {
  ok: { color: '#00FF41', label: 'Соединение в порядке' },
  error: { color: '#FF0033', label: 'Ошибка соединения' },
  unknown: { color: '#8A8A8A', label: 'Не проверялось' },
};

/** Цветной кружок статуса соединения с tooltip. */
function StatusDot({ status }: { status: RepoConnectionStatus }) {
  const meta = STATUS_META[status];
  return (
    <span
      data-testid={`repo-status-${status}`}
      role="img"
      aria-label={meta.label}
      title={meta.label}
      className="inline-block h-3 w-3 shrink-0 rounded-full border"
      style={{ backgroundColor: meta.color, borderColor: meta.color }}
    />
  );
}

function PlatformChip({ repo }: { repo: SavedRepo }) {
  const platform = repo.platform;
  if (!platform) {
    return (
      <span className="border border-[#008F11] px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-[#00FF41]/70">
        Repo
      </span>
    );
  }
  return (
    <span
      data-testid="repo-platform"
      className={`border px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide ${PLATFORM_CHIP_CLASSES[platform]}`}
    >
      {PLATFORM_LABELS[platform]}
    </span>
  );
}

function validatedLabel(repo: SavedRepo): string {
  if (!repo.lastValidatedAt) return 'не проверялся';
  return formatRelativeTime(repo.lastValidatedAt);
}

/** Inline-иконки действий карточки, без внешних зависимостей. */
function RefreshIcon({ className }: { className?: string }) {
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
      <path d="M21 12a9 9 0 1 1-3-6.7" />
      <path d="M21 3v6h-6" />
    </svg>
  );
}

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

function BranchIcon({ className }: { className?: string }) {
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
      <path d="M6 3v12" />
      <circle cx="18" cy="6" r="3" />
      <circle cx="6" cy="18" r="3" />
      <path d="M18 9a9 9 0 0 1-9 9" />
    </svg>
  );
}

interface RepoFormDialogProps {
  title: string;
  initialUrl: string;
  saving: boolean;
  error: string | null;
  onCancel: () => void;
  onSubmit: (url: string) => void;
}

/**
 * Модалка добавления/редактирования: URL валидируется как в форме задачи
 * (`RepoUrlInput`), «Сохранить» доступна только после успешной проверки.
 */
function RepoFormDialog({
  title,
  initialUrl,
  saving,
  error,
  onCancel,
  onSubmit,
}: RepoFormDialogProps) {
  const [url, setUrl] = useState(initialUrl);
  const [valid, setValid] = useState(false);

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!valid || saving) return;
    onSubmit(url);
  }

  return (
    <div
      className="fixed inset-0 z-20 flex items-center justify-center bg-black/70 p-4"
      role="presentation"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        data-testid="repo-form"
        className="panel w-full max-w-xl space-y-4 p-5"
      >
        <h3 className="glow text-lg font-semibold text-[#00FF41]">{title}</h3>
        <form className="space-y-4" onSubmit={handleSubmit}>
          <RepoUrlInput
            id="repo-form-url"
            value={url}
            onChange={(value, info?: RepoInfo | null) => {
              setUrl(value);
              setValid(Boolean(info));
            }}
            placeholder="git@github.com:org/repo.git"
          />
          {error && (
            <p role="alert" className="text-sm font-medium text-[#FF0033]">
              {error}
            </p>
          )}
          <div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
            <button
              type="button"
              data-testid="repo-form-cancel"
              className={btnSecondary}
              onClick={onCancel}
              disabled={saving}
            >
              Отмена
            </button>
            <button
              type="submit"
              data-testid="repo-form-save"
              className={btnPrimary}
              disabled={!valid || saving}
            >
              {saving ? 'Сохраняем…' : 'Сохранить'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

type DialogState = { mode: 'create' } | { mode: 'edit'; repo: SavedRepo };

interface RepositoriesProps {
  /**
   * Внешний триггер открытия диалога добавления (значение растёт при клике
   * «+» в хедере, когда активен таб «Репозитории»).
   */
  createSignal?: number;
}

/** Страница управления сохранёнными репозиториями (CRUD + live-валидация). */
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

  const createMutation = useCreateRepository();
  const updateMutation = useUpdateRepository();
  const deleteMutation = useDeleteRepository();

  const [dialog, setDialog] = useState<DialogState | null>(null);
  const [dialogError, setDialogError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const saving = createMutation.isPending || updateMutation.isPending;

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
      repo.connectionStatus === 'ok'
        ? null
        : `Репозиторий ${repo.url} сохранён, но соединение не подтверждено`,
    );
  }

  function handleSave(url: string) {
    setDialogError(null);
    const onError = (err: unknown) =>
      setDialogError(err instanceof Error ? err.message : String(err));
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
      setNotice(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyId(null);
    }
  }

  function handleDelete(repo: SavedRepo) {
    if (!window.confirm(`Удалить репозиторий ${repo.url}?`)) return;
    setBusyId(repo.id);
    setNotice(null);
    deleteMutation.mutate(repo.id, {
      onError: (err) =>
        setNotice(err instanceof Error ? err.message : String(err)),
      onSettled: () => setBusyId(null),
    });
  }

  return (
    <div data-testid="repositories-page" className="mx-auto max-w-4xl py-4">
      {notice && (
        <p
          data-testid="repo-notice"
          role="status"
          className="border border-[#FFB000] px-3 py-2 text-sm text-[#FFB000]"
        >
          {notice}
        </p>
      )}

      {isLoading && (
        <p className="text-sm text-[#00FF41]/60">Загружаем репозитории…</p>
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

      {!isLoading && !error && repos.length === 0 && (
        <p data-testid="repo-list-empty" className="text-sm text-[#00FF41]/50">
          Пока нет сохранённых репозиториев. Добавьте первый.
        </p>
      )}

      {!isLoading && !error && repos.length > 0 && (
        <ul className="grid grid-cols-1 gap-2">
          {repos.map((repo, index) => {
            const busy = busyId === repo.id;
            return (
              <div key={repo.id} className={cardAnimation(index)}>
                <li
                  data-testid="repo-card"
                  className="cursor-pointer border border-[#008F11]/20 p-2.5 transition-base hover:bg-[#00FF41]/5"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex min-w-0 items-center gap-2">
                      <StatusDot status={repo.connectionStatus} />
                      <PlatformChip repo={repo} />
                      {!repo.writeAccess && (
                        <span
                          data-testid="repo-read-only"
                          role="img"
                          aria-label="Только чтение: нет прав на запись"
                          title="Только чтение: у токена нет прав на запись"
                          className="shrink-0 border border-[#FFB000]/60 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-[#FFB000]"
                        >
                          🔒 только чтение
                        </span>
                      )}
                      <span
                        data-testid="repo-full-name"
                        className="truncate text-sm font-bold text-[#00FF41]"
                      >
                        {repo.fullName || extractRepoNameFromUrl(repo.url) || repo.url}
                      </span>
                    </div>

                    <div className="flex shrink-0 items-center gap-0.5">
                      <button
                        type="button"
                        data-testid="repo-validate"
                        aria-label={`Проверить соединение ${repo.fullName ?? repo.url}`}
                        title="Проверить соединение"
                        className="rounded-none p-1 text-[#00FF41]/50 transition-base hover:text-[#00FF41] disabled:opacity-50"
                        onClick={() => void handleValidate(repo)}
                        disabled={busy}
                      >
                        <RefreshIcon className="h-4 w-4" />
                      </button>
                      <button
                        type="button"
                        data-testid="repo-edit"
                        aria-label={`Редактировать ${repo.fullName ?? repo.url}`}
                        title="Редактировать"
                        className="rounded-none p-1 text-[#00FF41]/50 transition-base hover:text-[#00FF41] disabled:opacity-50"
                        onClick={() => openEdit(repo)}
                        disabled={busy}
                      >
                        <PencilIcon className="h-4 w-4" />
                      </button>
                      <button
                        type="button"
                        data-testid="repo-delete"
                        aria-label={`Удалить ${repo.fullName ?? repo.url}`}
                        title="Удалить"
                        className="rounded-none p-1 text-[#00FF41]/50 transition-base hover:text-[#FF0033] disabled:opacity-50"
                        onClick={() => void handleDelete(repo)}
                        disabled={busy}
                      >
                        <TrashIcon className="h-4 w-4" />
                      </button>
                    </div>
                  </div>

                  {repo.defaultBranch && (
                    <div className="mt-1 flex items-center gap-1 text-xs text-[#00FF41]/50">
                      <BranchIcon className="h-3 w-3 shrink-0" />
                      <span data-testid="repo-default-branch" className="truncate">
                        {repo.defaultBranch}
                      </span>
                    </div>
                  )}

                  <div className="mt-0.5 text-[10px] text-[#00FF41]/40">
                    проверка:{' '}
                    <span data-testid="repo-validated-at">
                      {validatedLabel(repo)}
                    </span>
                  </div>

                  {(repo.runInstructionsStatus !== 'unknown' ||
                    repo.language) && (
                    <div className="mt-0.5 flex items-center gap-2 text-[10px] text-[#00FF41]/40">
                      {repo.runInstructionsStatus !== 'unknown' && (
                        <span
                          data-testid="repo-run-instructions-status"
                          className={
                            repo.runInstructionsStatus === 'generated'
                              ? 'text-[#00FF41]'
                              : 'text-[#FF0033]'
                          }
                        >
                          {repo.runInstructionsStatus === 'generated'
                            ? '📋 инструкция готова'
                            : '📋 ошибка анализа'}
                        </span>
                      )}
                      {repo.language && (
                        <span
                          data-testid="repo-language"
                          className="ml-auto truncate"
                        >
                          · {repo.language}
                        </span>
                      )}
                    </div>
                  )}

                  {repo.description && (
                    <div
                      data-testid="repo-description"
                      className="mt-0.5 truncate text-[10px] text-[#00FF41]/40"
                    >
                      {repo.description}
                    </div>
                  )}
                </li>
              </div>
            );
          })}
        </ul>
      )}

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