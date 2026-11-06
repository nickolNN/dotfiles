import { useEffect, useState } from 'react';
import type { WorkspaceFile } from '@issue-resolver/shared';
import {
  getResultFileText,
  resultFileContentUrl,
  resultFilePreviewUrl,
} from '../../api/client';
import { extToLanguage, highlightTree } from '../../lib/highlight';
import { AsyncStateStatus, errorState, type AsyncState } from '../../lib/async-state';
import { prettyJsonText } from '../../lib/json';
import AgentMarkdown from '../AgentMarkdown';
import HighlightedCode from '../HighlightedCode';
import { extensionOf, previewKind, PreviewKind } from './preview-kind';

export default function ArtifactPreview({
  issueId,
  file,
}: {
  issueId: string;
  file: WorkspaceFile;
}) {
  const kind = previewKind(file);
  const [state, setState] = useState<AsyncState<string>>({ status: AsyncStateStatus.empty });
  const contentUrl = resultFileContentUrl(issueId, file.rel_path);
  const previewUrl = resultFilePreviewUrl(issueId, file.rel_path);

  useEffect(() => {
    if (
      kind !== PreviewKind.markdown &&
      kind !== PreviewKind.json &&
      kind !== PreviewKind.text
    ) {
      setState({ status: AsyncStateStatus.empty });
      return;
    }
    let cancelled = false;
    setState({ status: AsyncStateStatus.loading });
    getResultFileText(issueId, file.rel_path)
      .then((text) => {
        if (!cancelled) setState({ status: AsyncStateStatus.ready, data: text });
      })
      .catch((error: unknown) => {
        if (!cancelled) setState(errorState(error));
      });
    return () => {
      cancelled = true;
    };
  }, [issueId, file.rel_path, kind]);

  if (kind === PreviewKind.image) {
    return (
      <img
        data-testid="artifact-preview-image"
        src={previewUrl}
        alt={file.name}
        className="max-w-full"
      />
    );
  }

  if (kind === PreviewKind.html) {
    return (
      <iframe
        data-testid="artifact-preview-html"
        src={previewUrl}
        title={file.name}
        className="h-full min-h-[300px] w-full border border-[#008F11] bg-white"
      />
    );
  }

  if (kind === PreviewKind.pdf) {
    return (
      <iframe
        data-testid="artifact-preview-pdf"
        src={previewUrl}
        title={file.name}
        className="h-full min-h-[400px] w-full border border-[#008F11] bg-white"
      />
    );
  }

  if (kind === PreviewKind.unsupported) {
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

  if (state.status === AsyncStateStatus.error) {
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

  if (state.status !== AsyncStateStatus.ready) {
    return <p className="text-sm text-[#00FF41]/60">Загрузка…</p>;
  }

  if (kind === PreviewKind.markdown) {
    return (
      <div data-testid="artifact-preview-markdown">
        <AgentMarkdown>{state.data}</AgentMarkdown>
      </div>
    );
  }

  const isJson = kind === PreviewKind.json;
  const body = isJson ? prettyJsonText(state.data) : state.data;
  const lang =
    isJson
      ? PreviewKind.json
      : extToLanguage(extensionOf(file.name) || extensionOf(file.rel_path));
  const highlighted = highlightTree(body, lang);
  if (highlighted !== null) {
    return (
      <pre
        data-testid="artifact-preview"
        className="whitespace-pre-wrap break-words text-xs"
      >
        <HighlightedCode nodes={highlighted} />
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