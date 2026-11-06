import type { WorkspaceFile } from '@issue-resolver/shared';
import { resultFileContentUrl } from '../../api/client';
import { formatFileSize } from '../../lib/format';

interface ArtifactFileListProps {
  issueId: string;
  files: WorkspaceFile[];
  selectedPath: string | null;
  onSelect: (relPath: string) => void;
}

export default function ArtifactFileList({
  issueId,
  files,
  selectedPath,
  onSelect,
}: ArtifactFileListProps) {
  return (
    <ul className="min-h-0 overflow-auto border-b border-[#008F11] sm:w-1/3 sm:border-b-0 sm:border-r">
      {files.map((file) => {
        const active = selectedPath === file.rel_path;
        return (
          <li key={file.rel_path}>
            <div
              data-testid="artifact-file"
              role="button"
              tabIndex={0}
              aria-pressed={active}
              onClick={() => onSelect(file.rel_path)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  onSelect(file.rel_path);
                }
              }}
              className={`flex cursor-pointer flex-wrap items-baseline gap-x-2 gap-y-1 border-b border-[#008F11]/40 p-2 text-xs ${
                active
                  ? 'bg-[#003B00] text-[#00FF41]'
                  : 'text-[#00FF41]/80 hover:bg-[#003B00]/40'
              }`}
            >
              <span className="font-medium">{file.name}</span>
              <span className="break-all text-[#00FF41]/50">
                {file.rel_path}
              </span>
              <span className="text-[#00FF41]/50">
                {formatFileSize(file.size)}
              </span>
              <a
                data-testid="artifact-download"
                href={resultFileContentUrl(issueId, file.rel_path)}
                download={file.name}
                onClick={(event) => event.stopPropagation()}
                className="ml-auto shrink-0 border border-[#008F11] px-2 py-0.5 text-[#00FF41]/80 hover:border-[#00FF41] hover:text-[#00FF41]"
              >
                Скачать
              </a>
            </div>
          </li>
        );
      })}
    </ul>
  );
}