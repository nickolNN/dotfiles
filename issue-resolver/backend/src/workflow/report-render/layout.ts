import type { Heading } from './markdown';
import type { Diagram } from './schema';

export interface MrLink {
  href: string;
  text: string;
}

export interface AsciiFigure {
  text: string;
}

export interface DocumentParts {
  answer: string;
  execution: string;
  metrology: string;
  mrLinks: MrLink[];
}

const EXECUTION_LABEL =
  /(execution|выполнени|итерац|iteration|timeline|таймлайн|change set|изменени|шаг|step|findings|дефект|merge request|reproduction|воспроизв|provenance|метрик|metrology)/i;

const METROLOGY_KEY =
  /<strong>[^<]*?(Status|Generated|Iterations|Repositories|Репозитории|Итерации|Статус)[^<]*?<\/strong>/g;

const MR_HREF = /\/pull\/|merge_request|\/pull-requests\/|\/merge_requests\//i;

const BLOCK = /<(h1|h2|p)\b([^>]*)>([\s\S]*?)<\/\1>/g;

type BlockKind = 'h1' | 'h2' | 'p' | 'other';

interface Block {
  kind: BlockKind;
  html: string;
  id: string;
  text: string;
  execution: boolean;
}

function plain(html: string): string {
  return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function blocks(html: string): Block[] {
  const parsed: Block[] = [];
  let cursor = 0;
  for (const match of html.matchAll(BLOCK)) {
    const at = match.index ?? 0;
    if (at > cursor) {
      parsed.push({ kind: 'other', html: html.slice(cursor, at), id: '', text: '', execution: false });
    }
    const id = /id="([^"]*)"/.exec(match[2])?.[1] ?? '';
    const text = plain(match[3]);
    parsed.push({
      kind: match[1] as BlockKind,
      html: match[0],
      id,
      text,
      execution: EXECUTION_LABEL.test(id) || EXECUTION_LABEL.test(text),
    });
    cursor = at + match[0].length;
  }
  if (cursor < html.length) {
    parsed.push({ kind: 'other', html: html.slice(cursor), id: '', text: '', execution: false });
  }
  const inExecution = parsed.some((block) => block.kind === 'h2' && block.execution);
  if (!inExecution) return parsed;
  let execution = false;
  for (const block of parsed) {
    if (block.kind === 'h2') execution = block.execution;
    if (block.kind !== 'h2') block.execution = execution;
  }
  return parsed;
}

function metrologyParagraph(block: Block): boolean {
  if (block.kind !== 'p') return false;
  return (block.html.match(METROLOGY_KEY) ?? []).length >= 2;
}

function links(html: string): MrLink[] {
  const found: MrLink[] = [];
  for (const match of html.matchAll(/<a href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g)) {
    const href = match[1].replace(/&amp;/g, '&');
    if (!MR_HREF.test(href)) continue;
    const text = plain(match[2]);
    found.push({ href, text });
  }
  return found;
}

export function splitDocument(html: string): DocumentParts {
  const parts: DocumentParts = { answer: '', execution: '', metrology: '', mrLinks: [] };
  const seen = new Set<string>();
  for (const block of blocks(html)) {
    for (const link of links(block.html)) {
      if (seen.has(link.href)) continue;
      seen.add(link.href);
      parts.mrLinks.push(link);
    }
    if (block.kind === 'h1') continue;
    if (block.kind === 'h2' && block.execution) continue;
    if (metrologyParagraph(block)) {
      parts.metrology += `<p class="metrology">${block.html.slice(3, -4)}</p>`;
      continue;
    }
    if (block.execution) parts.execution += block.html;
    else parts.answer += block.html;
  }
  return parts;
}

function diagramLabels(diagram: Diagram): string[] {
  if (diagram.kind === 'flow') {
    return diagram.nodes.map((node) => (typeof node === 'string' ? node : node.label));
  }
  if (diagram.kind === 'bars') return diagram.items.map((item) => item.label);
  if (diagram.kind === 'matrix') {
    return [...diagram.columns, ...diagram.rows.map((row) => row.label)];
  }
  return [];
}

export function diagramIsExecution(diagram: Diagram): boolean {
  const labels = diagramLabels(diagram).join(' ');
  return EXECUTION_LABEL.test('title' in diagram ? (diagram.title ?? '') : '') ||
    EXECUTION_LABEL.test(labels);
}

export function isExecutionHeading(heading: Heading): boolean {
  return EXECUTION_LABEL.test(heading.text) || EXECUTION_LABEL.test(heading.id);
}

export function executionMetrics<T extends { label: string }>(metrics: T[]): {
  hero: T[];
  details: T[];
} {
  return {
    hero: metrics.filter((metric) => !EXECUTION_LABEL.test(metric.label)),
    details: metrics.filter((metric) => EXECUTION_LABEL.test(metric.label)),
  };
}

const STOP_WORDS = new Set([
  'flow',
  'the',
  'and',
  'with',
  'from',
  'для',
  'как',
  'или',
  'это',
  'при',
  'чем',
  'над',
]);

function words(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word.length >= 4 && !STOP_WORDS.has(word));
}

export function duplicatesAscii(title: string, figures: AsciiFigure[]): boolean {
  if (figures.length === 0) return false;
  const keys = words(title);
  if (keys.length === 0) return false;
  return figures.some((figure) => {
    const hits = keys.filter((word) => figure.text.includes(word)).length;
    return hits >= Math.max(2, Math.ceil(keys.length * 0.5));
  });
}