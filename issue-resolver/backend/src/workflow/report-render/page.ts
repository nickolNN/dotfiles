
import { renderDiagram } from './diagrams';
import { renderMarkdown, type Heading } from './markdown';
import {
  diagramIsExecution,
  duplicatesAscii,
  executionMetrics,
  isExecutionHeading,
  splitDocument,
  type AsciiFigure,
  type MrLink,
} from './layout';
import { parseReportDoc, type ReportDoc } from './schema';

export interface RenderPageInput {
  md: string;
  doc: unknown;
  screenshots?: string[];
}

export interface RenderPageResult {
  html: string;
  warnings: string[];
}

const VERDICT_LABEL: Record<string, string> = {
  pass: '✅ Выполнено',
  fail: '❌ Не выполнено',
  blocked: '⛔ Заблокировано',
};

const SITE_CSS = `
:root{
  --bg:#0b0f10; --panel:#121a1c; --border:#1f2b2e; --text:#e6f1f2; --muted:#8fa6aa;
  --accent:#00c2a8; --pass:#37d67a; --fail:#ff5c5c; --blocked:#ffb020;
  --running:#4aa3ff; --na:#5b6b6e; --code:#0f1719;
}
@media (prefers-color-scheme: light){
  :root{
    --bg:#f7fafb; --panel:#ffffff; --border:#d8e2e5; --text:#12201f; --muted:#5b7075;
    --accent:#0a8f7d; --pass:#128a4a; --fail:#c62828; --blocked:#9a6200;
    --running:#1565c0; --na:#8a9a9d; --code:#eef4f5;
  }
}
body{margin:0;background:var(--bg);color:var(--text);font:15px/1.6 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
.wrap{max-width:960px;margin:0 auto;padding:32px 20px 64px}
.hero{border:1px solid var(--border);background:var(--panel);border-radius:14px;padding:22px 24px}
.hero-top{display:flex;gap:12px;align-items:center;justify-content:space-between;flex-wrap:wrap}
.verdict{font-weight:700;font-size:13px;letter-spacing:.02em;padding:4px 10px;border-radius:999px;border:1px solid currentColor}
.verdict-pass{color:var(--pass)} .verdict-fail{color:var(--fail)} .verdict-blocked{color:var(--blocked)}
.hero h1{margin:14px 0 4px;font-size:26px;line-height:1.25}
.hero .subtitle{margin:0;color:var(--muted)}
.hero time{color:var(--muted);font-size:12px}
.metrics{list-style:none;display:flex;flex-wrap:wrap;gap:10px;margin:18px 0 0;padding:0}
.metrics li{border:1px solid var(--border);border-radius:10px;padding:8px 12px;min-width:110px}
.m-label{display:block;font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted)}
.m-value{display:block;font-size:20px;font-weight:700}
.m-hint{display:block;font-size:11px;color:var(--muted)}
.toc{margin:22px 0 0;padding:14px 18px;border:1px dashed var(--border);border-radius:12px}
.toc p{margin:0 0 6px;font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted)}
.toc ul{list-style:none;display:flex;flex-wrap:wrap;gap:8px;margin:0;padding:0}
.toc a{color:var(--accent);text-decoration:none;font-size:13px;border-bottom:1px solid transparent}
.toc a:hover{border-color:currentColor}
.toc-l3{padding-left:14px;opacity:.85}
.mr-links{display:flex;flex-wrap:wrap;gap:8px;list-style:none;margin:14px 0 0;padding:0}
.mr-links a{display:inline-block;padding:6px 12px;border:1px solid var(--border);border-radius:999px;font-size:13px;text-decoration:none;color:var(--fg)}
.mr-links a:hover{border-color:var(--accent);color:var(--accent)}
main{margin-top:26px}
h2{margin:34px 0 10px;font-size:20px;border-bottom:1px solid var(--border);padding-bottom:6px}
h3{margin:24px 0 8px;font-size:16px;color:var(--accent)}
p{margin:10px 0}
a{color:var(--accent)}
code{background:var(--code);border:1px solid var(--border);border-radius:5px;padding:1px 5px;font-size:13px}
pre{background:var(--code);border:1px solid var(--border);border-radius:10px;padding:14px;overflow:auto}
pre code{border:0;padding:0;background:none}
blockquote{margin:12px 0;padding:8px 14px;border-left:3px solid var(--accent);background:var(--panel);color:var(--muted)}
hr{border:0;border-top:1px solid var(--border);margin:22px 0}
.table-wrap{overflow:auto;margin:14px 0}
table{border-collapse:collapse;width:100%;font-size:14px}
th,td{border:1px solid var(--border);padding:7px 10px;text-align:left;vertical-align:top}
th{background:var(--panel);font-size:12px;text-transform:uppercase;letter-spacing:.04em;color:var(--muted)}
.sev-pass{color:var(--pass);font-weight:600} .sev-ok{color:var(--pass);font-weight:600}
.sev-fail,.sev-error{color:var(--fail);font-weight:600}
.sev-blocked,.sev-major{color:var(--blocked);font-weight:600}
.sev-minor,.sev-trivial{color:var(--muted)} .sev-critical{color:var(--fail);font-weight:700}
.sev-running{color:var(--running)}
details.execution{margin-top:26px;border:1px solid var(--border);border-radius:12px;padding:10px 16px;background:var(--panel)}
details.execution>summary{cursor:pointer;font-weight:600;color:var(--muted);font-size:13px;text-transform:uppercase;letter-spacing:.06em}
figure.diagram-figure{margin:18px 0;border:1px solid var(--border);border-radius:12px;padding:14px;background:var(--panel)}
figcaption{font-size:12px;text-transform:uppercase;letter-spacing:.05em;color:var(--muted);margin-bottom:8px}
.diagram{width:100%;height:auto;display:block}
.diagram text{font-family:inherit}
.ongoing{opacity:.75;stroke:var(--running);stroke-dasharray:4 3}
.shots{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:12px;margin:16px 0}
.shots figure{margin:0;border:1px solid var(--border);border-radius:10px;overflow:hidden;background:var(--bg)}
.shots img{display:block;width:100%;height:auto}
.shots figcaption{padding:6px 8px;margin:0}
figure.shot{margin:20px 0;border:1px solid var(--border);border-radius:12px;overflow:hidden;background:var(--panel)}
figure.shot .shot-link{display:block;line-height:0}
figure.shot img.shot-image{display:block;width:100%;height:auto;background:var(--bg)}
figure.shot figcaption{padding:8px 12px;margin:0;border-top:1px solid var(--border)}
a.shot-link{border-bottom:0}
img.inline-shot{max-width:100%;height:auto;border:1px solid var(--border);border-radius:8px;vertical-align:middle}
.diagram .edge,.diagram .grid{color:var(--muted)}
.diagram text{font-variant-numeric:tabular-nums}
dialog#lightbox{border:0;padding:0;background:transparent;max-width:96vw;max-height:96vh}
dialog#lightbox img{display:block;max-width:96vw;max-height:92vh}
dialog#lightbox::backdrop{background:rgba(0,0,0,.86)}
.warn{border:1px solid var(--blocked);color:var(--blocked);border-radius:10px;padding:8px 12px;margin:12px 0;font-size:13px}
`.trim();

const LIGHTBOX_JS = `
(function(){
  var dialog = document.getElementById('lightbox');
  var img = dialog ? dialog.querySelector('img') : null;
  if (!dialog || !img) return;
  document.querySelectorAll('a.shot-link').forEach(function(link){
    link.addEventListener('click', function(event){
      event.preventDefault();
      var source = link.querySelector('img');
      if (!source) return;
      img.src = source.src;
      img.alt = source.alt;
      dialog.showModal();
    });
  });
  dialog.addEventListener('click', function(){ dialog.close(); });
})();
`.trim();

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderMrLinks(links: MrLink[]): string {
  if (links.length === 0) return '';
  const items = links
    .map(
      (link) =>
        `<li><a href="${escapeHtml(link.href)}" target="_blank" rel="noopener">${escapeHtml(link.text || link.href)}</a></li>`,
    )
    .join('');
  return `<ul class="mr-links">${items}</ul>`;
}

function metricItem(metric: NonNullable<ReportDoc['metrics']>[number]): string {
  return `<li><span class="m-label">${escapeHtml(metric.label)}</span><span class="m-value">${escapeHtml(String(metric.value))}</span>${metric.hint ? `<span class="m-hint">${escapeHtml(metric.hint)}</span>` : ''}</li>`;
}

function renderMetrics(doc: ReportDoc): string {
  const hero = executionMetrics(doc.metrics ?? []).hero;
  if (hero.length === 0) return '';
  return `<ul class="metrics">${hero.map(metricItem).join('')}</ul>`;
}

function renderExecutionMetrics(doc: ReportDoc): string {
  const rest = executionMetrics(doc.metrics ?? []).details;
  if (rest.length === 0) return '';
  const items = rest
    .map(
      (metric) =>
        `<li><b>${escapeHtml(metric.label)}:</b> ${escapeHtml(String(metric.value))}${metric.hint ? ` — ${escapeHtml(metric.hint)}` : ''}</li>`,
    )
    .join('');
  return `<ul class="exec-metrics">${items}</ul>`;
}

function renderDiagrams(
  doc: ReportDoc,
  warnings: string[],
  ascii: AsciiFigure[] = [],
): { answer: string; execution: string } {
  const split = { answer: '', execution: '' };
  if (!doc.diagrams || doc.diagrams.length === 0) return split;
  for (const diagram of doc.diagrams) {
    const { svg, warnings: diagramWarnings } = renderDiagram(diagram, doc.verdict);
    warnings.push(...diagramWarnings);
    if (svg === '') continue;
    const title = 'title' in diagram && diagram.title ? diagram.title : '';
    if (duplicatesAscii(title, ascii)) {
      warnings.push(
        `report.json: диаграмма "${title}" пропущена — та же схема уже нарисована ASCII в report.md`,
      );
      continue;
    }
    const figure = `<figure class="diagram-figure">${title ? `<figcaption>${escapeHtml(title)}</figcaption>` : ''}${svg}</figure>`;
    split[diagramIsExecution(diagram) ? 'execution' : 'answer'] += figure;
  }
  return split;
}

function renderToc(headings: Heading[]): string {
  const top = headings.filter(
    (heading) =>
      heading.level >= 2 && heading.level <= 3 && !isExecutionHeading(heading),
  );
  if (top.length === 0) return '';
  const links = top
    .map(
      (heading) =>
        `<li class="toc-l${heading.level}"><a href="#${heading.id}">${escapeHtml(heading.text)}</a></li>`,
    )
    .join('');
  return `<nav class="toc"><p>Содержание</p><ul>${links}</ul></nav>`;
}

function wrapExecution(body: string, metrics: string): string {
  if (body === '' && metrics === '') return '';
  return `<details class="execution"><summary>Детали выполнения</summary>${metrics}${body}</details>`;
}

function renderShots(screenshots: string[], quoted: string[]): string {
  const leftover = screenshots.filter((name) => !quoted.includes(name));
  if (leftover.length === 0) return '';
  const figures = leftover
    .map(
      (name) =>
        `<figure><a href="#" class="shot-link"><img data-slot="${escapeHtml(name)}" alt="${escapeHtml(name)}"></a><figcaption>${escapeHtml(name)}</figcaption></figure>`,
    )
    .join('');
  return `<h3>Остальные скриншоты</h3><div class="shots">${figures}</div>`;
}

export function renderReportPage(input: RenderPageInput): RenderPageResult {
  const warnings: string[] = [];
  const parsed = parseReportDoc(input.doc ?? null);
  warnings.push(...parsed.warnings);
  const doc = parsed.doc ?? {};

  const md = input.md ?? '';
  if (md.trim() === '') {
    warnings.push('report.md пуст — страница собрана без тела отчёта');
  }
  const rendered = renderMarkdown(md, input.screenshots ?? []);

  let firstHeading = '';
  for (const heading of rendered.headings) {
    if (heading.level === 1) {
      firstHeading = heading.text;
      break;
    }
  }
  const title = doc.title ?? firstHeading ?? 'Отчёт';
  const verdict = doc.verdict;
  const verdictBadge = verdict
    ? `<span class="verdict">${VERDICT_LABEL[verdict] ?? verdict}</span>`
    : '';
  const heroClass = verdict ? `hero verdict-${verdict}` : 'hero';

  const figures = renderDiagrams(doc, warnings, rendered.ascii);
  const parts = splitDocument(rendered.html);
  const body =
    parts.answer +
    figures.answer +
    wrapExecution(
      parts.execution + figures.execution,
      parts.metrology + renderExecutionMetrics(doc),
    ) +
    renderShots(input.screenshots ?? [], rendered.screenshots);
  const warningBlock =
    warnings.length > 0
      ? `<div class="warn">${warnings.map((warning) => escapeHtml(warning)).join('<br>')}</div>`
      : '';

  const html = `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>${SITE_CSS}</style>
</head>
<body>
<div class="wrap">
<header class="${heroClass}">
<div class="hero-top">${verdictBadge}${doc.generatedAt ? `<time datetime="${escapeHtml(doc.generatedAt)}">${escapeHtml(doc.generatedAt)}</time>` : ''}</div>
<h1>${escapeHtml(title)}</h1>
${doc.subtitle ? `<p class="subtitle">${escapeHtml(doc.subtitle)}</p>` : ''}
${renderMetrics(doc)}
${renderMrLinks(parts.mrLinks)}
</header>
${warningBlock}
${renderToc(rendered.headings)}
<main>
${body}
</main>
</div>
<dialog id="lightbox"><img alt=""></dialog>
<script>${LIGHTBOX_JS}</script>
</body>
</html>`;

  return { html, warnings };
}