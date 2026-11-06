import type { Diagram, DiagramStatus } from '../schema';
import { escapeHtml } from '../html';
import {
  ARROW,
  EDGE,
  LINE_HEIGHT,
  centerText,
  color,
  elbow,
  leftText,
  wrapLabel,
  type RenderedDiagram,
} from './primitives';

interface FlowNode {
  label: string;
  status?: DiagramStatus;
}

function flowNode(node: string | FlowNode): FlowNode {
  return typeof node === 'string' ? { label: node } : node;
}

export function renderFlow(
  diagram: Extract<Diagram, { kind: 'flow' }>,
): RenderedDiagram {
  const nodes = diagram.nodes.map(flowNode);
  const perRow = Math.min(nodes.length, 4);
  const gapX = 44;
  const gapY = 56;
  const padding = 20;
  const nodeW = 168;
  const wrapped = nodes.map((node) => wrapLabel(node.label));
  const heights = wrapped.map((lines) =>
    Math.max(48, lines.length * LINE_HEIGHT + 22),
  );
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
                (source.y + target.y) / 2 +
                (sameRow ? nodeH / 2 : nodeH / 2 + 6);
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
      return `<g><rect x="${spot.x}" y="${spot.y}" width="${nodeW}" height="${nodeH}" rx="10" fill="var(--panel)" stroke="var(--border)"/><rect x="${spot.x}" y="${spot.y}" width="4" height="${nodeH}" rx="2" fill="${accent}"/>${dot}${centerText(spot.x + nodeW / 2, spot.y + nodeH / 2, lines)}</g>`;
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