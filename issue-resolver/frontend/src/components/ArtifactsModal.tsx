import { useEffect, useState } from 'react';
import type { WorkspaceFile } from '@issue-resolver/shared';
import {
  resultFileContentUrl,
  resultFilePreviewUrl,
} from '../api/client';
import AgentMarkdown from './AgentMarkdown';
import { formatFileSize } from './FilePicker';
import { extToLanguage, highlightCode } from '../lib/highlight';

interface ArtifactsModalProps {
  issueId: string;
  files: WorkspaceFile[];
  open: boolean;
  onClose: () => void;
  archiveUrl: string;
}

type PreviewKind =
  | 'image'
  | 'html'
  | 'pdf'
  | 'markdown'
  | 'json'
  | 'text'
  | 'unsupported';

const TEXT_EXTENSIONS = new Set([
  'css',
  'js',
  'mjs',
  'cjs',
  'ts',
  'tsx',
  'jsx',
  'txt',
  'xml',
  'csv',
  'log',
  'yml',
  'yaml',
  'sh',
]);

function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot === -1 ? '' : name.slice(dot + 1).toLowerCase();
}

function previewKind(file: WorkspaceFile): PreviewKind {
  const mime = file.mime_type ?? '';
  const ext = extensionOf(file.name) || extensionOf(file.rel_path);
  if (mime === 'application/pdf' || ext === 'pdf') return 'pdf';
  if (mime.startsWith('image/')) return 'image';
  if (mime === 'text/html' || ext === 'html' || ext === 'htm') return 'html';
  if (mime === 'text/markdown' || ext === 'md' || ext === 'markdown') {
    return 'markdown';
  }
  if (mime === 'application/json' || ext === 'json') return 'json';
  if (mime.startsWith('text/')) return 'text';
  if (TEXT_EXTENSIONS.has(ext)) return 'text';
  return 'unsupported';
}

interface TextState {
  status: 'idle' | 'loading' | 'ready' | 'error';
  text: string;
}

function ArtifactPreview({
  issueId,
  file,
}: {
  issueId: string;
  file: WorkspaceFile;
}) {
  const kind = previewKind(file);
  const [state, setState] = useState<TextState>({ status: 'idle', text: '' });
  const contentUrl = resultFileContentUrl(issueId, file.rel_path);
  const previewUrl = resultFilePreviewUrl(issueId, file.rel_path);

  useEffect(() => {
    if (kind !== 'markdown' && kind !== 'json' && kind !== 'text') {
      setState({ status: 'idle', text: '' });
      return;
    }
    let cancelled = false;
    setState({ status: 'loading', text: '' });
    fetch(contentUrl)
      .then(async (response) => {
        if (!response.ok) throw new Error('failed to load');
        return response.text();
      })
      .then((text) => {
        if (!cancelled) setState({ status: 'ready', text });
      })
      .catch(() => {
        if (!cancelled) setState({ status: 'error', text: '' });
      });
    return () => {
      cancelled = true;
    };
  }, [contentUrl, kind]);

  if (kind === 'image') {
    return (
      <img
        data-testid="artifact-preview-image"
        src={previewUrl}
        alt={file.name}
        className="max-w-full"
      />
    );
  }

  if (kind === 'html') {
    return (
      <iframe
        data-testid="artifact-preview-html"
        src={previewUrl}
        title={file.name}
        className="h-full min-h-[300px] w-full border border-[#008F11] bg-white"
      />
    );
  }

  if (kind === 'pdf') {
    return (
      <iframe
        data-testid="artifact-preview-pdf"
        src={previewUrl}
        title={file.name}
        className="h-full min-h-[400px] w-full border border-[#008F11] bg-white"
      />
    );
  }

  if (kind === 'unsupported') {
    return (
      <div data-testid="artifact-preview-unavailable" className="space-y-3">
        <p className="text-sm text-[#00FF41]/60">
          Предпросмотр недоступен для этого типа файла.
        </p>
        <a
          data-testid="artifact-download-unavailable"
          href={contentUrl}
          download={file.name}
          className="inline-flex min-h-9 items-center rounded-none border border-[#008F11] px-3 py-1 text-xs font-medium text-[#00FF41]/80 hover:border-[#00FF41] hover:text-[#00FF41]"
        >
          Скачать {file.name}
        </a>
      </div>
    );
  }

  if (state.status === 'error') {
    return (
      <p
        role="alert"
        data-testid="artifact-preview-error"
        className="text-sm font-medium text-[#FF0033]"
      >
        Не удалось загрузить файл
      </p>
    );
  }

  if (state.status !== 'ready') {
    return <p className="text-sm text-[#00FF41]/60">Загрузка…</p>;
  }

  if (kind === 'markdown') {
    return (
      <div data-testid="artifact-preview-markdown">
        <AgentMarkdown>{state.text}</AgentMarkdown>
      </div>
    );
  }

  let body = state.text;
  if (kind === 'json') {
    try {
      body = JSON.stringify(JSON.parse(state.text), null, 2);
    } catch {
      body = state.text;
    }
  }
  const lang =
    kind === 'json'
      ? 'json'
      : extToLanguage(extensionOf(file.name) || extensionOf(file.rel_path));
  const highlighted = highlightCode(body, lang);
  if (highlighted !== null) {
    return (
      <pre
        data-testid="artifact-preview"
        className="whitespace-pre-wrap break-words text-xs"
      >
        <code
          className="hljs"
          dangerouslySetInnerHTML={{ __html: highlighted }}
        />
      </pre>
    );
  }
  return (
    <pre
      data-testid="artifact-preview"
      className="whitespace-pre-wrap break-words text-xs text-[#00FF41]/80"
    >
      {body}
    </pre>
  );
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
    <div
      data-testid="artifacts-modal"
      role="dialog"
      aria-modal="true"
      onClick={onClose}
      className="fixed inset-0 z-50 flex flex-col bg-[#0D0208]/95 py-4 px-2 sm:px-4"
    >
      <div
        className="flex min-h-0 w-full flex-1 flex-col border border-[#008F11] bg-[#0D0208]"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="flex flex-wrap items-center gap-3 border-b border-[#008F11] py-4 px-2 sm:px-4">
          <span className="text-[#00FF41]">Артефакты ({files.length})</span>
          <a
            data-testid="artifacts-modal-download-archive"
            href={archiveUrl}
            download={`issue-${issueId}.tar.gz`}
            className="inline-flex items-center rounded-none border border-[#008F11] px-2 py-0.5 text-[11px] font-medium text-[#00FF41]/80 hover:border-[#00FF41] hover:text-[#00FF41] transition-base"
          >
            Скачать всё (.tar.gz)
          </a>
          <button
            type="button"
            data-testid="artifacts-modal-close"
            aria-label="Закрыть"
            onClick={onClose}
            className="ml-auto shrink-0 border border-[#008F11] px-3 py-1 text-sm text-[#00FF41] hover:border-[#00FF41] hover:bg-[#003B00]"
          >
            ✕
          </button>
        </header>
        <div className="flex min-h-0 flex-1 flex-col sm:flex-row">
          <ul className="min-h-0 overflow-auto border-b border-[#008F11] sm:w-1/3 sm:border-b-0 sm:border-r">
            {files.map((file) => {
              const active = selected?.rel_path === file.rel_path;
              return (
                <li key={file.rel_path}>
                  <div
                    data-testid="artifact-file"
                    role="button"
                    tabIndex={0}
                    aria-pressed={active}
                    onClick={() => setSelectedPath(file.rel_path)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault();
                        setSelectedPath(file.rel_path);
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
        </div>
      </div>
    </div>
  );
}