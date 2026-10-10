import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { Editor } from '@tiptap/core';
import MarkdownEditor, {
  getMarkdownEditorInstance,
  markdownEditorExtensions,
} from './MarkdownEditor';

afterEach(cleanup);

function renderEditor(value = '', onChange = vi.fn()) {
  render(
    <MarkdownEditor
      id="md"
      aria-label="Текст"
      value={value}
      onChange={onChange}
    />,
  );
  return {
    onChange,
    element: screen.getByLabelText('Текст') as HTMLElement,
  };
}

describe('MarkdownEditor', () => {
  it('рендерит начальный markdown как rich-контент (smoke)', () => {
    const { element } = renderEditor('# Заголовок');
    expect(element.querySelector('h1')?.textContent).toBe('Заголовок');
  });

  it('доступные имена тулбара не конфликтуют с внешним label «Заголовок»', () => {
    renderEditor('');
    // Playwright `getByLabel` — substring-матч, поэтому кнопки заголовков
    // должны называться H1/H2/H3, а не «Заголовок N».
    expect(screen.queryByLabelText(/Заголовок/)).toBeNull();
    expect(screen.getByRole('button', { name: 'H1' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'H2' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'H3' })).toBeInTheDocument();
    // Тултипы при этом остаются человекочитаемыми.
    expect(screen.getByRole('button', { name: 'H1' })).toHaveAttribute(
      'title',
      'Заголовок 1',
    );
  });

  it('тулбар bold оборачивает выделение и отдаёт **…** в onChange', async () => {
    const { onChange, element } = renderEditor('hello');
    const editor = getMarkdownEditorInstance(element);
    expect(editor).toBeDefined();
    editor!.commands.selectAll();

    const bold = screen.getByRole('button', { name: 'Жирный' });
    fireEvent.mouseDown(bold);
    fireEvent.click(bold);

    expect(onChange).toHaveBeenLastCalledWith('**hello**');
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Жирный' }),
      ).toHaveAttribute('aria-pressed', 'true'),
    );
  });

  it('внешнее изменение value перерисовывает контент без петли emit', async () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <MarkdownEditor
        id="md"
        aria-label="Текст"
        value="one"
        onChange={onChange}
      />,
    );
    rerender(
      <MarkdownEditor
        id="md"
        aria-label="Текст"
        value="# two"
        onChange={onChange}
      />,
    );

    const element = screen.getByLabelText('Текст') as HTMLElement;
    expect(element.querySelector('h1')?.textContent).toBe('two');
    // Сериализатор заголовка добавляет висячие пустые строки — значение
    // должно дойти до родителя (канонический markdown), без петли emit.
    await waitFor(() =>
      expect(onChange.mock.calls.at(-1)?.[0]).toContain('# two'),
    );
    // mount-'' + внешнее значение; внешний setContent не должен зациклиться.
    expect(onChange.mock.calls.length).toBe(2);
  });

  it('disable делает тулбар недоступным и снимает contenteditable', () => {
    render(
      <MarkdownEditor
        id="md"
        aria-label="Текст"
        value="hello"
        onChange={vi.fn()}
        disabled
      />,
    );
    expect(screen.getByRole('button', { name: 'Жирный' })).toBeDisabled();
    expect(screen.getByLabelText('Текст')).toHaveAttribute(
      'contenteditable',
      'false',
    );
  });
});

describe('MarkdownEditor markdown round-trip (@tiptap/markdown)', () => {
  it('парсит и сериализует нужные узлы, повторный проход идемпотентен', () => {
    const source = [
      '# H1',
      '',
      '**bold** and _italic_ and ~~strike~~ and `code`',
      '',
      '- a',
      '- b',
      '',
      '1. one',
      '2. two',
      '',
      '> quote',
      '',
      '[link](https://example.com)',
      '',
      '```',
      'code block',
      '```',
      '',
      '---',
      '',
    ].join('\n');

    const first = new Editor({
      extensions: markdownEditorExtensions(),
      content: source,
      contentType: 'markdown',
    });
    const out = first.getMarkdown();

    expect(out).toContain('# H1');
    expect(out).toContain('**bold**');
    expect(out).toContain('*italic*');
    expect(out).toContain('~~strike~~');
    expect(out).toContain('`code`');
    expect(out).toContain('- a');
    expect(out).toContain('1. one');
    expect(out).toContain('> quote');
    expect(out).toContain('[link](https://example.com)');
    expect(out).toContain('code block');
    expect(out).toContain('---');

    const second = new Editor({
      extensions: markdownEditorExtensions(),
      content: out,
      contentType: 'markdown',
    });
    expect(second.getMarkdown()).toBe(out);

    first.destroy();
    second.destroy();
  });
});