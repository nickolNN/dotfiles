import type { SavedRepo } from '@issue-resolver/shared';
import RepoRow, { type RepoRowData } from '../RepoRow';

interface RepositoriesFieldProps {
  repositories: RepoRowData[];
  savedRepos: SavedRepo[];
  savedReposLoading: boolean;
  savedReposErrorText: string | null;
  onSelectRepo: (index: number, repoId: string) => void;
  onUpdateBranch: (index: number, value: string) => void;
  onToggleBootstrap: (index: number) => void;
  onRemove: (index: number) => void;
  onAdd: () => void;
}

export default function RepositoriesField({
  repositories,
  savedRepos,
  savedReposLoading,
  savedReposErrorText,
  onSelectRepo,
  onUpdateBranch,
  onToggleBootstrap,
  onRemove,
  onAdd,
}: RepositoriesFieldProps) {
  return (
    <fieldset>
      <div className="mb-2 flex items-center justify-between">
        <legend className="text-sm font-medium text-[#00FF41]/80">
          Репозитории
        </legend>
        <button
          type="button"
          className="text-sm font-medium text-[#008F11] underline hover:text-[#00FF41]"
          onClick={onAdd}
        >
          Добавить репозиторий
        </button>
      </div>
      <div className="space-y-3">
        {savedReposErrorText && (
          <p role="alert" className="text-xs font-medium text-[#FF0033]">
            {savedReposErrorText}
          </p>
        )}
        {repositories.map((repository, index) => (
          <RepoRow
            key={index}
            repo={repository}
            index={index}
            savedRepos={savedRepos}
            savedReposLoading={savedReposLoading}
            onSelectRepo={onSelectRepo}
            onUpdateBranch={onUpdateBranch}
            onToggleBootstrap={onToggleBootstrap}
            onRemove={onRemove}
          />
        ))}
      </div>
      {repositories.length === 0 && (
        <p className="mt-2 text-xs text-[#00FF41]/50">
          {!savedReposLoading && savedRepos.length === 0
            ? 'Нет сохранённых репозиториев — добавьте их на странице «Репозитории»'
            : 'Можно без репозиториев — агент запишет отчёт в папку задачи'}
        </p>
      )}
    </fieldset>
  );
}