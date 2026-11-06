import { DiagramStatus, type Diagram } from '../schema';
import { escapeHtml } from '../html';
import {
  PALETTE,
  isDiagramStatus,
  wrapLabel,
  type RenderedDiagram,
} from './primitives';

export function renderMatrix(
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
          const known = isDiagramStatus(value) ? value : DiagramStatus.na;
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