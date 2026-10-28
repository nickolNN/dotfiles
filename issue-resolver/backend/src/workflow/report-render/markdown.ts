
export interface Heading {
  level: number;
  id: string;
  text: string;
}

import type { AsciiFigure } from './layout';

export interface RenderedMarkdown {
  html: string;
  headings: Heading[];
  screenshots: string[];
  ascii: AsciiFigure[];
}

const BOX_DRAWING = /[┌┐└┘├┤┬┴┼│─▼▲►◄→←↑↓]/;

const IMAGE_ONLY = /^!\[([^\]]*)\]\(([^)\s]+)\)$/;
const IMAGE = /!\[([^\]]*)\]\(([^)\s]+)\)/g;
const IMAGE_PATH = /\.(?:png|jpe?g|webp|gif)$/i;

const SEVERITIES = new Set([
  'pass',
  'fail',
  'blocked',
  'running',
  'na',
  'major',
  'minor',
  'trivial',
  'critical',
  'ok',
  'error',
]);

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function slug(text: string): string {
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

function safeHref(raw: string): string | null {
  const href = raw.trim();
  if (href === '') return null;
  if (/^(https?:|#|\.{0,2}\/)/i.test(href)) return href;
  if (/^[a-z][a-z0-9+.-]*:/i.test(href)) return null;
  return href;
}

export function shotName(raw: string): string | null {
  const path = raw.trim().replace(/^\.\//, '');
  if (path === '' || /^[a-z][a-z0-9+.-]*:/i.test(path)) return null;
  if (path.startsWith('/') || path.split('/').includes('..')) return null;
  if (!IMAGE_PATH.test(path)) return null;
  return path.split('/').pop() ?? null;
}

const shots: string[] = [];

function shotFigure(path: string, caption: string, block: boolean): string {
  const name = shotName(path);
  if (name === null) return caption;
  if (!shots.includes(name)) shots.push(name);
  const alt = caption.trim() === '' ? name : caption.trim();
  const inner = `<a class="shot-link" href="#"><img${block ? ' class="shot-image"' : ' class="inline-shot"'} data-slot="${escapeHtml(name)}" alt="${escapeHtml(alt)}" loading="lazy"></a>`;
  if (!block) return inner;
  return `<figure class="shot">${inner}<figcaption>${escapeHtml(alt)}</figcaption></figure>`;
}

function inline(text: string): string {
  const codeSpans: string[] = [];
  const withoutCode = text.replace(/`([^`]+)`/g, (_, code: string) => {
    codeSpans.push(`<code>${escapeHtml(code)}</code>`);
    return `\u0000${codeSpans.length - 1}\u0000`;
  });

  let html = escapeHtml(withoutCode);
  html = html.replace(IMAGE, (match, alt: string, path: string) => {
    const name = shotName(path);
    if (name === null) return alt;
    return shotFigure(path, alt, false);
  });
  html = html.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (match, label, href) => {
    const target = safeHref(href);
    if (target === null) return label;
    return `<a href="${escapeHtml(target)}" rel="noreferrer noopener">${label}</a>`;
  });
  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>');
  html = html.replace(/\u0000(\d+)\u0000/g, (_, index: string) => codeSpans[Number(index)] ?? '');
  return html;
}

function severityClass(cell: string): string | null {
  const value = cell.trim().toLowerCase();
  return SEVERITIES.has(value) ? `sev-${value}` : null;
}

function renderTable(lines: string[]): string {
  const cellsOf = (line: string): string[] =>
    line
      .replace(/^\s*\|/, '')
      .replace(/\|\s*$/, '')
      .split('|')
      .map((cell) => cell.trim());

  const header = cellsOf(lines[0]);
  const body = lines.slice(2).map(cellsOf);
  const head = header.map((cell) => `<th>${inline(cell)}</th>`).join('');
  const rows = body
    .map((cells) => {
      const tds = header
        .map((_, index) => {
          const cell = cells[index] ?? '';
          const cls = severityClass(cell);
          const attr = cls ? ` class="${cls}"` : '';
          return `<td${attr}>${inline(cell)}</td>`;
        })
        .join('');
      return `<tr>${tds}</tr>`;
    })
    .join('');
  return `<div class="table-wrap"><table><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table></div>`;
}

function renderList(lines: string[]): string {
  const items = lines.map((line) => {
    const match = /^(\s*)([-*+]|\d+\.)\s+(.*)$/.exec(line) ?? [];
    return { indent: match[1]?.length ?? 0, text: match[3] ?? line.trim() };
  });
  const base = Math.min(...items.map((item) => item.indent));
  let html = '<ul>';
  let open = false;
  for (const item of items) {
    if (item.indent > base) {
      if (!open) {
        html += '<ul>';
        open = true;
      }
      html += `<li>${inline(item.text)}</li>`;
      continue;
    }
    if (open) {
      html += '</ul>';
      open = false;
    }
    html += `<li>${inline(item.text)}</li>`;
  }
  if (open) html += '</ul>';
  return `${html}</ul>`;
}

const SHOT_MENTION = /`?([\w./-]*?)([\w-]+\.(?:png|jpe?g|webp|gif))`?/gi;

function figuresForMentions(
  text: string,
  available: string[],
  used: Set<string>,
): string {
  const figures: string[] = [];
  for (const match of text.matchAll(SHOT_MENTION)) {
    const name = match[2];
    if (!available.includes(name) || used.has(name)) continue;
    used.add(name);
    if (!shots.includes(name)) shots.push(name);
    figures.push(
      `<figure class="shot"><a class="shot-link" href="#"><img class="shot-image" data-slot="${escapeHtml(name)}" alt="${escapeHtml(name)}" loading="lazy"></a></figure>`,
    );
  }
  return figures.join('');
}

export function renderMarkdown(
  source: string,
  available: string[] = [],
): RenderedMarkdown {
  shots.length = 0;
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  const out: string[] = [];
  const headings: Heading[] = [];
  const usedIds = new Map<string, number>();
  const mentioned = new Set<string>();
  const ascii: AsciiFigure[] = [];

  const addHeading = (level: number, text: string): void => {
    const base = slug(text);
    const seen = usedIds.get(base) ?? 0;
    usedIds.set(base, seen + 1);
    const id = seen === 0 ? base : `${base}-${seen + 1}`;
    headings.push({ level, id, text });
    out.push(`<h${level} id="${id}">${inline(text)}</h${level}>`);
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const trimmed = line.trim();

    if (trimmed === '') continue;

    const fence = /^(```+|~~~+)\s*([\w+-]*)\s*$/.exec(trimmed);
    if (fence) {
      const marker = fence[1][0];
      const language = fence[2];
      const body: string[] = [];
      index += 1;
      while (index < lines.length && !lines[index].trim().startsWith(marker.repeat(3))) {
        body.push(lines[index]);
        index += 1;
      }
      const cls = language ? ` class="language-${escapeHtml(language)}"` : '';
      const text = body.join('\n');
      if (BOX_DRAWING.test(text)) ascii.push({ text: text.toLowerCase() });
      out.push(`<pre><code${cls}>${escapeHtml(text)}</code></pre>`);
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(trimmed);
    if (heading) {
      addHeading(heading[1].length, heading[2].trim());
      continue;
    }

    if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
      out.push('<hr>');
      continue;
    }

    if (trimmed.startsWith('|') && /^\|?[\s:|-]+\|?$/.test((lines[index + 1] ?? '').trim())) {
      const block: string[] = [line];
      index += 1;
      while (index < lines.length && lines[index].trim().startsWith('|')) {
        block.push(lines[index]);
        index += 1;
      }
      index -= 1;
      out.push(renderTable(block));
      if (available.length > 0) {
        out.push(figuresForMentions(block.join(' '), available, mentioned));
      }
      continue;
    }

    if (/^(\s*)([-*+]|\d+\.)\s+/.test(line)) {
      const block: string[] = [line];
      while (index + 1 < lines.length && /^(\s*)([-*+]|\d+\.)\s+/.test(lines[index + 1])) {
        index += 1;
        block.push(lines[index]);
      }
      out.push(renderList(block));
      if (available.length > 0) {
        out.push(figuresForMentions(block.join(' '), available, mentioned));
      }
      continue;
    }

    if (trimmed.startsWith('>')) {
      const block: string[] = [];
      while (index < lines.length && lines[index].trim().startsWith('>')) {
        block.push(lines[index].trim().replace(/^>\s?/, ''));
        index += 1;
      }
      index -= 1;
      out.push(`<blockquote>${inline(block.join(' '))}</blockquote>`);
      continue;
    }

    const single = IMAGE_ONLY.exec(trimmed);
    if (single) {
      out.push(shotFigure(single[2], single[1], true));
      continue;
    }

    const paragraph: string[] = [trimmed];
    while (index + 1 < lines.length) {
      const next = lines[index + 1];
      const nextTrimmed = next.trim();
      if (
        nextTrimmed === '' ||
        /^(#{1,6})\s+/.test(nextTrimmed) ||
        nextTrimmed.startsWith('```') ||
        nextTrimmed.startsWith('~~~') ||
        nextTrimmed.startsWith('|') ||
        nextTrimmed.startsWith('>') ||
        /^(\s*)([-*+]|\d+\.)\s+/.test(next) ||
        /^(-{3,}|\*{3,}|_{3,})$/.test(nextTrimmed)
      ) {
        break;
      }
      index += 1;
      paragraph.push(nextTrimmed);
    }
    const text = paragraph.join(' ');
    out.push(`<p>${inline(text)}</p>`);
    if (available.length > 0) out.push(figuresForMentions(text, available, mentioned));
  }

  return { html: out.join('\n'), headings, screenshots: [...shots], ascii };
}