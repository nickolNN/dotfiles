import { RunInstructionsStatus, type Tag } from '@issue-resolver/shared';
import CardHeader from '../../components/CardHeader';
import PencilIcon from '../../components/icons/PencilIcon';
import TrashIcon from '../../components/icons/TrashIcon';

interface TagCardProps {
  tag: Tag;
  busy: boolean;
  expanded: boolean;
  onToggleExpanded: () => void;
  onEdit: () => void;
  onDelete: () => void;
}

export default function TagCard({
  tag,
  busy,
  expanded,
  onToggleExpanded,
  onEdit,
  onDelete,
}: TagCardProps) {
  return (
    <li
      data-testid="tag-card"
      className="border border-[#008F11]/20 p-2.5"
    >
      <CardHeader
        title={tag.name}
        titleTestId="tag-name-label"
        actions={
          <>
            <button
              type="button"
              data-testid="tag-edit"
              aria-label="Редактировать тег"
              title="Редактировать"
              className="min-h-6 p-1 text-[#008F11]/60 transition-base hover:bg-transparent hover:text-[#00FF41] focus-visible:text-[#00FF41]"
              onClick={onEdit}
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
              onClick={onDelete}
              disabled={busy}
            >
              <TrashIcon className="h-4 w-4" />
            </button>
          </>
        }
      />

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
          инструкции:{' '}
          {tag.run_instructions_status === RunInstructionsStatus.generated
            ? '✅'
            : '⏳'}{' '}
          ({tag.run_instructions.length} симв.)
        </div>
      )}

      {tag.repositories.length > 0 && (
        <div className="mt-1">
          <button
            type="button"
            data-testid="tag-repositories-toggle"
            className="text-xs font-medium text-[#008F11] underline hover:text-[#00FF41]"
            aria-expanded={expanded}
            onClick={onToggleExpanded}
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
                    bootstrap: {tr.bootstrap_enabled ? 'включён' : 'выключен'}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </li>
  );
}