import { act, screen } from '@testing-library/react';
import { getMarkdownEditorInstance } from '../components/MarkdownEditor';

/**
 * Записать markdown в живой `MarkdownEditor`, найденный по доступному
 * имени (aria-label / label). Использует реальный экземпляр Tiptap и его
 * команду `setContent`, поэтому `onChange` вызывается ровно так же, как
 * при внешнем изменении `value`.
 *
 * Живой ProseMirror-вид под jsdom не реагирует на DOM-события, поэтому
 * тесты не могут «печатать» в contenteditable через `fireEvent`/`type`.
 */
export function setMarkdownEditorValue(label: string, markdown: string): void {
  const element = screen.getByLabelText(label);
  const editor = getMarkdownEditorInstance(element);
  if (!editor) {
    throw new Error(`MarkdownEditor не найден для «${label}»`);
  }
  act(() => {
    editor.commands.setContent(markdown, { contentType: 'markdown' });
  });
}

/** Текущий markdown из живого `MarkdownEditor` по доступному имени. */
export function getMarkdownEditorValue(label: string): string {
  const element = screen.getByLabelText(label);
  const editor = getMarkdownEditorInstance(element);
  if (!editor) {
    throw new Error(`MarkdownEditor не найден для «${label}»`);
  }
  return editor.getMarkdown();
}