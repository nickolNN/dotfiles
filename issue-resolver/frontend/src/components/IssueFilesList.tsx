import type { IssueFile, Iteration } from '@issue-resolver/shared';
import { fileContentUrl } from '../api/client';
import { formatFileSize } from './FilePicker';

export interface IssueFilesListProps {
  files: IssueFile[];
  iterations?: Iteration[];
  onDelete?: (fileId: string) => void;
  deletingId?: string | null;
}

/**
 * Вложения задачи: имя, размер, бейдж итерации (если файл приложен к
 * итерации) и ссылка на скачивание. Пустой список ничего не рендерит.
 */
export default function IssueFilesList({
  files,
  iterations = [],
  onDelete,
  deletingId = null,
}: IssueFilesListProps) {
  if (files.length === 0) return null;

  return (
    <section data-testid="issue-files" className="mb-8">
      <h3 className="glow mb-2 text-sm font-semibold text-[#00FF41]">
        Файлы задачи
      </h3>
      <ul className="space-y-1">
        {files.map((file) => {
          const iteration = file.iteration_id
            ? iterations.find((item) => item.id === file.iteration_id)
            : undefined;
          return (
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
              {file.iteration_id && (
                <span
                  data-testid="issue-file-iteration"
                  className="shrink-0 border border-[#00B4FF] px-2 py-0.5 text-xs text-[#00B4FF]"
                >
                  {iteration ? `Итерация #${iteration.number}` : 'Итерация'}
                </span>
              )}
              <a
                data-testid="issue-file-download"
                href={fileContentUrl(file.id)}
                download={file.name}
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
                  onClick={() => onDelete(file.id)}
                  className="shrink-0 px-1 text-[#008F11] hover:text-[#FF0033] disabled:opacity-40"
                >
                  ✕
                </button>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}