import { embedReportScreenshots } from './embed-screenshots';
import { renderReportArtifacts } from './report-render';
import { recordReportWarnings } from './report-warnings';

export async function rebuildReportPage(
  issueId: string,
  hostDir: string,
): Promise<{ ok: boolean; warnings: string[]; embed: string }> {
  const rendered = await renderReportArtifacts(hostDir).catch(
    (error: unknown) => ({
      ok: false,
      html: false,
      warnings: [`report page failed: ${String(error)}`],
    }),
  );
  const embedded = rendered.html
    ? await embedReportScreenshots(hostDir).catch((error: unknown) => ({
        ok: false,
        summary: `embed failed: ${String(error)}`,
      }))
    : { ok: true, summary: 'skipped: no page' };
  const warnings = [
    ...rendered.warnings,
    ...(embedded.ok ? [] : [`скриншоты не вшиты: ${embedded.summary}`]),
  ];
  recordReportWarnings(issueId, warnings);
  return { ok: rendered.html, warnings, embed: embedded.summary };
}
