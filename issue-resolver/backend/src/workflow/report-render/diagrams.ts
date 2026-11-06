import { escapeHtml } from './html';
import type { Diagram } from './schema';
import { renderBars } from './diagram/bars';
import { renderFlow } from './diagram/flow';
import { renderMatrix } from './diagram/matrix';
import type { RenderedDiagram } from './diagram/primitives';
import { sanitizeSvg } from './diagram/sanitize';

export type { RenderedDiagram } from './diagram/primitives';

export function renderDiagram(
  diagram: Diagram,
  verdict?: string,
): RenderedDiagram {
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