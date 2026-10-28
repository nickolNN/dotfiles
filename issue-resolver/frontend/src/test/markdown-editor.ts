import { act, screen } from '@testing-library/react';
import { getMarkdownEditorInstance } from '../components/MarkdownEditor';

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

export function getMarkdownEditorValue(label: string): string {
  const element = screen.getByLabelText(label);
  const editor = getMarkdownEditorInstance(element);
  if (!editor) {
    throw new Error(`MarkdownEditor не найден для «${label}»`);
  }
  return editor.getMarkdown();
}