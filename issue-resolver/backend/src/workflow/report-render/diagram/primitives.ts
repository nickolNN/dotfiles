import type { DiagramStatus } from '../schema';
import { escapeHtml } from '../html';

export interface RenderedDiagram {
  svg: string;
  warnings: string[];
}

export const PALETTE: Record<DiagramStatus, string> = {
  pass: 'var(--pass)',
  fail: 'var(--fail)',
  blocked: 'var(--blocked)',
  running: 'var(--running)',
  na: 'var(--na)',
};

export const LINE_HEIGHT = 16;

const FONT_SIZE = 12;
const LABEL_WIDTH = 24;

export function isDiagramStatus(value: unknown): value is DiagramStatus {
  return typeof value === 'string' && Object.hasOwn(PALETTE, value);
}

export function color(
  status: string | undefined,
  fallback = 'var(--accent)',
): string {
  return isDiagramStatus(status) ? PALETTE[status] : fallback;
}

export function wrapLabel(text: string, maxChars = LABEL_WIDTH): string[] {
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
    lines.push(
      rest.length > maxChars ? `${rest.slice(0, maxChars - 1)}…` : rest,
    );
  }
  return lines;
}

export function centerText(
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

export function leftText(
  x: number,
  y: number,
  text: string,
  fill = 'var(--muted)',
): string {
  return `<text x="${x}" y="${y}" font-size="11" fill="${fill}">${escapeHtml(text)}</text>`;
}

export const ARROW = `<defs><marker id="arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 z" fill="currentColor"/></marker></defs>`;
export const EDGE =
  'class="edge" fill="none" stroke="currentColor" stroke-width="1.5" marker-end="url(#arrow)"';

export function elbow(
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