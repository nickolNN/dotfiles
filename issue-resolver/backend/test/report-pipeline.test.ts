import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { StepExecutionResult } from '@issue-resolver/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { createDb } from '../src/db/client';
import { issues, iterations, stepRuns } from '../src/db/schema';
import { FakePiRunner, type PiRunOptions } from '../src/pi/runner';
import { InMemoryStepSessionRegistry } from '../src/pi/session-registry';
import { InMemorySseHub } from '../src/sse/hub';
import {
  reportWarningsFor,
  runReportAgent,
} from '../src/workflow/run-iteration.service';

const NOW = '2026-06-01T00:00:00.000Z';

const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
  'base64',
);

const pass = (): StepExecutionResult => ({
  step: 'report',
  exitCode: 0,
  report: { status: 'pass', summary: 'report ok' },
  stdout: '',
  stderr: '',
});

class PipelinePi extends FakePiRunner {
  constructor(
    private readonly root: string,
    private readonly files: Record<string, string | Buffer>,
  ) {
    super();
  }

  override run(
    containerName: string,
    prompt: string,
    options?: PiRunOptions,
  ): Promise<StepExecutionResult> {
    const result = super.run(containerName, prompt, options);
    if (options?.stepRunId?.endsWith('.report') && options.issueId) {
      const dir = join(this.root, options.issueId);
      mkdirSync(dir, { recursive: true });
      for (const [name, content] of Object.entries(this.files)) {
        const target = join(dir, name);
        mkdirSync(join(target, '..'), { recursive: true });
        writeFileSync(target, content);
      }
    }
    return result;
  }
}

const cleanups: Array<() => void> = [];

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'ir-report-pipeline-'));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function seed(db: ReturnType<typeof createDb>): string {
  const issueId = randomUUID();
  db.insert(issues)
    .values({
      id: issueId,
      title: 'Pipeline corner cases',
      jira_issue_url: null,
      pipeline_steps: ['resolve'],
      container_name: null,
      status: 'running',
      created_at: NOW,
      updated_at: NOW,
    })
    .run();
  db.insert(iterations)
    .values({
      id: randomUUID(),
      issue_id: issueId,
      number: 1,
      context: '',
      review_context: '',
      is_review_need: false,
      steps: ['resolve'],
      model: null,
      step_models: {},
      thinking_level: null,
      step_thinking_levels: {},
      status: 'completed',
      created_at: NOW,
      updated_at: NOW,
      worker_count: 1,
    })
    .run();
  return issueId;
}

async function runReport(
  root: string,
  files: Record<string, string | Buffer>,
): Promise<{
  issueId: string;
  html: string;
  warnings: string[];
  feedback: string;
  status: string;
}> {
  const db = createDb(':memory:');
  const issueId = seed(db);
  const pi = new PipelinePi(root, files);
  pi.enqueue(pass());
  await runReportAgent(
    {
      pi,
      sse: new InMemorySseHub(),
      control: new InMemoryStepSessionRegistry(),
      workspaceRoot: root,
      db,
    },
    {
      issueId,
      containerName: 'c',
      hostDir: join(root, issueId),
      prompt: 'p',
    },
  );
  const htmlPath = join(root, issueId, 'report.html');
  const html = existsSync(htmlPath) ? readFileSync(htmlPath, 'utf8') : '';
  const run = db.select().from(stepRuns).all().at(-1);
  return {
    issueId,
    html,
    warnings: reportWarningsFor(issueId),
    feedback: run?.feedback ?? '',
    status: run?.status ?? '',
  };
}

describe('report pipeline — скриншоты после прогона', () => {
  it('картинка из markdown вшита в страницу, плейсхолдеров не осталось', async () => {
    const root = tempRoot();
    const { html } = await runReport(root, {
      'report.md': '# Отчёт\n\n![борд](screenshots/01-board.png)\n',
      'report.json': JSON.stringify({ verdict: 'pass', title: 'Отчёт' }),
      'screenshots/01-board.png': PNG_1PX,
    });

    expect(html).toContain('data:image/png;base64,');
    expect(html).not.toContain('data-slot=');
  });

  it('имя файла, упомянутое в тексте, тоже вшивается', async () => {
    const root = tempRoot();
    const { html } = await runReport(root, {
      'report.md': '# Отчёт\n\nБорд после фикса — `01-board.png`.\n',
      'screenshots/01-board.png': PNG_1PX,
    });

    expect(html).toContain('data:image/png;base64,');
    expect(html).not.toContain('data-slot=');
  });

  it('один скриншот, упомянутый дважды, вшивается дважды, но читается один раз', async () => {
    const root = tempRoot();
    const { html } = await runReport(root, {
      'report.md': [
        '# Отчёт',
        '',
        'Первый вид — `01-board.png`.',
        '',
        'Второй вид — тот же `01-board.png`.',
        '',
      ].join('\n'),
      'screenshots/01-board.png': PNG_1PX,
    });

    expect(html.match(/data:image\/png;base64,/g) ?? []).toHaveLength(2);
    expect(html).not.toContain('data-slot=');
  });

  it('пропавший файл скриншота: страница есть, прогон не падает, предупреждение записано', async () => {
    const root = tempRoot();
    const { html, warnings } = await runReport(root, {
      'report.md': '# Отчёт\n\n![нет файла](screenshots/ghost.png)\n',
    });

    expect(html).toContain('<html');
    expect(warnings.join(' | ')).toMatch(/скриншоты не вшиты/);
  });

  it('скриншот с пробелом и юникодом в имени вшивается', async () => {
    const root = tempRoot();
    const { html } = await runReport(root, {
      'report.md': '# Отчёт\n\n![вид](screenshots/борд 01.png)\n',
      'screenshots/борд 01.png': PNG_1PX,
    });

    expect(html).toContain('data:image/png;base64,');
    expect(html).not.toContain('data-slot=');
  });

  it('расширение в верхнем регистре не мешает вшиванию', async () => {
    const root = tempRoot();
    const { html } = await runReport(root, {
      'report.md': '# Отчёт\n\n![вид](screenshots/BOARD.PNG)\n',
      'screenshots/BOARD.PNG': PNG_1PX,
    });

    expect(html).toContain('data:image/png;base64,');
  });

  it('выход из папки скриншотов и внешние ссылки не вшиваются', async () => {
    const root = tempRoot();
    const { html } = await runReport(root, {
      'report.md': [
        '# Отчёт',
        '',
        '![секрет](../secret.png)',
        '',
        '![внешнее](https://example.com/x.png)',
        '',
      ].join('\n'),
      'secret.png': PNG_1PX,
    });

    expect(html).not.toContain('data:image');
    expect(html).not.toContain('src="https:');
  });

  it('отчёт без скриншотов: страница собирается без плейсхолдеров и без предупреждений', async () => {
    const root = tempRoot();
    const { html, warnings } = await runReport(root, {
      'report.md': '# Отчёт\n\nТолько текст.\n',
      'report.json': JSON.stringify({ verdict: 'pass' }),
    });

    expect(html).toContain('<html');
    expect(html).not.toContain('data-slot=');
    expect(warnings).toEqual([]);
  });
});

describe('report pipeline — page survival', () => {
  it('битый report.json не мешает странице и даёт предупреждение', async () => {
    const root = tempRoot();
    const { html, warnings } = await runReport(root, {
      'report.md': '# Отчёт\n\nТекст.\n',
      'report.json': '{"title": ',
    });

    expect(html).toContain('<html');
    expect(warnings.join(' | ')).toMatch(/report\.json/);
  });

  it('диаграмма, дублирующая ASCII, отброшена, страница и статус живы', async () => {
    const root = tempRoot();
    const ascii = [
      '```',
      '┌────────┐   press   ┌────────┐',
      '│ card   │──────────▶│ dialog │',
      '└────────┘           └────────┘',
      '```',
    ].join('\n');
    const { html, warnings } = await runReport(root, {
      'report.md': `# Отчёт\n\nСхема:\n\n${ascii}\n`,
      'report.json': JSON.stringify({
        diagrams: [
          {
            kind: 'flow',
            title: 'Card press opens dialog',
            nodes: ['card', 'dialog'],
            edges: [['card', 'dialog']],
          },
        ],
      }),
    });

    expect(html).not.toContain('class="diagram-figure"');
    expect(warnings.join(' | ')).toMatch(/пропущена/);
  });

  it('пустой report.md: страницы нет, статус failed, фидбек объясняет причину', async () => {
    const root = tempRoot();
    const { html, status, feedback } = await runReport(root, {
      'report.md': '',
    });

    expect(html).not.toContain('<html');
    expect(status).toBe('failed');
    expect(feedback).toMatch(/страница не собрана|report\.md/);
  });
});