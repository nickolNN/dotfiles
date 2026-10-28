import type { IssueFile } from '@issue-resolver/shared';
import { fileContentUrl } from '../api/client';
import { formatFileSize } from './FilePicker';

export interface IssueFilesListProps {
  files: IssueFile[];
  onDelete?: (fileId: string) => void;
  deletingId?: string | null;
}

export default function IssueFilesList({
  files,
  onDelete,
  deletingId = null,
}: IssueFilesListProps) {
  if (files.length === 0) return null;

  return (
    <ul data-testid="issue-files-inline" className="mt-2 space-y-1">
      {files.map((file) => (
        <li
          key={file.id}
          data-testid="issue-file"
          className="flex flex-wrap items-center gap-x-3 gap-y-1 border border-[#008F11]/40 px-3 py-2 text-sm"
        >
          <span className="min-w-0 flex-1 truncate text-[#00FF41]">
            {file.name}
          </span>
          <span className="shrink-0 text-xs text-[#00FF41]/50">
            {formatFileSize(file.size)}
          </span>
          <a
            data-testid="issue-file-download"
            href={fileContentUrl(file.id)}
            download={file.name}
            onClick={(event) => event.stopPropagation()}
            className="min-h-9 inline-flex shrink-0 items-center rounded-none border border-[#008F11] px-3 py-1 text-xs font-medium text-[#00FF41]/80 hover:border-[#00FF41] hover:text-[#00FF41]"
          >
            Скачать
          </a>
          {onDelete && (
            <button
              type="button"
              data-testid="issue-file-delete"
              aria-label={`Удалить ${file.name}`}
              disabled={deletingId === file.id}
              onClick={(event) => {
                event.stopPropagation();
                onDelete(file.id);
              }}
              className="shrink-0 px-1 text-[#008F11] hover:text-[#FF0033] disabled:opacity-40"
            >
              ✕
            </button>
          )}
        </li>
      ))}
    </ul>
  );
}