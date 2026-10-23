import type { SavedRepo } from '@issue-resolver/shared';
import { inputClass, labelClass } from './formStyles';

/** Строка репозитория в форме задачи: выбранный репозиторий + его ветки. */
export interface RepoRowData {
  repo_id: string;
  /** URL репозитория, заданного вне сохранённого списка (когда `repo_id` пуст). */
  repository_url?: string;
  base_branch: string;
  /** Ставить ли зависимости (DevOps-агента) в этом репозитории. */
  bootstrap_enabled: boolean;
  branches: string[];
  branchesLoading: boolean;
}

export interface RepoRowProps {
  repo: RepoRowData;
  index: number;
  savedRepos: SavedRepo[];
  savedReposLoading: boolean;
  onSelectRepo: (index: number, repoId: string) => void;
  onUpdateBranch: (index: number, value: string) => void;
  onToggleBootstrap: (index: number) => void;
  onRemove: (index: number) => void;
}

/**
 * Одна строка формы репозитория: select репозитория → select базовой ветки →
 * «Удалить», URL/ветка по умолчанию и тоггл Dev-сервера. Только UI: состояние
 * и сетевые вызовы держит родитель (`IssueForm`).
 */
export default function RepoRow({
  repo,
  index,
  savedRepos,
  savedReposLoading,
  onSelectRepo,
  onUpdateBranch,
  onToggleBootstrap,
  onRemove,
}: RepoRowProps) {
  const selectedRepo = savedRepos.find((item) => item.id === repo.repo_id);
  // Опции веток: данные API, плюс текущее значение, если его нет в списке.
  const branchOptions =
    repo.base_branch.length === 0
      ? []
      : repo.branches.includes(repo.base_branch)
        ? repo.branches
        : [repo.base_branch, ...repo.branches];

  return (
    <div
      data-testid="repo-row"
      className="space-y-2 border border-[#008F11]/40 p-3"
    >
      <div className="flex flex-col gap-3 md:flex-row md:items-end">
        <div className="min-w-0 flex-1">
          <label className={labelClass} htmlFor={`repository-select-${index}`}>
            Репозиторий
          </label>
          <select
            id={`repository-select-${index}`}
            data-testid={`repository-select-${index}`}
            className={inputClass}
            value={repo.repo_id}
            disabled={savedReposLoading}
            onChange={(event) => onSelectRepo(index, event.target.value)}
          >
            <option value="">
              {savedReposLoading ? 'Загружаем…' : 'Выберите репозиторий'}
            </option>
            {savedRepos.map((item) => (
              <option key={item.id} value={item.id}>
                {item.fullName ?? item.url}
              </option>
            ))}
          </select>
        </div>
        <div className="min-w-0 flex-1">
          <label className={labelClass} htmlFor={`repository-branch-${index}`}>
            Базовая ветка
          </label>
          <select
            id={`repository-branch-${index}`}
            data-testid={`repository-branch-${index}`}
            className={inputClass}
            value={repo.base_branch}
            disabled={!repo.repo_id || repo.branchesLoading}
            onChange={(event) => onUpdateBranch(index, event.target.value)}
          >
            {branchOptions.length === 0 && (
              <option value="">
                {repo.repo_id ? 'Загружаем…' : '—'}
              </option>
            )}
            {branchOptions.map((branch) => (
              <option key={branch} value={branch}>
                {branch}
              </option>
            ))}
          </select>
        </div>
        <button
          type="button"
          className="min-h-12 w-full rounded-none border border-[#008F11] px-3 py-2 text-sm text-[#008F11] hover:bg-[#008F11]/20 hover:text-[#00FF41] disabled:opacity-40 md:w-auto"
          onClick={() => onRemove(index)}
        >
          Удалить
        </button>
      </div>
      {selectedRepo && (
        <p className="text-xs text-[#00FF41]/50">
          {selectedRepo.url}
          {selectedRepo.defaultBranch
            ? ` · ветка по умолчанию: ${selectedRepo.defaultBranch}`
            : ''}
        </p>
      )}
      {!selectedRepo && repo.repository_url && (
        <p
          data-testid="repo-url-unmatched"
          className="text-xs text-[#FFB000]"
        >
          {repo.repository_url} — репозиторий не найден среди сохранённых, MR
          для него недоступен.
        </p>
      )}
      <div className="flex flex-wrap items-center gap-x-6 gap-y-1">
        <button
          type="button"
          role="switch"
          aria-checked={repo.bootstrap_enabled === true}
          onClick={() => onToggleBootstrap(index)}
          className="flex min-h-12 items-center gap-3 text-sm font-medium text-[#00FF41]/80"
        >
          <span
            aria-hidden="true"
            className={`relative inline-flex h-6 w-11 shrink-0 items-center border transition-colors ${
              repo.bootstrap_enabled
                ? 'border-[#00FF41] bg-[#003B00]'
                : 'border-[#008F11] bg-[#0D0208]'
            }`}
          >
            <span
              className={`absolute h-4 w-4 transition-transform ${
                repo.bootstrap_enabled
                  ? 'translate-x-6 bg-[#00FF41]'
                  : 'translate-x-1 bg-[#008F11]'
              }`}
            />
          </span>
          Dev сервер
        </button>
      </div>
    </div>
  );
}