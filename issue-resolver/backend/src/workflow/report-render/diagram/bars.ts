import type { Diagram } from '../schema';
import { escapeHtml } from '../html';
import {
  color,
  wrapLabel,
  type RenderedDiagram,
} from './primitives';

function ticks(total: number, count = 4): number[] {
  const step = total / count;
  return Array.from({ length: count + 1 }, (_, index) => index * step);
}

export function renderBars(
  diagram: Extract<Diagram, { kind: 'bars' }>,
): RenderedDiagram {
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