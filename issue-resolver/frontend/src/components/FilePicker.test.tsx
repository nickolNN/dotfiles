import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import FilePicker, { formatFileSize } from './FilePicker';

afterEach(cleanup);

function makeFile(name: string, content = 'x', type = 'text/plain'): File {
  return new File([content], name, { type });
}

describe('FilePicker', () => {
  it('добавляет выбранные файлы через onChange', () => {
    const onChange = vi.fn();
    render(<FilePicker id="files" files={[]} onChange={onChange} />);

    const input = screen.getByLabelText('Файлы') as HTMLInputElement;
    fireEvent.change(input, {
      target: { files: [makeFile('a.txt', 'aaa'), makeFile('b.bin', 'bbbb')] },
    });

    const next = onChange.mock.calls[0][0] as File[];
    expect(next.map((file) => file.name)).toEqual(['a.txt', 'b.bin']);
  });

  it('рендерит имя/размер и удаляет файл по ✕', () => {
    const onChange = vi.fn();
    render(
      <FilePicker id="files" files={[makeFile('a.txt', 'aaa')]} onChange={onChange} />,
    );

    expect(screen.getByText('a.txt')).toBeInTheDocument();
    expect(screen.getByText('3 Б')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Убрать a.txt' }));
    expect(onChange).toHaveBeenCalledWith([]);
  });

  it('disabled блокирует input и удаление', () => {
    render(
      <FilePicker
        id="files"
        files={[makeFile('a.txt', 'a')]}
        onChange={vi.fn()}
        disabled
      />,
    );

    expect(screen.getByLabelText('Файлы')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Убрать a.txt' })).toBeDisabled();
  });

  it('formatFileSize покрывает Б/КБ/МБ', () => {
    expect(formatFileSize(0)).toBe('0 Б');
    expect(formatFileSize(1023)).toBe('1023 Б');
    expect(formatFileSize(1536)).toBe('1.5 КБ');
    expect(formatFileSize(20 * 1024)).toBe('20 КБ');
    expect(formatFileSize(2.5 * 1024 * 1024)).toBe('2.5 МБ');
    expect(formatFileSize(Number.NaN)).toBe('—');
  });
});