import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { IssueFile, Iteration } from '@issue-resolver/shared';
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

function makeIteration(overrides: Partial<Iteration> = {}): Iteration {
  return {
    id: 'iter-2',
    issue_id: 'issue-1',
    number: 2,
    context: 'ctx',
    review_context: '',
    is_review_need: false,
    steps: ['resolve'],
    status: 'completed',
    created_at: '2026-10-09T00:00:00.000Z',
    updated_at: '2026-10-09T00:00:00.000Z',
    ...overrides,
  };
}

describe('IssueFilesList', () => {
  it('рендерит имя, размер, download href и бейдж итерации', () => {
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
        iterations={[makeIteration()]}
      />,
    );

    expect(screen.getByTestId('issue-files')).toBeInTheDocument();
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
    expect(screen.getByTestId('issue-file-iteration')).toHaveTextContent(
      'Итерация #2',
    );
  });

  it('пустой список не рендерит блок', () => {
    const { container } = render(<IssueFilesList files={[]} />);
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByTestId('issue-files')).toBeNull();
  });

  it('onDelete вызывается по кнопке удаления', () => {
    const onDelete = vi.fn();
    render(<IssueFilesList files={[makeFile()]} onDelete={onDelete} />);

    fireEvent.click(screen.getByTestId('issue-file-delete'));
    expect(onDelete).toHaveBeenCalledWith('f1');
  });
});