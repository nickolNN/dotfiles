import { useEffect, useRef } from 'react';
import { EditorContent, useEditor, useEditorState } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { Markdown } from '@tiptap/markdown';
import { Placeholder } from '@tiptap/extensions';
import type { Editor, Extensions } from '@tiptap/core';

/**
 * Реестр живых редакторов по их contenteditable-элементу.
 *
 * Живой ProseMirror-вид под jsdom не реагирует на DOM-события (innerHTML +
 * `input` не обновляют состояние, программный window.getSelection не
 * становится editor selection). Поэтому тесты, которым нужно изменить
 * содержание, достают реальный экземпляр редактора по элементу и вызывают
 * его команды — это ровно тот же путь, что и внешний `value`-prop.
 */
const editorsByElement = new Map<HTMLElement, Editor>();

/** Вернуть живой экземпляр редактора, смонтированный на элементе. */
export function getMarkdownEditorInstance(
  element: Element | null,
): Editor | undefined {
  return element instanceof HTMLElement
    ? editorsByElement.get(element)
    : undefined;
}

export interface MarkdownEditorProps {
  id?: string;
  value: string;
  onChange: (markdown: string) => void;
  placeholder?: string;
  disabled?: boolean;
  minHeight?: string;
  'aria-label'?: string;
}

interface ToolbarButton {
  key: string;
  label: string;
  title: string;
  /** Доступное имя кнопки. По умолчанию = `title`, но для заголовков
   * отличается: `title` — тултип «Заголовок N», а accessible name — «HN»,
   * чтобы не ловиться substring-матчем Playwright `getByLabel('Заголовок')`. */
  ariaLabel?: string;
  isActive: (editor: Editor) => boolean;
  run: (editor: Editor) => void;
}

/**
 * Кнопки тулбара покрывают ровно те узлы markdown, которые умеет
 * сериализовать `@tiptap/markdown`: заголовки 1-3, bold/italic/strike,
 * inline code, code block, списки, цитата, ссылка и hr. Underline отключён
 * в StarterKit (в markdown нет эквивалента — сериализация была бы lossy).
 */
const TOOLBAR: ToolbarButton[] = [
  {
    key: 'h1',
    label: 'H1',
    title: 'Заголовок 1',
    ariaLabel: 'H1',
    isActive: (editor) => editor.isActive('heading', { level: 1 }),
    run: (editor) => editor.chain().focus().toggleHeading({ level: 1 }).run(),
  },
  {
    key: 'h2',
    label: 'H2',
    title: 'Заголовок 2',
    ariaLabel: 'H2',
    isActive: (editor) => editor.isActive('heading', { level: 2 }),
    run: (editor) => editor.chain().focus().toggleHeading({ level: 2 }).run(),
  },
  {
    key: 'h3',
    label: 'H3',
    title: 'Заголовок 3',
    ariaLabel: 'H3',
    isActive: (editor) => editor.isActive('heading', { level: 3 }),
    run: (editor) => editor.chain().focus().toggleHeading({ level: 3 }).run(),
  },
  {
    key: 'bold',
    label: 'B',
    title: 'Жирный',
    isActive: (editor) => editor.isActive('bold'),
    run: (editor) => editor.chain().focus().toggleBold().run(),
  },
  {
    key: 'italic',
    label: 'I',
    title: 'Курсив',
    isActive: (editor) => editor.isActive('italic'),
    run: (editor) => editor.chain().focus().toggleItalic().run(),
  },
  {
    key: 'strike',
    label: 'S',
    title: 'Зачёркнутый',
    isActive: (editor) => editor.isActive('strike'),
    run: (editor) => editor.chain().focus().toggleStrike().run(),
  },
  {
    key: 'code',
    label: '</>',
    title: 'Инлайн-код',
    isActive: (editor) => editor.isActive('code'),
    run: (editor) => editor.chain().focus().toggleCode().run(),
  },
  {
    key: 'codeBlock',
    label: '{ }',
    title: 'Блок кода',
    isActive: (editor) => editor.isActive('codeBlock'),
    run: (editor) => editor.chain().focus().toggleCodeBlock().run(),
  },
  {
    key: 'bulletList',
    label: '•',
    title: 'Маркированный список',
    isActive: (editor) => editor.isActive('bulletList'),
    run: (editor) => editor.chain().focus().toggleBulletList().run(),
  },
  {
    key: 'orderedList',
    label: '1.',
    title: 'Нумерованный список',
    isActive: (editor) => editor.isActive('orderedList'),
    run: (editor) => editor.chain().focus().toggleOrderedList().run(),
  },
  {
    key: 'blockquote',
    label: '❝',
    title: 'Цитата',
    isActive: (editor) => editor.isActive('blockquote'),
    run: (editor) => editor.chain().focus().toggleBlockquote().run(),
  },
  {
    key: 'link',
    label: '🔗',
    title: 'Ссылка',
    isActive: (editor) => editor.isActive('link'),
    run: (editor) => {
      const previous = editor.getAttributes('link').href as string | undefined;
      const href = window.prompt('URL ссылки', previous ?? 'https://');
      if (href === null) return;
      if (href === '') {
        editor.chain().focus().extendMarkRange('link').unsetLink().run();
        return;
      }
      editor
        .chain()
        .focus()
        .extendMarkRange('link')
        .setLink({ href })
        .run();
    },
  },
  {
    key: 'hr',
    label: '—',
    title: 'Разделитель',
    isActive: () => false,
    run: (editor) => editor.chain().focus().setHorizontalRule().run(),
  },
];

/**
 * Набор расширений редактора: StarterKit (без underline — в markdown нет
 * эквивалента), официальный `Markdown` и Placeholder. Один и тот же набор
 * используется компонентом и headless-тестами round-trip.
 */
export function markdownEditorExtensions(placeholder = ''): Extensions {
  return [
    StarterKit.configure({
      underline: false,
      link: { openOnClick: false, autolink: true },
      heading: { levels: [1, 2, 3] },
    }),
    Markdown,
    Placeholder.configure({ placeholder }),
  ];
}

/**
 * Контролируемый markdown-редактор на Tiptap v3 с официальным
 * `@tiptap/markdown`. Значение на входе — markdown-строка, на выходе
 * (`onChange`) — markdown, сериализованный текущим документом.
 *
 * Контроль без петель и скачков курсора: последний собственный emit
 * запоминается в ref; внешний `value` применяется только если он от него
 * отличается.
 */
export default function MarkdownEditor({
  id,
  value,
  onChange,
  placeholder = '',
  disabled = false,
  minHeight,
  'aria-label': ariaLabel,
}: MarkdownEditorProps) {
  const lastEmitted = useRef(value);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  const editor = useEditor({
    extensions: markdownEditorExtensions(placeholder),
    content: value,
    contentType: 'markdown',
    editable: !disabled,
    onUpdate: ({ editor: current }) => {
      const markdown = current.getMarkdown();
      lastEmitted.current = markdown;
      onChangeRef.current(markdown);
    },
    editorProps: {
      attributes: {
        class: 'markdown-editor-content',
        ...(id ? { id } : {}),
        ...(ariaLabel ? { 'aria-label': ariaLabel } : {}),
        ...(minHeight ? { style: `min-height:${minHeight}` } : {}),
      },
    },
  });

  // Внешнее обновление значения (сброс формы после отправки, загрузка
  // черновика) — только когда оно реально разошлось с последним emit.
  useEffect(() => {
    if (!editor) return;
    if (value === lastEmitted.current) return;
    editor.commands.setContent(value, { contentType: 'markdown' });
    lastEmitted.current = value;
  }, [editor, value]);

  useEffect(() => {
    editor?.setEditable(!disabled);
  }, [editor, disabled]);

  // Регистрируем живой экземпляр для интроспекции (тесты/автоматизация).
  useEffect(() => {
    if (!editor) return;
    const element = editor.view.dom;
    editorsByElement.set(element, editor);
    return () => {
      editorsByElement.delete(element);
    };
  }, [editor]);

  const active = useEditorState({
    editor,
    selector: ({ editor: current }) => {
      if (!current) return {} as Record<string, boolean>;
      return Object.fromEntries(TOOLBAR.map((b) => [b.key, b.isActive(current)]));
    },
  });

  return (
    <div className="markdown-editor border border-[#008F11] bg-[#0D0208]">
      <div
        role="toolbar"
        aria-label="Форматирование"
        className="flex flex-wrap items-center gap-1 border-b border-[#008F11] bg-[#0D0208] px-1.5 py-1"
      >
        {TOOLBAR.map((button) => (
          <button
            key={button.key}
            type="button"
            title={button.title}
            aria-label={button.ariaLabel ?? button.title}
            aria-pressed={Boolean(active?.[button.key])}
            disabled={disabled || !editor}
            className={
              'markdown-editor-toolbar-button min-w-7 px-1.5 py-0.5 text-xs ' +
              (active?.[button.key]
                ? 'border border-[#00FF41] bg-[#008F11]/30 text-[#00FF41]'
                : 'border border-transparent text-[#00FF41]/70 hover:border-[#008F11] hover:text-[#00FF41]')
            }
            // preventDefault сохраняет фокус и выделение в редакторе,
            // иначе команда применится к потерянному selection.
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => editor && button.run(editor)}
          >
            {button.label}
          </button>
        ))}
      </div>
      <EditorContent editor={editor} className="markdown-editor-surface" />
    </div>
  );
}