import { escapeHtml } from '../html';
import { shotFigure, shotName } from './shots';

export function slug(text: string): string {
  const plain = text
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\*\*([^*]*)\*\*/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .trim()
    .toLowerCase();
  const slugged = plain
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '');
  return slugged === '' ? 'section' : slugged;
}

export function safeHref(raw: string): string | null {
  const href = raw.trim();
  if (href === '') return null;
  if (/^(https?:|#|\.{0,2}\/)/i.test(href)) return href;
  if (/^[a-z][a-z0-9+.-]*:/i.test(href)) return null;
  return href;
}

const IMAGE = /!\[([^\]]*)\]\(([^)\s]+)\)/g;

export function inline(text: string): string {
  const codeSpans: string[] = [];
  const withoutCode = text.replace(/`([^`]+)`/g, (_, code: string) => {
    codeSpans.push(`<code>${escapeHtml(code)}</code>`);
    return `\u0000${codeSpans.length - 1}\u0000`;
  });

  let html = escapeHtml(withoutCode);
  html = html.replace(IMAGE, (_match, alt: string, path: string) => {
    const name = shotName(path);
    if (name === null) return alt;
    return shotFigure(path, alt, false);
  });
  html = html.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_match, label, href) => {
    const target = safeHref(href);
    if (target === null) return label;
    return `<a href="${escapeHtml(target)}" rel="noreferrer noopener">${label}</a>`;
  });
  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>');
  html = html.replace(
    /\u0000(\d+)\u0000/g,
    (_, index: string) => codeSpans[Number(index)] ?? '',
  );
  return html;
}