import type { Diagram, DiagramStatus } from './schema';

export interface RenderedDiagram {
  svg: string;
  warnings: string[];
}

const PALETTE: Record<DiagramStatus, string> = {
  pass: 'var(--pass)',
  fail: 'var(--fail)',
  blocked: 'var(--blocked)',
  running: 'var(--running)',
  na: 'var(--na)',
};

const FONT_SIZE = 12;
const LINE_HEIGHT = 16;
const LABEL_WIDTH = 24;

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function color(status: string | undefined, fallback = 'var(--accent)'): string {
  const known = (status ?? '') as DiagramStatus;
  return PALETTE[known] ?? fallback;
}

function wrapLabel(text: string, maxChars = LABEL_WIDTH): string[] {
  const words = text.trim().split(/\s+/).filter((word) => word !== '');
  if (words.length === 0) return [''];
  const lines: string[] = [];
  let current = '';
  for (const word of words) {
    if (current === '') {
      current = word;
      continue;
    }
    if (`${current} ${word}`.length <= maxChars) {
      current = `${current} ${word}`;
      continue;
    }
    lines.push(current);
    current = word;
  }
  if (current !== '') lines.push(current);
  if (lines.length > 3) {
    const rest = lines.slice(2).join(' ');
    lines.length = 2;
    lines.push(rest.length > maxChars ? `${rest.slice(0, maxChars - 1)}…` : rest);
  }
  return lines;
}

function centerText(
  x: number,
  centerY: number,
  lines: string[],
  options: { size?: number; fill?: string; weight?: number } = {},
): string {
  const size = options.size ?? FONT_SIZE;
  const fill = options.fill ?? 'var(--text)';
  const weight = options.weight ? ` font-weight="${options.weight}"` : '';
  const first = centerY - ((lines.length - 1) * LINE_HEIGHT) / 2;
  const spans = lines
    .map(
      (line, index) =>
        `<tspan x="${x}" y="${first + index * LINE_HEIGHT}">${escapeHtml(line)}</tspan>`,
    )
    .join('');
  return `<text x="${x}" text-anchor="middle" font-size="${size}" fill="${fill}"${weight}>${spans}</text>`;
}

function leftText(x: number, y: number, text: string, fill = 'var(--muted)'): string {
  return `<text x="${x}" y="${y}" font-size="11" fill="${fill}">${escapeHtml(text)}</text>`;
}

const ARROW = `<defs><marker id="arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 z" fill="currentColor"/></marker></defs>`;
const EDGE = 'class="edge" fill="none" stroke="currentColor" stroke-width="1.5" marker-end="url(#arrow)"';

function elbow(
  from: { x: number; y: number },
  to: { x: number; y: number },
  sameRow: boolean,
): string {
  if (sameRow) {
    const midX = from.x + (to.x - from.x) / 2;
    const direction = to.x > from.x ? 1 : -1;
    return `M${from.x},${from.y} H${midX - 8 * direction} Q${midX},${from.y} ${midX},${from.y + direction * 0} V${to.y} Q${midX},${to.y} ${midX + 8 * direction},${to.y} H${to.x}`;
  }
  const midY = from.y + (to.y - from.y) / 2;
  return `M${from.x},${from.y} V${midY - 8} Q${from.x},${midY} ${from.x + 8},${midY} H${to.x - 8} Q${to.x},${midY} ${to.x},${midY + 8} V${to.y}`;
}

interface FlowNode {
  label: string;
  status?: DiagramStatus;
}

function flowNode(node: string | FlowNode): FlowNode {
  return typeof node === 'string' ? { label: node } : node;
}

function renderFlow(diagram: Extract<Diagram, { kind: 'flow' }>): RenderedDiagram {
  const nodes = diagram.nodes.map(flowNode);
  const perRow = Math.min(nodes.length, 4);
  const gapX = 44;
  const gapY = 56;
  const padding = 20;
  const nodeW = 168;
  const wrapped = nodes.map((node) => wrapLabel(node.label));
  const heights = wrapped.map((lines) => Math.max(48, lines.length * LINE_HEIGHT + 22));
  const nodeH = Math.max(...heights);

  const rows = Math.ceil(nodes.length / perRow);
  const width = padding * 2 + perRow * nodeW + (perRow - 1) * gapX;
  const height = padding * 2 + rows * nodeH + (rows - 1) * gapY;

  const position = new Map<number, { x: number; y: number }>();
  nodes.forEach((_, index) => {
    const column = index % perRow;
    const row = Math.floor(index / perRow);
    position.set(index, {
      x: padding + column * (nodeW + gapX),
      y: padding + row * (nodeH + gapY),
    });
  });

  const indexOf = new Map<string, number>();
  nodes.forEach((node, index) => {
    if (!indexOf.has(node.label)) indexOf.set(node.label, index);
  });

  const edges = (diagram.edges ?? [])
    .map((edge) => {
      const [from, to] = Array.isArray(edge) ? edge : [edge.from, edge.to];
      const label = Array.isArray(edge) ? '' : (edge.label ?? '');
      const fromIndex = indexOf.get(from);
      const toIndex = indexOf.get(to);
      if (fromIndex === undefined || toIndex === undefined) return '';
      const source = position.get(fromIndex)!;
      const target = position.get(toIndex)!;
      const sameRow = source.y === target.y;
      const path = sameRow
        ? elbow(
            { x: source.x + nodeW, y: source.y + nodeH / 2 },
            { x: target.x, y: target.y + nodeH / 2 },
            true,
          )
        : elbow(
            { x: source.x + nodeW / 2, y: source.y + nodeH },
            { x: target.x + nodeW / 2, y: target.y },
            false,
          );
      const marker =
        label === ''
          ? ''
          : (() => {
              const midX = (source.x + target.x) / 2 + nodeW / 2;
              const midY =
                (source.y + target.y) / 2 + (sameRow ? nodeH / 2 : nodeH / 2 + 6);
              const w = label.length * 6.2 + 10;
              return `<g><rect x="${midX - w / 2}" y="${midY - 9}" width="${w}" height="16" rx="8" fill="var(--bg)" stroke="var(--border)"/><text x="${midX}" y="${midY + 3}" text-anchor="middle" font-size="10" fill="var(--muted)">${escapeHtml(label)}</text></g>`;
            })();
      return `<path d="${path}" ${EDGE}/>${marker}`;
    })
    .join('');

  const boxes = nodes
    .map((node, index) => {
      const spot = position.get(index)!;
      const lines = wrapped[index];
      const accent = node.status ? color(node.status) : 'var(--border)';
      const dot = node.status
        ? `<circle cx="${spot.x + nodeW - 12}" cy="${spot.y + 12}" r="4" fill="${color(node.status)}"/>`
        : '';
      return `<g>${ARROW.match('<defs') ? '' : ''}<rect x="${spot.x}" y="${spot.y}" width="${nodeW}" height="${nodeH}" rx="10" fill="var(--panel)" stroke="var(--border)"/><rect x="${spot.x}" y="${spot.y}" width="4" height="${nodeH}" rx="2" fill="${accent}"/>${dot}${centerText(spot.x + nodeW / 2, spot.y + nodeH / 2, lines)}</g>`;
    })
    .join('');

  const note = diagram.note
    ? leftText(padding, height + 18, diagram.note)
    : '';

  return {
    svg: `<svg class="diagram diagram-flow" viewBox="0 0 ${width} ${height + (diagram.note ? 30 : 0)}" role="img" aria-label="${escapeHtml(diagram.title)}">${ARROW}${edges}${boxes}${note}</svg>`,
    warnings: [],
  };
}

function ticks(total: number, count = 4): number[] {
  const step = total / count;
  return Array.from({ length: count + 1 }, (_, index) => index * step);
}

function renderBars(diagram: Extract<Diagram, { kind: 'bars' }>): RenderedDiagram {
  const labelW = 150;
  const barH = 16;
  const rowH = 30;
  const width = 700;
  const unit = diagram.unit ?? '';
  const max = Math.max(...diagram.items.map((item) => item.value), 1);
  const plot = width - labelW - 90;
  const height = 20 + diagram.items.length * rowH + 6;

  const grid = ticks(max)
    .map((tick) => {
      const x = labelW + (tick / max) * plot;
      return `<line class="grid" x1="${x.toFixed(1)}" y1="10" x2="${x.toFixed(1)}" y2="${height - 6}" stroke="var(--border)" stroke-dasharray="3 4"/><text x="${x.toFixed(1)}" y="${height - 8 + 0}" text-anchor="middle" font-size="10" fill="var(--muted)">${escapeHtml(`${Math.round(tick)}${unit}`)}</text>`;
    })
    .join('');

  const rows = diagram.items
    .map((item, index) => {
      const y = 12 + index * rowH;
      const barW = Math.max((item.value / max) * plot, 2);
      const label = wrapLabel(item.label, 18)[0];
      return `<g><text x="0" y="${y + barH - 3}" font-size="11" fill="var(--text)">${escapeHtml(label)}</text><rect x="${labelW}" y="${y}" width="${barW.toFixed(1)}" height="${barH}" rx="5" fill="${color(item.status)}"><title>${escapeHtml(`${item.label}: ${item.value}${unit}`)}</title></rect><text x="${(labelW + barW + 8).toFixed(1)}" y="${y + barH - 3}" font-size="11" fill="var(--text)">${escapeHtml(`${item.value}${unit}`)}</text></g>`;
    })
    .join('');

  const baseline = `<line class="axis" x1="${labelW}" y1="8" x2="${labelW}" y2="${height - 4}" stroke="var(--border)"/>`;

  return {
    svg: `<svg class="diagram diagram-bars" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeHtml(diagram.title)}">${grid}${baseline}${rows}</svg>`,
    warnings: [],
  };
}

function renderMatrix(
  diagram: Extract<Diagram, { kind: 'matrix' }>,
): RenderedDiagram {
  const labelW = 150;
  const cellW = 84;
  const cellH = 30;
  const headerH = 26;
  const width = labelW + diagram.columns.length * cellW;
  const height = headerH + diagram.rows.length * cellH + 4;

  const header =
    `<rect x="0" y="0" width="${width}" height="${headerH}" fill="var(--panel)" stroke="var(--border)"/>` +
    diagram.columns
      .map(
        (column, index) =>
          `<text x="${labelW + index * cellW + cellW / 2}" y="${headerH / 2 + 4}" text-anchor="middle" font-size="11" fill="var(--muted)">${escapeHtml(column)}</text>`,
      )
      .join('');

  const body = diagram.rows
    .map((row, rowIndex) => {
      const y = headerH + rowIndex * cellH;
      const band =
        rowIndex % 2 === 0
          ? `<rect x="0" y="${y}" width="${width}" height="${cellH}" fill="var(--bg)" opacity="0.5"/>`
          : '';
      const label = `<text x="8" y="${y + cellH / 2 + 4}" font-size="11" fill="var(--text)">${escapeHtml(wrapLabel(row.label, 20)[0])}</text>`;
      const cells = diagram.columns
        .map((_, columnIndex) => {
          const value = (row.cells[columnIndex] ?? 'na').trim().toLowerCase();
          const known = (value in PALETTE ? value : 'na') as DiagramStatus;
          const x = labelW + columnIndex * cellW;
          return `<g class="cell-${escapeHtml(known)}"><rect x="${x + 3}" y="${y + 3}" width="${cellW - 6}" height="${cellH - 6}" rx="6" fill="${PALETTE[known]}"/><text x="${x + cellW / 2}" y="${y + cellH / 2 + 4}" text-anchor="middle" font-size="10" fill="var(--bg)">${escapeHtml(value)}</text></g>`;
        })
        .join('');
      return band + label + cells;
    })
    .join('');

  return {
    svg: `<svg class="diagram diagram-matrix" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeHtml(diagram.title)}">${header}${body}</svg>`,
    warnings: [],
  };
}

const DISALLOWED_TAG =
  /<\s*(script|iframe|object|embed|foreignObject)\b[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi;
const SELF_CLOSING_DISALLOWED =
  /<\s*(script|iframe|object|embed|foreignObject)\b[^>]*\/?\s*>/gi;
const HANDLER_ATTR = /\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi;
const JS_URL =
  /(href|xlink:href)\s*=\s*("javascript:[^"]*"|'javascript:[^']*'|javascript:[^\s>]*)/gi;

function sanitizeSvg(body: string): { body: string; warnings: string[] } {
  const warnings: string[] = [];
  let clean = body;
  const count = (pattern: RegExp, source: string): number =>
    (source.match(pattern) ?? []).length;

  const scriptTags =
    count(DISALLOWED_TAG, clean) + count(SELF_CLOSING_DISALLOWED, clean);
  if (scriptTags > 0)
    warnings.push(`report.json: ${scriptTags} unsafe element(s) removed from a raw svg`);
  clean = clean.replace(DISALLOWED_TAG, '').replace(SELF_CLOSING_DISALLOWED, '');

  const handlers = count(HANDLER_ATTR, clean);
  if (handlers > 0)
    warnings.push(`report.json: ${handlers} event handler(s) removed from a raw svg`);
  clean = clean.replace(HANDLER_ATTR, '');

  const jsUrls = count(JS_URL, clean);
  if (jsUrls > 0) warnings.push('report.json: javascript: URL removed from a raw svg');
  clean = clean.replace(JS_URL, 'href="#"');
  return { body: clean, warnings };
}

export function renderDiagram(diagram: Diagram, verdict?: string): RenderedDiagram {
  switch (diagram.kind) {
    case 'flow':
      return renderFlow(diagram);
    case 'bars':
      return renderBars(diagram);
    case 'matrix':
      return renderMatrix(diagram);
    case 'svg': {
      const { body, warnings } = sanitizeSvg(diagram.body);
      return {
        svg: `<div class="diagram diagram-raw" data-verdict="${escapeHtml(verdict ?? '')}">${body}</div>`,
        warnings,
      };
    }
    default:
      return { svg: '', warnings: ['report.json: unsupported diagram'] };
  }
}