import { FindingSeverity, StepReportStatus } from '@issue-resolver/shared';
import { inline } from './inline';

const TABLE_ONLY_SEVERITIES = [
  'trivial',
  'running',
  'na',
  'ok',
  'error',
] as const;

const SEVERITIES: ReadonlySet<string> = new Set([
  StepReportStatus.pass,
  StepReportStatus.fail,
  StepReportStatus.blocked,
  FindingSeverity.critical,
  FindingSeverity.major,
  FindingSeverity.minor,
  ...TABLE_ONLY_SEVERITIES,
]);

function severityClass(cell: string): string | null {
  const value = cell.trim().toLowerCase();
  return SEVERITIES.has(value) ? `sev-${value}` : null;
}

export function renderTable(lines: string[]): string {
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

export function renderList(lines: string[]): string {
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