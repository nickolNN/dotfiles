import { escapeHtml } from './html';
import type { AsciiFigure } from './layout';
import { renderList, renderTable } from './md/blocks';
import { inline, slug } from './md/inline';
import {
  collectedShots,
  figuresForMentions,
  resetShots,
  shotFigure,
} from './md/shots';

export interface Heading {
  level: number;
  id: string;
  text: string;
}

export interface RenderedMarkdown {
  html: string;
  headings: Heading[];
  screenshots: string[];
  ascii: AsciiFigure[];
}

const BOX_DRAWING = /[┌┐└┘├┤┬┴┼│─▼▲►◄→←↑↓]/;

const IMAGE_ONLY = /^!\[([^\]]*)\]\(([^)\s]+)\)$/;

export function renderMarkdown(
  source: string,
  available: string[] = [],
): RenderedMarkdown {
  resetShots();
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

  const pushFigures = (text: string): void => {
    if (available.length === 0) return;
    out.push(figuresForMentions(text, available, mentioned));
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
      while (
        index < lines.length &&
        !lines[index].trim().startsWith(marker.repeat(3))
      ) {
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

    if (
      trimmed.startsWith('|') &&
      /^\|?[\s:|-]+\|?$/.test((lines[index + 1] ?? '').trim())
    ) {
      const block: string[] = [line];
      index += 1;
      while (index < lines.length && lines[index].trim().startsWith('|')) {
        block.push(lines[index]);
        index += 1;
      }
      index -= 1;
      out.push(renderTable(block));
      pushFigures(block.join(' '));
      continue;
    }

    if (/^(\s*)([-*+]|\d+\.)\s+/.test(line)) {
      const block: string[] = [line];
      while (
        index + 1 < lines.length &&
        /^(\s*)([-*+]|\d+\.)\s+/.test(lines[index + 1])
      ) {
        index += 1;
        block.push(lines[index]);
      }
      out.push(renderList(block));
      pushFigures(block.join(' '));
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
    pushFigures(text);
  }

  return {
    html: out.join('\n'),
    headings,
    screenshots: collectedShots(),
    ascii,
  };
}