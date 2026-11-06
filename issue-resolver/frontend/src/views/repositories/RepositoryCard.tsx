import {
  extractRepoNameFromUrl,
  RepoConnectionStatus,
  RunInstructionsStatus,
  type SavedRepo,
} from '@issue-resolver/shared';
import CardHeader from '../../components/CardHeader';
import BranchIcon from '../../components/icons/BranchIcon';
import PencilIcon from '../../components/icons/PencilIcon';
import RefreshIcon from '../../components/icons/RefreshIcon';
import TrashIcon from '../../components/icons/TrashIcon';
import PlatformChip from '../../components/PlatformChip';
import { cardAnimation } from '../../lib/animations';
import StatusDot from './StatusDot';
import { validatedLabel } from './status';

interface RepositoryCardProps {
  repo: SavedRepo;
  index: number;
  busy: boolean;
  onValidate: () => void;
  onEdit: () => void;
  onDelete: () => void;
}

export default function RepositoryCard({
  repo,
  index,
  busy,
  onValidate,
  onEdit,
  onDelete,
}: RepositoryCardProps) {
  const label = repo.fullName ?? repo.url;

  return (
    <div className={cardAnimation(index)}>
      <li
        data-testid="repo-card"
        className="cursor-pointer border border-[#008F11]/20 p-2.5 transition-base hover:bg-[#00FF41]/5"
      >
        <CardHeader
          title={repo.fullName || extractRepoNameFromUrl(repo.url) || repo.url}
          titleTestId="repo-full-name"
          leading={
            <>
              <StatusDot status={repo.connectionStatus} />
              <PlatformChip platform={repo.platform} />
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
            </>
          }
          actionsClassName="gap-0.5"
          actions={
            <>
              <button
                type="button"
                data-testid="repo-validate"
                aria-label={`Проверить соединение ${label}`}
                title="Проверить соединение"
                className="rounded-none p-1 text-[#00FF41]/50 transition-base hover:text-[#00FF41] disabled:opacity-50"
                onClick={onValidate}
                disabled={busy}
              >
                <RefreshIcon className="h-4 w-4" />
              </button>
              <button
                type="button"
                data-testid="repo-edit"
                aria-label={`Редактировать ${label}`}
                title="Редактировать"
                className="rounded-none p-1 text-[#00FF41]/50 transition-base hover:text-[#00FF41] disabled:opacity-50"
                onClick={onEdit}
                disabled={busy}
              >
                <PencilIcon className="h-4 w-4" />
              </button>
              <button
                type="button"
                data-testid="repo-delete"
                aria-label={`Удалить ${label}`}
                title="Удалить"
                className="rounded-none p-1 text-[#00FF41]/50 transition-base hover:text-[#FF0033] disabled:opacity-50"
                onClick={onDelete}
                disabled={busy}
              >
                <TrashIcon className="h-4 w-4" />
              </button>
            </>
          }
        />

        {repo.defaultBranch ? (
          <div className="mt-1 flex items-center gap-1 text-xs text-[#00FF41]/50">
            <BranchIcon className="h-3 w-3 shrink-0" />
            <span data-testid="repo-default-branch" className="truncate">
              {repo.defaultBranch}
            </span>
          </div>
        ) : (
          repo.connectionStatus === RepoConnectionStatus.ok && (
            <div className="mt-1 flex items-center gap-1 text-xs text-[#FFB000]">
              <BranchIcon className="h-3 w-3 shrink-0" />
              <span data-testid="repo-empty">
                нет веток — пустой репозиторий
              </span>
            </div>
          )
        )}

        <div className="mt-0.5 text-[10px] text-[#00FF41]/40">
          проверка:{' '}
          <span data-testid="repo-validated-at">{validatedLabel(repo)}</span>
        </div>

        {(repo.runInstructionsStatus !== RunInstructionsStatus.unknown ||
          repo.language) && (
          <div className="mt-0.5 flex items-center gap-2 text-[10px] text-[#00FF41]/40">
            {repo.runInstructionsStatus !== RunInstructionsStatus.unknown && (
              <span
                data-testid="repo-run-instructions-status"
                className={
                  repo.runInstructionsStatus === RunInstructionsStatus.generated
                    ? 'text-[#00FF41]'
                    : 'text-[#FF0033]'
                }
              >
                {repo.runInstructionsStatus === RunInstructionsStatus.generated
                  ? '📋 инструкция готова'
                  : '📋 ошибка анализа'}
              </span>
            )}
            {repo.language && (
              <span data-testid="repo-language" className="ml-auto truncate">
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
}