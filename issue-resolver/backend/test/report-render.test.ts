import {
  duplicatesAscii,
  executionMetrics,
  splitDocument,
} from '../src/workflow/report-render/layout';
import { describe, expect, it } from 'vitest';
import {
  parseReportDoc,
  renderMarkdown,
  renderReportPage,
  renderDiagram,
  type ReportDoc,
} from '../src/workflow/report-render';

function externalRefs(html: string): string[] {
  const patterns = [
    /<link\b[^>]*href=/i,
    /@import/i,
    /<script\b[^>]*\bsrc=/i,
    /<iframe\b/i,
    /\bsrc\s*=\s*["']https?:/i,
    /\bsrc\s*=\s*["']\/\//i,
    /url\(\s*["']?https?:/i,
    /fetch\s*\(/i,
    /XMLHttpRequest/,
  ];
  return patterns.filter((pattern) => pattern.test(html)).map(String);
}

const FULL_MD = `# Kanban improvements

## Answer

Готово: доска переехала на новый layout, **тесты зелёные**.

- пункт один
- пункт два

| Что | Статус |
| --- | --- |
| доска | pass |
| фильтры | fail |

\`\`\`ts
const a = "<script>alert(1)</script>";
\`\`\`

### Verification

\`pnpm test\` → 46/46

## Execution details

### Iteration timeline

Три итерации.

### Full findings

Ничего критичного.
`;

const FULL_DOC: ReportDoc = {
  verdict: 'pass',
  title: 'Kanban improvements',
  subtitle: 'Выполнено за 3 итерации',
  generatedAt: '2026-10-28T17:00:00Z',
  metrics: [
    { label: 'Итерации', value: 3 },
    { label: 'Тесты', value: '46/46', hint: 'pnpm test' },
  ],
  diagrams: [
    {
      kind: 'flow',
      title: 'Как проходит логин',
      nodes: ['LoginView', 'mocks.ts', 'localStorage'],
      edges: [
        ['LoginView', 'mocks.ts'],
        ['mocks.ts', 'localStorage'],
      ],
    },
    {
      kind: 'flow',
      title: 'Где живёт токен',
      nodes: [{ label: 'LoginView', status: 'pass' }, 'localStorage'],
      edges: [{ from: 'LoginView', to: 'localStorage', label: 'setItem' }],
      note: 'сервер не участвует',
    },
    {
      kind: 'bars',
      title: 'Шаги',
      items: [
        { label: 'resolve', value: 3, status: 'pass' },
        { label: 'review', value: 1 },
      ],
    },
    {
      kind: 'matrix',
      title: 'Шаг × итерация',
      columns: ['#1', '#2', '#3'],
      rows: [
        { label: 'resolve', cells: ['pass', 'fail', 'pass'] },
        { label: 'test', cells: ['pass', 'pass', 'pass'] },
      ],
    },
  ],
};

describe('renderMarkdown — безопасный подмножество md', () => {
  it('заголовки получают стабильные якоря', () => {
    const { html, headings } = renderMarkdown(FULL_MD);
    expect(html).toContain('<h2 id="answer">');
    expect(headings.map((heading) => heading.id)).toContain('execution-details');
  });

  it('сырой HTML в тексте экранируется, а не исполняется', () => {
    const { html } = renderMarkdown('## Тест\n\n<script>alert(1)</script>\n');
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('код-фенс сохраняет текст и не превращается в разметку', () => {
    const { html } = renderMarkdown(FULL_MD);
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('таблица рендерится с выравниванием и классами severity', () => {
    const { html } = renderMarkdown(FULL_MD);
    expect(html).toContain('<table');
    expect(html).toMatch(/class="sev-pass"/);
    expect(html).toMatch(/class="sev-fail"/);
  });

  it('CRLF и пустой ввод не ломают рендер', () => {
    expect(renderMarkdown('# A\r\n\r\nтекст\r\n').html).toContain('<h1');
    expect(renderMarkdown('').html.trim()).toBe('');
  });

  it('вложенные списки и inline-разметка', () => {
    const { html } = renderMarkdown(
      '- один\n  - вложенный\n- **жирный** и `код`\n',
    );
    expect(html).toContain('<ul');
    expect(html).toContain('<strong>жирный</strong>');
    expect(html).toContain('<code>код</code>');
  });
});

describe('parseReportDoc — схема report.json', () => {
  it('валидный документ проходит', () => {
    const { doc, warnings } = parseReportDoc(FULL_DOC);
    expect(warnings).toEqual([]);
    expect(doc?.verdict).toBe('pass');
    expect(doc?.diagrams).toHaveLength(4);
  });

  it('неизвестный вид схемы отбрасывается с предупреждением, остальное живо', () => {
    const { doc, warnings } = parseReportDoc({
      verdict: 'pass',
      diagrams: [
        { kind: 'hologram', title: 'x' },
        { kind: 'bars', title: 'ok', items: [{ label: 'a', value: 1 }] },
      ],
    });
    expect(warnings.join(' ')).toContain('hologram');
    expect(doc?.diagrams).toHaveLength(1);
  });

  it('мусор вместо документа → doc null, рендер не падает', () => {
    expect(parseReportDoc({ verdict: 42, diagrams: 'нет' }).doc).toBeNull();
    expect(parseReportDoc(null).doc).toBeNull();
    expect(parseReportDoc('<xml/>').warnings.length).toBeGreaterThan(0);
  });

  it('рёбра в неизвестные узлы отбрасываются', () => {
    const { doc, warnings } = parseReportDoc({
      diagrams: [
        {
          kind: 'flow',
          title: 'x',
          nodes: ['a'],
          edges: [['a', 'b']],
        },
      ],
    });
    expect(warnings.join(' ')).toContain('b');
    const flow = doc?.diagrams?.[0] as { edges: unknown[] };
    expect(flow.edges).toHaveLength(0);
  });
});

describe('renderDiagram — графика из чисел', () => {
  it('flow рисует узлы, связи и маркер стрелки', () => {
    const svg = renderDiagram(FULL_DOC.diagrams![0], 'pass').svg;
    expect(svg).toContain('<svg');
    expect(svg).toContain('LoginView');
    expect(svg).toContain('marker');
    expect(svg).toContain('<path');
  });

  it('flow подписывает связь и красит узел по статусу', () => {
    const svg = renderDiagram(FULL_DOC.diagrams![1], 'pass').svg;
    expect(svg).toContain('setItem');
    expect(svg).toContain('var(--pass)');
    expect(svg).toContain('сервер не участвует');
  });

  it('bars нормирует значения по максимуму', () => {
    const svg = renderDiagram(FULL_DOC.diagrams![2], 'pass').svg;
    expect(svg).toContain('resolve');
    expect(svg).toMatch(/width="[\d.]+"/);
  });

  it('matrix рисует сетку с классами статусов', () => {
    const svg = renderDiagram(FULL_DOC.diagrams![3], 'pass').svg;
    expect(svg).toContain('#2');
    expect(svg).toContain('cell-fail');
  });

  it('svg-люк пропускает рисунок, но без скриптов и обработчиков', () => {
    const { svg, warnings } = renderDiagram(
      {
        kind: 'svg',
        title: 'руками',
        body: '<svg viewBox="0 0 10 10"><script>bad()</script><rect onload="bad()" width="5" height="5" fill="red"/><a href="javascript:bad()">x</a><foreignObject/></svg>',
      },
      'pass',
    );
    expect(svg).toContain('<rect');
    expect(svg).not.toContain('<script');
    expect(svg).not.toContain('onload');
    expect(svg).not.toContain('javascript:');
    expect(svg).not.toContain('foreignObject');
    expect(warnings.length).toBeGreaterThan(0);
  });
});

describe('renderReportPage — самодостаточная страница', () => {
  const page = () =>
    renderReportPage({
      md: FULL_MD,
      doc: FULL_DOC,
      screenshots: ['01-board.png', '02-dialog.png'],
    });

  it('нет ни одной внешней ссылки', () => {
    expect(externalRefs(page().html)).toEqual([]);
  });

  it('тёмная и светлая темы объявлены в inline-CSS', () => {
    const { html } = page();
    expect(html).toContain('prefers-color-scheme');
    expect(html).toMatch(/<style>/);
  });

  it('TOC ведёт только по открытым разделам ответа', () => {
    const { html } = page();
    expect(html).toContain('href="#answer"');
    expect(html).not.toContain('href="#execution-details"');
  });

  it('заголовок из md не дублирует шапку страницы', () => {
    const { html } = page();
    const heroTitle = html.indexOf('<h1>Kanban improvements</h1>');
    const bodyTitle = html.indexOf('id="task-kanban-improvements"');
    expect(heroTitle).toBeGreaterThan(-1);
    expect(bodyTitle).toBe(-1);
  });

  it('метрология выполнения уезжает в свёрнутый блок', () => {
    const page = renderReportPage({
      md: '# Отчёт\n\n**Status:** pass | **Iterations:** 1–2 | **Generated:** 2026-10-28\n\n## Answer\n\nОтвет.\n',
      doc: {},
      screenshots: [],
    });
    const detailsAt = page.html.indexOf('<details class="execution">');
    expect(page.html.indexOf('Generated:')).toBeGreaterThan(detailsAt);
  });

  it('Execution details свёрнут, Answer открыт и идёт первым', () => {
    const { html } = page();
    const answer = html.indexOf('id="answer"');
    const execution = html.indexOf('<details class="execution">');
    expect(answer).toBeGreaterThan(-1);
    expect(execution).toBeGreaterThan(answer);
    expect(html).toMatch(/<details[^>]*class="execution"/);
    expect(html).not.toContain('id="execution-details"');
  });

  it('вердикт и метрики вынесены в шапку', () => {
    const { html } = page();
    expect(html).toMatch(/verdict-pass/);
    expect(html).toContain('Итерации');
    expect(html).toContain('46/46');
  });

  it('скриншоты вставляются плейсхолдерами data-slot (base64 не печатает модель)', () => {
    const { html } = page();
    expect(html).toContain('data-slot="01-board.png"');
    expect(html).not.toContain('base64,');
    expect(html).toContain('<dialog');
  });

  it('без report.json страница всё равно собирается по md', () => {
    const only = renderReportPage({ md: FULL_MD, doc: null });
    expect(only.html).toContain('id="answer"');
    expect(only.html).toContain('<details');
    expect(externalRefs(only.html)).toEqual([]);
  });

  it('без md, но с json — страница с вердиктом, без падения', () => {
    const only = renderReportPage({ md: '', doc: FULL_DOC });
    expect(only.html).toContain('verdict-pass');
    expect(only.warnings.join(' ')).toContain('report.md');
  });

  it('заголовок страницы не берётся из неэкранированного md', () => {
    const { html } = renderReportPage({
      md: '# <img src=x onerror=alert(1)>',
      doc: null,
    });
    expect(html).not.toContain('onerror=alert(1)>');
    expect(html).toContain('&lt;img');
  });

  it('неизвестные схемы не ломают страницу и дают предупреждение', () => {
    const { html, warnings } = renderReportPage({
      md: FULL_MD,
      doc: { verdict: 'pass', diagrams: [{ kind: 'nope' }] },
    });
    expect(html).toContain('id="answer"');
    expect(warnings.join(' ')).toContain('nope');
  });
});


describe('renderMarkdown — скриншот на своём месте', () => {
  it('рисунок из markdown становится фигурой в тексте, а не в галерее', () => {
    const rendered = renderMarkdown(
      '# Канбан\n\nДоска после правок:\n\n![Доска](screenshots/01-board.png)\n\n## Детали\n\nТекст деталей.',
    );
    expect(rendered.html).toContain('class="shot"');
    expect(rendered.html).toContain('data-slot="01-board.png"');
    expect(rendered.html).toContain('<figcaption>Доска</figcaption>');
    const figure = rendered.html.indexOf('class="shot"');
    const details = rendered.html.indexOf('Детали');
    expect(figure).toBeGreaterThan(0);
    expect(figure).toBeLessThan(details);
    expect(rendered.screenshots).toEqual(['01-board.png']);
  });

  it('внешний или выходящий из папки путь не вшивается', () => {
    const rendered = renderMarkdown(
      '![x](https://evil.example/a.png)\n\n![y](../secret.png)\n\n![z](screenshots/ok.png)',
    );
    expect(rendered.html).not.toContain('evil.example');
    expect(rendered.html).not.toContain('secret.png');
    expect(rendered.html).toContain('data-slot="ok.png"');
    expect(rendered.screenshots).toEqual(['ok.png']);
  });

  it('скриншот, названный дважды, попадает в текст дважды, но в списке один раз', () => {
    const rendered = renderMarkdown(
      '![A](screenshots/a.png)\n\n![A снова](screenshots/a.png)',
    );
    expect(rendered.html.match(/data-slot="a\.png"/g)?.length).toBe(2);
    expect(rendered.screenshots).toEqual(['a.png']);
  });
});

describe('renderReportPage — галерея только для непроцитированных', () => {
  it('использованный скриншот не дублируется в конце страницы', () => {
    const page = renderReportPage({
      md: '# Отчёт\n\n![Доска](screenshots/01-board.png)\n',
      doc: {},
      screenshots: ['01-board.png', '02-dialog.png'],
    });
    const gallery = page.html.slice(page.html.indexOf('<div class="shots">'));
    expect(page.html).toContain('<h3>Остальные скриншоты</h3>');
    expect(gallery).toContain('data-slot="02-dialog.png"');
    expect(gallery).not.toContain('data-slot="01-board.png"');
  });

  it('когда процитировано всё — галереи нет', () => {
    const page = renderReportPage({
      md: '![Доска](screenshots/01-board.png)',
      doc: {},
      screenshots: ['01-board.png'],
    });
    expect(page.html).not.toContain('Остальные скриншоты');
  });
});

describe('renderDiagram — читаемая графика', () => {
  it('flow переносит длинную подпись и ведёт связь ортогонально', () => {
    const svg = renderDiagram(
      {
        kind: 'flow',
        title: 'Поток',
        nodes: ['Очень длинное название первого узла схемы', 'B'],
        edges: [['Очень длинное название первого узла схемы', 'B']],
      },
      'pass',
    ).svg;
    expect(svg.match(/<tspan/g)?.length).toBeGreaterThan(1);
    expect(svg).toContain('<path');
    expect(svg).not.toContain('<line');
    expect(svg).toContain('text-anchor="middle"');
  });

  it('bars получает опорную линию и подписи значений', () => {
    const svg = renderDiagram(
      {
        kind: 'bars',
        title: 'Длительность',
        unit: 'с',
        items: [
          { label: 'resolve', value: 80 },
          { label: 'test', value: 20, status: 'fail' },
        ],
      },
      'pass',
    ).svg;
    expect(svg).toContain('class="axis"');
    expect(svg).toContain('80с');
    expect(svg).toContain('var(--fail)');
  });

  it('узел flow может нести статус', () => {
    const svg = renderDiagram(
      {
        kind: 'flow',
        title: 'Поток',
        nodes: [{ label: 'resolve', status: 'pass' }, 'test'],
      },
      'pass',
    ).svg;
    expect(svg).toContain('var(--pass)');
  });
});

describe('renderReportPage — вся графика объясняет ответ', () => {
  const md = `# Отчёт

## Answer

Ответ на вопрос.

## Execution details

### Iteration timeline

text`;

  const render = (diagrams: unknown[]) =>
    renderReportPage({ md, doc: { verdict: 'pass', diagrams }, screenshots: [] }).html;

  it('схема стоит после текста ответа и до раздела выполнения', () => {
    const html = render([{ kind: 'flow', title: 'Поток данных', nodes: ['A', 'B'] }]);
    const answerText = html.indexOf('Ответ на вопрос');
    const flowAt = html.indexOf('Поток данных');
    const detailsAt = html.indexOf('<details class="execution">');
    expect(flowAt).toBeGreaterThan(answerText);
    expect(flowAt).toBeLessThan(detailsAt);
  });

  it('в свёрнутом блоке выполнения графики нет', () => {
    const html = render([
      { kind: 'flow', title: 'Поток данных', nodes: ['A'] },
      { kind: 'bars', title: 'Размер бандла', items: [{ label: 'app', value: 120 }] },
    ]);
    const detailsAt = html.indexOf('<details class="execution">');
    expect(detailsAt).toBeGreaterThan(-1);
    expect(html.indexOf('Поток данных')).toBeLessThan(detailsAt);
    expect(html.indexOf('Размер бандла')).toBeLessThan(detailsAt);
  });

  it('процессные виды диаграмм отвергнуты схемой', () => {
    const page = renderReportPage({
      md: md,
      doc: {
        diagrams: [
          { kind: 'timeline', title: 'Итерации', points: [{ label: 'x', start: 0 }] },
          { kind: 'flow', title: 'Поток данных', nodes: ['A'] },
        ],
      },
      screenshots: [],
    });
    expect(page.html).not.toContain('Итерации');
    expect(page.html).toContain('Поток данных');
    expect(page.warnings.join(' ')).toMatch(/timeline/);
  });
});

describe('renderDiagram — читаемая графика', () => {
  it('flow переносит длинную подпись и ведёт связь ортогонально', () => {
    const svg = renderDiagram(
      {
        kind: 'flow',
        title: 'Поток',
        nodes: ['Очень длинное название первого узла схемы', 'B'],
        edges: [['Очень длинное название первого узла схемы', 'B']],
      },
      'pass',
    ).svg;
    expect(svg.match(/<tspan/g)?.length).toBeGreaterThan(1);
    expect(svg).toContain('<path');
    expect(svg).not.toContain('<line');
    expect(svg).toContain('text-anchor="middle"');
  });

  it('bars получает опорную линию и подписи значений', () => {
    const svg = renderDiagram(
      {
        kind: 'bars',
        title: 'Длительность',
        unit: 'с',
        items: [
          { label: 'resolve', value: 80 },
          { label: 'test', value: 20, status: 'fail' },
        ],
      },
      'pass',
    ).svg;
    expect(svg).toContain('class="axis"');
    expect(svg).toContain('80с');
    expect(svg).toContain('var(--fail)');
  });

  it('узел flow может нести статус', () => {
    const svg = renderDiagram(
      {
        kind: 'flow',
        title: 'Поток',
        nodes: [{ label: 'resolve', status: 'pass' }, 'test'],
      },
      'pass',
    ).svg;
    expect(svg).toContain('var(--pass)');
  });
});

describe('renderReportPage — всё про выполнение в свёрнутом блоке', () => {
  it('секция с процессом уезжает в <details>, даже если названа иначе', () => {
    const page = renderReportPage({
      md: '# Отчёт\n\n## Answer\n\nОтвет.\n\n## Iteration log\n\niter 1: pass\n',
      doc: {},
      screenshots: [],
    });
    const detailsAt = page.html.indexOf('<details class="execution">');
    const logAt = page.html.indexOf('iter 1: pass');
    expect(detailsAt).toBeGreaterThan(-1);
    expect(logAt).toBeGreaterThan(detailsAt);
    expect(page.html).not.toContain('Iteration log</h2>');
  });

  it('метрика про итерации не висит на первом экране', () => {
    const page = renderReportPage({
      md: '# Отчёт\n\n## Answer\n\nОтвет.\n',
      doc: {
        metrics: [
          { label: 'Итерации', value: 3 },
          { label: 'E2E тесты', value: '45/45' },
        ],
      },
      screenshots: [],
    });
    const detailsAt = page.html.indexOf('<details class="execution">');
    expect(page.html.indexOf('45/45')).toBeLessThan(detailsAt);
    expect(page.html.indexOf('Итерации')).toBeGreaterThan(detailsAt);
  });
});

describe('renderReportPage — ссылки на MR и процессные диаграммы', () => {
  it('ссылка на merge request стоит в шапке, но остаётся и в деталях', () => {
    const page = renderReportPage({
      md: '# Отчёт\n\n## Answer\n\nСделано.\n\n## Execution details\n\n### Merge requests\n\n- [aqua-com !13](https://git.example.com/aqua-com/pull/13)\n',
      doc: {},
      screenshots: [],
    });
    const hero = page.html.slice(0, page.html.indexOf('<main>'));
    expect(hero).toContain('href="https://git.example.com/aqua-com/pull/13"');
    expect(hero).toContain('class="mr-links"');
    expect(page.html.slice(page.html.indexOf('<details class="execution">'))).toContain(
      'https://git.example.com/aqua-com/pull/13',
    );
  });

  it('процессная диаграмма определяется и по подписям, не только по заголовку', () => {
    const page = renderReportPage({
      md: '# Отчёт\n\n## Answer\n\nОтвет.\n',
      doc: {
        diagrams: [
          {
            kind: 'matrix',
            title: 'Что было',
            columns: ['итерация 1', 'итерация 2'],
            rows: [{ label: 'resolve', cells: ['pass', 'fail'] }],
          },
        ],
      },
      screenshots: [],
    });
    const detailsAt = page.html.indexOf('<details class="execution">');
    expect(page.html.indexOf('Что было')).toBeGreaterThan(detailsAt);
  });

  it('диаграмма про шаги и итерации уходит под спойлер', () => {
    const page = renderReportPage({
      md: '# Отчёт\n\n## Answer\n\nОтвет.\n',
      doc: {
        diagrams: [
          { kind: 'flow', title: 'Как устроен логин', nodes: ['A', 'B'] },
          { kind: 'matrix', title: 'Шаг × итерация', columns: ['1'], rows: [{ label: 'resolve', cells: ['pass'] }] },
        ],
      },
      screenshots: [],
    });
    const detailsAt = page.html.indexOf('<details class="execution">');
    expect(page.html.indexOf('Как устроен логин')).toBeLessThan(detailsAt);
    expect(page.html.indexOf('Шаг × итерация')).toBeGreaterThan(detailsAt);
  });
});

describe('renderReportPage — диаграмма не дублирует ASCII', () => {
  const ascii = [
    '# Отчёт',
    '',
    '```text',
    'Pointer press on a card',
    '┌──────────────┐',
    '│ pointer down │',
    '└──────┬───────┘',
    '       ▼',
    '   drag start  ',
    '```',
    '',
    '## Answer',
    '',
    'Механика сохранена.',
    '',
  ].join('\n');

  it('схема, уже нарисованная ASCII, не рендерится второй раз', () => {
    const page = renderReportPage({
      md: ascii,
      doc: {
        diagrams: [
          { kind: 'flow', title: 'Pointer-press flow on a card', nodes: ['pointer down', 'drag start'] },
        ],
      },
      screenshots: [],
    });
    expect(page.html).not.toContain('<figure class="diagram-figure">');
    expect(page.warnings.join(' ')).toMatch(/уже нарисована ASCII/);
  });

  it('схема про другое остаётся', () => {
    const page = renderReportPage({
      md: ascii,
      doc: {
        diagrams: [{ kind: 'flow', title: 'Слои приложения', nodes: ['UI', 'API'] }],
      },
      screenshots: [],
    });
    expect(page.html).toContain('<figure class="diagram-figure">');
    expect(page.html).toContain('Слои приложения');
  });
});

describe('layout splitDocument — один проход по блокам', () => {
  const html = [
    '<h1 id="отчёт">Отчёт</h1>',
    '<p><strong>Status:</strong> pass | <strong>Generated:</strong> 2026-10-28</p>',
    '<h2 id="answer">Answer</h2>',
    '<p>Ответ.</p>',
    '<p>См. <a href="https://git.example.com/x/y/pull/13">MR 13</a>.</p>',
    '<h2 id="execution-details">Execution details</h2>',
    '<h3>Change set</h3>',
    '<p>3 files.</p>',
    '<p><a href="https://git.example.com/x/y/pull/13">MR 13</a></p>',
  ].join('\n');

  it('заголовок снят, метрики выполнения подняты, секции разделены', () => {
    const parts = splitDocument(html);
    expect(parts.answer).not.toContain('<h1');
    expect(parts.answer).toContain('Ответ.');
    expect(parts.answer).not.toContain('Status:');
    expect(parts.metrology).toContain('Generated:');
    expect(parts.execution).toContain('3 files.');
    expect(parts.execution).not.toContain('id="execution-details"');
  });

  it('ссылка на MR собирается один раз, в порядке документа', () => {
    const parts = splitDocument(html);
    expect(parts.mrLinks).toEqual([
      { href: 'https://git.example.com/x/y/pull/13', text: 'MR 13' },
    ]);
  });

  it('executionMetrics делит метрики по смыслу подписи', () => {
    const split = executionMetrics([
      { label: 'Итерации', value: 3 },
      { label: 'E2E тесты', value: '45/45' },
    ]);
    expect(split.hero.map((metric) => metric.label)).toEqual(['E2E тесты']);
    expect(split.details.map((metric) => metric.label)).toEqual(['Итерации']);
    expect(duplicatesAscii('Pointer-press flow on a card', [{ text: 'pointer press on a card' }])).toBe(true);
    expect(duplicatesAscii('Слои приложения', [{ text: 'pointer press on a card' }])).toBe(false);
  });
});
