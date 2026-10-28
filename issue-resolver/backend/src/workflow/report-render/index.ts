import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderReportPage } from './page';

export { parseReportDoc } from './schema';
export type { Diagram, ReportDoc, ReportMetric } from './schema';
export { renderMarkdown } from './markdown';
export { renderDiagram } from './diagrams';
export { renderReportPage } from './page';
export type { RenderPageInput, RenderPageResult } from './page';

export const REPORT_MD_FILE = 'report.md';
export const REPORT_JSON_FILE = 'report.json';
export const REPORT_HTML_FILE = 'report.html';

const SHOT_EXTENSIONS = /\.(png|jpe?g|webp|gif)$/i;

function readText(path: string): string | null {
  try {
    if (statSync(path).size === 0) return null;
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

export function readReportJson(hostDir: string): {
  raw: unknown;
  warnings: string[];
} {
  const text = readText(join(hostDir, REPORT_JSON_FILE));
  if (text === null) return { raw: null, warnings: [] };
  try {
    return { raw: JSON.parse(text) as unknown, warnings: [] };
  } catch (error) {
    return {
      raw: null,
      warnings: [
        `report.json: invalid JSON (${error instanceof Error ? error.message : 'parse error'}) — ignored`,
      ],
    };
  }
}

export function listScreenshots(hostDir: string): string[] {
  try {
    return readdirSync(join(hostDir, 'screenshots'))
      .filter((name) => SHOT_EXTENSIONS.test(name))
      .sort((left, right) => left.localeCompare(right, 'en'));
  } catch {
    return [];
  }
}

export interface RenderedArtifacts {
  ok: boolean;
  html: boolean;
  warnings: string[];
}

export async function renderReportArtifacts(
  hostDir: string,
): Promise<RenderedArtifacts> {
  const md = readText(join(hostDir, REPORT_MD_FILE));
  if (md === null) {
    return {
      ok: false,
      html: false,
      warnings: [`${REPORT_MD_FILE} отсутствует — страница не собрана`],
    };
  }
  const json = readReportJson(hostDir);
  const page = renderReportPage({
    md,
    doc: json.raw,
    screenshots: listScreenshots(hostDir),
  });
  const warnings = [...json.warnings, ...page.warnings];
  writeFileSync(join(hostDir, REPORT_HTML_FILE), page.html, 'utf8');
  return { ok: true, html: true, warnings };
}