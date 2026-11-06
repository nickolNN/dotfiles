import type { WorkspaceFile } from '@issue-resolver/shared';

export const PreviewKind = Object.freeze({
  image: 'image',
  html: 'html',
  pdf: 'pdf',
  markdown: 'markdown',
  json: 'json',
  text: 'text',
  unsupported: 'unsupported',
} as const);
export type PreviewKind = (typeof PreviewKind)[keyof typeof PreviewKind];

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

export function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot === -1 ? '' : name.slice(dot + 1).toLowerCase();
}

export function previewKind(file: WorkspaceFile): PreviewKind {
  const mime = file.mime_type ?? '';
  const ext = extensionOf(file.name) || extensionOf(file.rel_path);
  if (mime === 'application/pdf' || ext === 'pdf') return PreviewKind.pdf;
  if (mime.startsWith('image/')) return PreviewKind.image;
  if (mime === 'text/html' || ext === 'html' || ext === 'htm') {
    return PreviewKind.html;
  }
  if (mime === 'text/markdown' || ext === 'md' || ext === 'markdown') {
    return PreviewKind.markdown;
  }
  if (mime === 'application/json' || ext === 'json') return PreviewKind.json;
  if (mime.startsWith('text/')) return PreviewKind.text;
  if (TEXT_EXTENSIONS.has(ext)) return PreviewKind.text;
  return PreviewKind.unsupported;
}