import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { WorkspaceFile } from '@issue-resolver/shared';
import ArtifactsModal from './ArtifactsModal';

const HTML_FILE: WorkspaceFile = {
  name: 'index.html',
  rel_path: 'index.html',
  size: 2048,
  mime_type: 'text/html',
};

const MD_FILE: WorkspaceFile = {
  name: 'notes.md',
  rel_path: 'notes.md',
  size: 12,
  mime_type: 'text/markdown',
};

const PNG_FILE: WorkspaceFile = {
  name: 'cat.png',
  rel_path: 'shots/cat.png',
  size: 999,
  mime_type: 'image/png',
};

const JSON_FILE: WorkspaceFile = {
  name: 'data.json',
  rel_path: 'data.json',
  size: 20,
  mime_type: 'application/json',
};

const BIN_FILE: WorkspaceFile = {
  name: 'file.bin',
  rel_path: 'file.bin',
  size: 5,
  mime_type: 'application/octet-stream',
};

const JS_FILE: WorkspaceFile = {
  name: 'app.js',
  rel_path: 'src/app.js',
  size: 18,
  mime_type: 'application/javascript',
};

const TXT_FILE: WorkspaceFile = {
  name: 'readme.txt',
  rel_path: 'readme.txt',
  size: 8,
  mime_type: 'text/plain',
};

function textResponse(body: string): Response {
  return { ok: true, status: 200, text: async () => body } as Response;
}

function stubFetch(overrides: (url: string) => Response | null = () => null) {
  const fetchMock = vi.fn((input: RequestInfo | URL) => {
    const url = String(input);
    const override = overrides(url);
    if (override) return Promise.resolve(override);
    if (url.includes('notes.md')) return Promise.resolve(textResponse('# Заголовок'));
    if (url.includes('data.json')) {
      return Promise.resolve(textResponse('{"b":2,"a":1}'));
    }
    if (url.includes('app.js')) {
      return Promise.resolve(textResponse('const answer = 42;'));
    }
    if (url.includes('/result/files/content')) {
      return Promise.resolve(textResponse('raw body'));
    }
    return Promise.resolve(textResponse(''));
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function renderModal(files: WorkspaceFile[], onClose = vi.fn()) {
  render(
    <ArtifactsModal
      issueId="issue-1"
      files={files}
      archiveUrl="/fake/archive.tar.gz"
      open
      onClose={onClose}
    />,
  );
  return onClose;
}

describe('ArtifactsModal', () => {
  it('перечисляет файлы, показывает размер и ссылки скачивания', () => {
    stubFetch();
    renderModal([HTML_FILE, MD_FILE]);

    const rows = screen.getAllByTestId('artifact-file');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent('index.html');
    expect(rows[0]).toHaveTextContent('2.0 КБ');
    expect(rows[1]).toHaveTextContent('notes.md');

    const downloads = screen.getAllByTestId('artifact-download');
    expect(downloads[0]).toHaveAttribute(
      'href',
      '/issue-resolver/api/v1/issues/issue-1/result/files/content?path=index.html',
    );
    expect(downloads[0]).toHaveAttribute('download', 'index.html');
  });

  it('выбор .md → markdown-предпросмотр', async () => {
    stubFetch();
    renderModal([HTML_FILE, MD_FILE]);

    fireEvent.click(screen.getAllByTestId('artifact-file')[1]);

    const preview = await screen.findByTestId('artifact-preview-markdown');
    expect(preview).toHaveTextContent('Заголовок');
  });

  it('html → iframe с preview-url (inline=1)', () => {
    stubFetch();
    renderModal([HTML_FILE]);

    const iframe = screen.getByTestId('artifact-preview-html');
    expect(iframe).toHaveAttribute(
      'src',
      '/issue-resolver/api/v1/issues/issue-1/result/files/content?path=index.html&inline=1',
    );
  });

  it('image → img с preview-url (inline=1)', () => {
    stubFetch();
    renderModal([PNG_FILE]);

    const img = screen.getByTestId('artifact-preview-image');
    expect(img).toHaveAttribute(
      'src',
      '/issue-resolver/api/v1/issues/issue-1/result/files/content?path=shots%2Fcat.png&inline=1',
    );
  });

  it('json → pre с pretty-print и подсветкой', async () => {
    stubFetch();
    renderModal([JSON_FILE]);

    const pre = await screen.findByTestId('artifact-preview');
    expect(pre.querySelector('code.hljs')).not.toBeNull();
    expect(pre.textContent).toContain('"b": 2');
    expect(pre.textContent).toContain('"a": 1');
  });

  it('битый json → сырой текст в pre', async () => {
    stubFetch((url) =>
      url.includes('data.json') ? textResponse('{not json') : null,
    );
    renderModal([JSON_FILE]);

    const pre = await screen.findByTestId('artifact-preview');
    expect(pre).toHaveTextContent('{not json');
  });

  it('js → подсветка синтаксиса: code.hljs с токен-классами', async () => {
    stubFetch();
    renderModal([JS_FILE]);

    const pre = await screen.findByTestId('artifact-preview');
    const code = pre.querySelector('code.hljs');
    expect(code).not.toBeNull();
    expect(code?.querySelector('.hljs-keyword')).not.toBeNull();
    expect(pre).toHaveTextContent('const answer = 42;');
  });

  it('txt без языка → без подсветки, сырой текст', async () => {
    stubFetch();
    renderModal([TXT_FILE]);

    const pre = await screen.findByTestId('artifact-preview');
    expect(pre.querySelector('code.hljs')).toBeNull();
    expect(pre).toHaveTextContent('raw body');
  });

  it('неизвестный тип → заглушка «недоступен» + ссылка скачивания', () => {
    stubFetch();
    renderModal([BIN_FILE]);

    const unavailable = screen.getByTestId('artifact-preview-unavailable');
    expect(unavailable).toHaveTextContent('Предпросмотр недоступен');
    expect(
      screen.getByTestId('artifact-download-unavailable'),
    ).toHaveAttribute('download', 'file.bin');
  });

  it('ошибка загрузки текста → «Не удалось загрузить файл»', async () => {
    stubFetch(() => ({ ok: false, status: 500, text: async () => '' }) as Response);
    renderModal([MD_FILE]);

    expect(await screen.findByTestId('artifact-preview-error')).toHaveTextContent(
      'Не удалось загрузить файл',
    );
  });

  it('клик по фону вызывает onClose, клик внутри — нет', () => {
    const onClose = renderModal([HTML_FILE]);

    fireEvent.click(screen.getByTestId('artifacts-modal'));
    expect(onClose).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByTestId('artifact-preview-html'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('кнопка закрытия вызывает onClose', () => {
    const onClose = renderModal([HTML_FILE]);

    fireEvent.click(screen.getByTestId('artifacts-modal-close'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('open=false → ничего не рендерит', () => {
    stubFetch();
    render(
      <ArtifactsModal
        issueId="issue-1"
        files={[HTML_FILE]}
        archiveUrl="/fake/archive.tar.gz"
        open={false}
        onClose={vi.fn()}
      />,
    );

    expect(screen.queryByTestId('artifacts-modal')).toBeNull();
  });
});