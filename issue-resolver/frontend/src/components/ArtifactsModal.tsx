import { useEffect, useState } from 'react';
import type { WorkspaceFile } from '@issue-resolver/shared';
import ArtifactFileList from './artifacts-modal/ArtifactFileList';
import ArtifactPreview from './artifacts-modal/ArtifactPreview';
import ModalShell, { ModalLayout } from './ModalShell';

interface ArtifactsModalProps {
  issueId: string;
  files: WorkspaceFile[];
  open: boolean;
  onClose: () => void;
  archiveUrl: string;
}

export default function ArtifactsModal({
  issueId,
  files,
  open,
  onClose,
  archiveUrl,
}: ArtifactsModalProps) {
  const [selectedPath, setSelectedPath] = useState<string | null>(null);

  useEffect(() => {
    if (!open) setSelectedPath(null);
  }, [open]);

  if (!open) return null;

  const selected =
    files.find((file) => file.rel_path === selectedPath) ?? files[0] ?? null;

  return (
    <ModalShell
      layout={ModalLayout.full}
      onClose={onClose}
      overlayTestId="artifacts-modal"
      closeTestId="artifacts-modal-close"
      dialogLabel={`Артефакты (${files.length})`}
      title={
        <span className="text-[#00FF41]">Артефакты ({files.length})</span>
      }
      actions={
        <a
          data-testid="artifacts-modal-download-archive"
          href={archiveUrl}
          download={`issue-${issueId}.tar.gz`}
          className="inline-flex items-center rounded-none border border-[#008F11] px-2 py-0.5 text-[11px] font-medium text-[#00FF41]/80 hover:border-[#00FF41] hover:text-[#00FF41] transition-base"
        >
          Скачать всё (.tar.gz)
        </a>
      }
      classes={{
        card: 'border-[#008F11] bg-[#0D0208]',
        body: 'flex flex-col sm:flex-row',
      }}
    >
      <ArtifactFileList
        issueId={issueId}
        files={files}
        selectedPath={selected?.rel_path ?? null}
        onSelect={setSelectedPath}
      />
      <div className="min-h-0 flex-1 overflow-auto p-3">
        {selected ? (
          <ArtifactPreview
            key={selected.rel_path}
            issueId={issueId}
            file={selected}
          />
        ) : (
          <p className="text-sm text-[#00FF41]/60">
            Выберите файл для предпросмотра.
          </p>
        )}
      </div>
    </ModalShell>
  );
}