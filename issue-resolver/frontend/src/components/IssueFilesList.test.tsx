import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { IssueFile } from '@issue-resolver/shared';
import IssueFilesList from './IssueFilesList';

afterEach(cleanup);

function makeFile(overrides: Partial<IssueFile> = {}): IssueFile {
  return {
    id: 'f1',
    issue_id: 'issue-1',
    iteration_id: null,
    name: 'spec.md',
    rel_path: 'attachments/spec.md',
    size: 2048,
    mime_type: 'text/markdown',
    created_at: '2026-10-10T00:00:00.000Z',
    ...overrides,
  };
}

describe('IssueFilesList (inline)', () => {
  it('рендерит имя, размер и download href без заголовка-секции', () => {
    render(
      <IssueFilesList
        files={[
          makeFile(),
          makeFile({
            id: 'f2',
            iteration_id: 'iter-2',
            name: 'log.txt',
            size: 10,
          }),
        ]}
      />,
    );

    expect(screen.getByTestId('issue-files-inline')).toBeInTheDocument();
    expect(screen.queryByTestId('issue-files')).toBeNull();
    expect(screen.queryByText('Файлы задачи')).toBeNull();
    expect(screen.getAllByTestId('issue-file')).toHaveLength(2);
    expect(screen.getByText('spec.md')).toBeInTheDocument();
    expect(screen.getByText('2.0 КБ')).toBeInTheDocument();

    const downloads = screen.getAllByTestId('issue-file-download');
    expect(downloads[0]).toHaveAttribute(
      'href',
      '/issue-resolver/api/v1/files/f1/content',
    );
    expect(downloads[1]).toHaveAttribute(
      'href',
      '/issue-resolver/api/v1/files/f2/content',
    );
    expect(screen.queryByTestId('issue-file-iteration')).toBeNull();
  });

  it('пустой список не рендерит блок', () => {
    const { container } = render(<IssueFilesList files={[]} />);
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByTestId('issue-files-inline')).toBeNull();
  });

  it('onDelete вызывается по кнопке удаления', () => {
    const onDelete = vi.fn();
    render(<IssueFilesList files={[makeFile()]} onDelete={onDelete} />);

    fireEvent.click(screen.getByTestId('issue-file-delete'));
    expect(onDelete).toHaveBeenCalledWith('f1');
  });

  it('удаление и скачивание не всплывают к родителю (не выбирают итерацию)', () => {
    const onDelete = vi.fn();
    const onParentClick = vi.fn();
    render(
      <div onClick={onParentClick}>
        <IssueFilesList files={[makeFile()]} onDelete={onDelete} />
      </div>,
    );

    fireEvent.click(screen.getByTestId('issue-file-delete'));
    expect(onDelete).toHaveBeenCalledWith('f1');
    expect(onParentClick).not.toHaveBeenCalled();

    const download = screen.getByTestId('issue-file-download');
    download.addEventListener('click', (event) => event.preventDefault(), {
      capture: true,
    });
    fireEvent.click(download);
    expect(onParentClick).not.toHaveBeenCalled();
  });
});