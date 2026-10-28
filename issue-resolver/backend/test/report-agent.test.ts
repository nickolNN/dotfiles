/**
 * F22–F25: интеграционные и контрактные тесты report-агента.
 *
 * Реальный report-агент — это pi/LLM: он читает narratives итераций и пишет
 * `report.md` (для агентов) и `report.html` (для людей). В тестах мы подменяем
 * его детерминированной заглушкой-раннером, которая пишет оба файла, и
 * проверяем то, что контролирует бэкенд:
 *   - спавн происходит, файлы попадают в рабочую папку и в снапшот итерации;
 *   - промпт несёт fallback на engine-сводки `report-<n>.md` при пустых
 *     narratives и перечисляет доступные шаговые narrative-файлы;
 *   - промпт перечисляет ВСЕ итерации;
 *   - контракт self-contained `report.html` (никаких внешних ресурсов).
 */
import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  Iteration,
  PipelineStep,
  SSEEvent,
  StepExecutionResult,
} from '@issue-resolver/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Db } from '../src/db/client';
import { createDb } from '../src/db/client';
import { eq } from 'drizzle-orm';
import { issues, iterations } from '../src/db/schema';
import { FakeContainerController } from '../src/docker/controller';
import { FakeGitService } from '../src/git/service';
import {
  FakePiRunner,
  type PiRunOptions,
} from '../src/pi/runner';
import { InMemoryStepSessionRegistry } from '../src/pi/session-registry';
import { FakeMrClient } from '../src/pr/mr';
import { InMemorySseHub } from '../src/sse/hub';
import {
  archiveReportArtifacts,
  isReportRunActive,
  observedModelFor,
  reportModelFor,
  reportWarningsFor,
  runIssueIteration,
  runReportAgent,
  type IterationRunDeps,
  type ReportRunDeps,
} from '../src/workflow/run-iteration.service';
import { buildStepPrompt } from '../src/workflow/prompts';

const NOW = '2026-06-01T00:00:00.000Z';

const pass = (step: PipelineStep): StepExecutionResult => ({
  step,
  exitCode: 0,
  report: { status: 'pass', summary: `${step} ok` },
  stdout: `${step} out`,
  stderr: '',
});

/** Пример «правильного» self-contained report.html: инлайн CSS + data-URI. */
const SELF_CONTAINED_HTML = [
  '<!doctype html>',
  '<html lang="ru"><head><meta charset="utf-8">',
  '<style>body{background:#0d1117;color:#e6edf3;font-family:system-ui,sans-serif}</style>',
  '</head><body>',
  '<h1>Отчёт</h1>',
  '<img alt="screenshot" src="data:image/png;base64,iVBORw0KGgo=">',
  '</body></html>',
].join('\n');

/**
 * Раннер-заглушка report-агента: на вызов с `stepRunId='<issueId>/report'`
 * записывает заданные файлы в рабочую папку задачи (эмулируя pi-агента).
 */
class ReportStubPi extends FakePiRunner {
  constructor(
    private readonly root: string,
    private readonly files: Record<string, string>,
  ) {
    super();
  }

  override run(
    containerName: string,
    prompt: string,
    options?: PiRunOptions,
  ): Promise<StepExecutionResult> {
    const result = super.run(containerName, prompt, options);
    if (options?.stepRunId?.endsWith('/report') && options.issueId) {
      const dir = join(this.root, options.issueId);
      mkdirSync(dir, { recursive: true });
      for (const [name, content] of Object.entries(this.files)) {
        writeFileSync(join(dir, name), content, 'utf8');
      }
    }
    return result;
  }
}

/** Раннер, который отдаёт `stats.model` (наблюдённая модель сессии). */
class ObservedModelReportPi extends ReportStubPi {
  constructor(
    root: string,
    private readonly observed: string,
  ) {
    super(root, { 'report.md': `# Отчёт\nПровайдер: ${observed}\n` });
  }

  override async run(
    containerName: string,
    prompt: string,
    options?: PiRunOptions,
  ): Promise<StepExecutionResult> {
    const result = await super.run(containerName, prompt, options);
    if (options?.stepRunId?.endsWith('/report')) {
      result.stats = {
        model: this.observed,
        userMessages: 0,
        assistantMessages: 0,
        toolCalls: 0,
        toolResults: 0,
        totalMessages: 0,
        tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        cost: null,
        contextUsage: null,
      };
    }
    return result;
  }
}

/** Ищет внешние ссылки (шрифты/скрипты/CDN) в HTML. */
function externalReferences(html: string): string[] {
  const found: string[] = [];
  const patterns: RegExp[] = [
    /(?:src|href)\s*=\s*["']https?:\/\/[^"']+/gi,
    /@import\s+url\(\s*["']?https?:\/\//gi,
    /url\(\s*["']?https?:\/\//gi,
  ];
  for (const pattern of patterns) {
    for (const match of html.matchAll(pattern)) {
      found.push(match[0]);
    }
  }
  return found;
}

const cleanups: Array<() => void> = [];

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'ir-report-agent-'));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function makeDeps(pi: FakePiRunner): IterationRunDeps {
  return {
    container: new FakeContainerController(),
    git: new FakeGitService(),
    mr: new FakeMrClient(),
    pi,
    sse: new InMemorySseHub(),
    control: new InMemoryStepSessionRegistry(),
  };
}

function seedIteration(
  db: Db,
  steps: PipelineStep[] = ['resolve'],
): { issueId: string; iteration: Iteration } {
  const issueId = randomUUID();
  const iterationId = randomUUID();
  db.insert(issues)
    .values({
      id: issueId,
      title: 'Report интеграция',
      jira_issue_url: null,
      pipeline_steps: steps,
      container_name: null,
      status: 'pending',
      created_at: NOW,
      updated_at: NOW,
    })
    .run();
  const iteration: Iteration = {
    id: iterationId,
    issue_id: issueId,
    number: 1,
    context: 'ctx',
    review_context: '',
    is_review_need: false,
    steps,
    status: 'pending',
    created_at: NOW,
    updated_at: NOW,
  };
  db.insert(iterations).values(iteration).run();
  return { issueId, iteration };
}

async function runOnce(
  db: Db,
  deps: IterationRunDeps,
  issueId: string,
  iteration: Iteration,
): Promise<void> {
  await runIssueIteration(db, deps, {
    issue: { id: issueId, title: 'Report интеграция', pipelineSteps: ['resolve'] },
    iteration: {
      id: iteration.id,
      issueId,
      number: iteration.number,
      context: iteration.context,
      steps: iteration.steps,
    },
    repositories: [],
    repoWorkspaces: [],
  });
}

function reportCall(pi: FakePiRunner, issueId: string) {
  return pi.calls.find(
    (call) => call.options?.stepRunId === `${issueId}/report`,
  );
}

describe('report-агент — интеграция (F22–F25)', () => {
  it('F22: пустые narratives → report.md/html всё равно создаются, fallback на engine-сводку', async () => {
    const root = tempRoot();
    const db = createDb(':memory:');
    const { issueId, iteration } = seedIteration(db, ['resolve']);
    const pi = new ReportStubPi(root, {
      'report.md': '# Report\n\nNo agent narratives available.\n',
      'report.html': SELF_CONTAINED_HTML,
    });
    const deps = makeDeps(pi);
    deps.workspaceRoot = root;
    pi.enqueue(pass('resolve'));

    await runOnce(db, deps, issueId, iteration);

    const call = reportCall(pi, issueId);
    expect(call).toBeDefined();
    // Промпт знает про фолбек на механические engine-сводки.
    expect(call!.prompt).toContain('Engine summaries');
    expect(call!.prompt).toContain('report-');
    // Папка итерации существует, но пуста — промпт всё равно указывает на неё.
    expect(call!.prompt).toContain('iterations/1/');

    // Оба артефакта на месте.
    const wsDir = join(root, issueId);
    expect(existsSync(join(wsDir, 'report.md'))).toBe(true);
    expect(existsSync(join(wsDir, 'report.html'))).toBe(true);
    // Fallback-источник тоже есть: engine написал report-<n>.md.
    expect(existsSync(join(wsDir, 'report-1.md'))).toBe(true);
  });

  it('F23: частичная итерация → промпт видит доступные narratives и отчёт собирается', async () => {
    const root = tempRoot();
    const db = createDb(':memory:');
    const { issueId, iteration } = seedIteration(db, ['resolve']);
    // Итерация упала на середине: есть только .refine.md, .resolve.md нет.
    const narrativesDir = join(root, issueId, 'iterations', '1');
    mkdirSync(narrativesDir, { recursive: true });
    writeFileSync(join(narrativesDir, '.refine.md'), '# Plan\n', 'utf8');

    const pi = new ReportStubPi(root, { 'report.md': '# Report\n' });
    const deps = makeDeps(pi);
    deps.workspaceRoot = root;
    pi.enqueue(pass('resolve'));

    await runOnce(db, deps, issueId, iteration);

    const call = reportCall(pi, issueId);
    expect(call).toBeDefined();
    // Папка итерации перечислена, шаговые файлы названы по именам — агент
    // читает то, что реально есть, и не падает на отсутствующем .resolve.md.
    expect(call!.prompt).toContain('iterations/1/');
    expect(call!.prompt).toContain('.refine.md');
    expect(call!.prompt).toContain('.resolve.md');

    expect(existsSync(join(root, issueId, 'report.md'))).toBe(true);
    // Частичный narrative не перетёрт.
    expect(existsSync(join(narrativesDir, '.refine.md'))).toBe(true);
  });

  it('F24: несколько итераций → промпт перечисляет все папки iterations/<n>/', () => {
    const text = buildStepPrompt({
      step: 'report',
      issueTitle: 'Много итераций',
      description: '',
      jiraText: null,
      context: 'Task completed.',
      feedback: null,
      repoPaths: [],
      iterationCount: 3,
    });

    expect(text).toContain('iterations/1/');
    expect(text).toContain('iterations/2/');
    expect(text).toContain('iterations/3/');
    // Секции отчёта — по одной на итерацию.
    expect(text).toContain('Iteration-by-iteration narrative');
  });

  it('F25: report.html — self-contained контракт, внешних ресурсов нет', async () => {
    // Контракт в промпте: инлайн, без внешних шрифтов/скриптов, data-URI.
    const prompt = buildStepPrompt({
      step: 'report',
      issueTitle: 'Self-contained',
      description: '',
      jiraText: null,
      context: 'Task completed.',
      feedback: null,
      repoPaths: [],
      iterationCount: 1,
    });
    expect(prompt).toContain('No external fonts');
    expect(prompt).toContain('data URI');
    expect(prompt).toContain('Self-contained');

    // Артефакт, который пишет report-агент, не должен ссылаться наружу.
    const root = tempRoot();
    const db = createDb(':memory:');
    const { issueId, iteration } = seedIteration(db, ['resolve']);
    const pi = new ReportStubPi(root, { 'report.html': SELF_CONTAINED_HTML });
    const deps = makeDeps(pi);
    deps.workspaceRoot = root;
    pi.enqueue(pass('resolve'));

    await runOnce(db, deps, issueId, iteration);

    const html = readFileSync(join(root, issueId, 'report.html'), 'utf8');
    expect(html).toContain('<style>');
    expect(html).toContain('data:image/png;base64,');
    expect(externalReferences(html)).toEqual([]);
    // Санity: сканер действительно ловит внешнюю ссылку.
    expect(
      externalReferences('<script src="https://cdn.example.com/x.js"></script>'),
    ).toHaveLength(1);
  });

  it('F26: прошлые report.md/html архивируются, новый отчёт пишется заново', async () => {
    const root = tempRoot();
    const db = createDb(':memory:');
    const { issueId, iteration } = seedIteration(db, ['resolve']);

    // Прошлый (плохой) отчёт уже лежит в корне рабочей папки.
    const wsDir = join(root, issueId);
    mkdirSync(wsDir, { recursive: true });
    writeFileSync(join(wsDir, 'report.md'), '# СТАРЫЙ\n', 'utf8');
    writeFileSync(join(wsDir, 'report.html'), '<html>старый</html>', 'utf8');

    const pi = new ReportStubPi(root, {
      'report.md': '# НОВЫЙ\n',
      'report.html': SELF_CONTAINED_HTML,
    });
    const deps = makeDeps(pi);
    deps.workspaceRoot = root;
    pi.enqueue(pass('resolve'));

    await runOnce(db, deps, issueId, iteration);

    // В корне — только новые файлы: агент не мог «дописать» старые.
    expect(readFileSync(join(wsDir, 'report.md'), 'utf8')).toBe('# НОВЫЙ\n');
    expect(readFileSync(join(wsDir, 'report.html'), 'utf8')).toBe(
      SELF_CONTAINED_HTML,
    );
    // История сохранена в reports/<ISO-ts>/.
    const stamps = readdirSync(join(wsDir, 'reports'));
    expect(stamps).toHaveLength(1);
    const archived = join(wsDir, 'reports', stamps[0]);
    expect(readFileSync(join(archived, 'report.md'), 'utf8')).toBe('# СТАРЫЙ\n');
    expect(readFileSync(join(archived, 'report.html'), 'utf8')).toBe(
      '<html>старый</html>',
    );
  });

  it('F29: утечка id модели в артефакт → warnings + console.warn, файл не правится', async () => {
    const root = tempRoot();
    const db = createDb(':memory:');
    const { issueId } = seedIteration(db);
    const model = 'provider1/leaky-model-x1';
    mkdirSync(join(root, issueId), { recursive: true });
    const pi = new ReportStubPi(root, {
      'report.md': `# Отчёт\nМодель: ${model}\n`,
      'report.html': `<html><body><strong>Модель:</strong> ${model}</body></html>`,
    });
    pi.enqueue(pass('resolve'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

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
        model,
      },
    );

    expect(reportWarningsFor(issueId)).toEqual([
      'model id leaked into report.md',
      'model id leaked into report.html',
    ]);
    expect(warn).toHaveBeenCalledWith(
      'model id leaked into report artifacts',
      expect.objectContaining({ issueId }),
    );
    // Артефакт чужой — сервер только детектит, файл не переписывает.
    expect(readFileSync(join(root, issueId, 'report.md'), 'utf8')).toContain(
      model,
    );
    warn.mockRestore();
  });

  it('F30: чистый отчёт → предупреждений нет', async () => {
    const root = tempRoot();
    const db = createDb(':memory:');
    const { issueId } = seedIteration(db);
    mkdirSync(join(root, issueId), { recursive: true });
    const pi = new ReportStubPi(root, {
      'report.md': '# Отчёт без идентификатора\n',
      'report.html': SELF_CONTAINED_HTML,
    });
    pi.enqueue(pass('resolve'));

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
        model: 'provider1/leaky-model-x1',
      },
    );

    expect(reportWarningsFor(issueId)).toEqual([]);
  });

  it('F31: чужой id модели в артефакте → model-like warning (слой 2, без input.model)', async () => {
    const root = tempRoot();
    const db = createDb(':memory:');
    const { issueId } = seedIteration(db);
    mkdirSync(join(root, issueId), { recursive: true });
    const pi = new ReportStubPi(root, {
      'report.md': '# Отчёт\nПровайдер: provider2/deepseek-x\n',
      'report.html': `${SELF_CONTAINED_HTML}\n<!-- provider2/deepseek-x -->`,
    });
    pi.enqueue(pass('resolve'));

    // Модель текущего прогона НЕ передаём — слой 2 должен ловить сам.
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

    expect(reportWarningsFor(issueId)).toEqual([
      'model-like id leaked into report.md',
      'model-like id leaked into report.html',
    ]);
  });

  it('F32: легальный текст (signal store model, модель данных) → без warning', async () => {
    const root = tempRoot();
    const db = createDb(':memory:');
    const { issueId } = seedIteration(db);
    mkdirSync(join(root, issueId), { recursive: true });
    const pi = new ReportStubPi(root, {
      'report.md': [
        '# Отчёт',
        'Модель данных: нормализованная схема.',
        'signal store model',
        'model view',
        '',
      ].join('\n'),
      'report.html': SELF_CONTAINED_HTML,
    });
    pi.enqueue(pass('resolve'));

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
        model: 'provider1/clean-ish-model',
      },
    );

    expect(reportWarningsFor(issueId)).toEqual([]);
  });

  it('F33: строка старта несёт trigger и timestamp', async () => {
    const root = tempRoot();
    const db = createDb(':memory:');
    const { issueId } = seedIteration(db);
    mkdirSync(join(root, issueId), { recursive: true });
    const pi = new ReportStubPi(root, {
      'report.md': '# ok\n',
      'report.html': SELF_CONTAINED_HTML,
    });
    pi.enqueue(pass('resolve'));
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
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
          trigger: 'post-iteration',
        },
      );

      const lines = logSpy.mock.calls.map((call) => String(call[0]));
      expect(
        lines.some(
          (line) =>
            line.includes('report agent started:') &&
            line.includes('trigger=post-iteration') &&
            /at=\d{4}-\d{2}-\d{2}T/.test(line),
        ),
      ).toBe(true);
    } finally {
      logSpy.mockRestore();
    }
  });

  it('F34: stats.model → observedModel (игла точного слоя), running.model остаётся null', async () => {
    const root = tempRoot();
    const db = createDb(':memory:');
    const { issueId } = seedIteration(db);
    mkdirSync(join(root, issueId), { recursive: true });
    const pi = new ObservedModelReportPi(root, 'provider9/x');
    const sse = new InMemorySseHub();
    const events: SSEEvent[] = [];
    sse.subscribeByIssue(issueId, (event) => events.push(event));

    await runReportAgent(
      {
        pi,
        sse,
        control: new InMemoryStepSessionRegistry(),
        workspaceRoot: root,
        db,
      },
      { issueId, containerName: 'c', hostDir: join(root, issueId), prompt: 'p' },
    );

    // running-событие не выдумывает модель: она станет известна post-hoc.
    const running = events.find(
      (event) =>
        event.type === 'step_status' && String(event.data).includes('"running"'),
    );
    expect(JSON.parse(String(running?.data)).model).toBeNull();

    // Наблюдённая модель сохранена и служит иглой точного слоя на чтении.
    expect(observedModelFor(issueId)).toBe('provider9/x');
    expect(reportWarningsFor(issueId, join(root, issueId))).toEqual([
      'model id leaked into report.md',
    ]);
  });

  it('F35: чтение прошлого отчёта из tool_use → anchored on previous report', async () => {
    const root = tempRoot();
    const db = createDb(':memory:');
    const { issueId } = seedIteration(db);
    mkdirSync(join(root, issueId), { recursive: true });
    const pi = new ReportStubPi(root, {
      'report.md': '# ok\n',
      'report.html': SELF_CONTAINED_HTML,
    });
    pi.enqueue({
      ...pass('report'),
      events: [
        {
          type: 'tool_use',
          toolCallId: 'a1',
          toolName: 'read',
          args: { file_path: 'reports/2026-10-23T09:26:39.028Z/report.md' },
        },
        {
          type: 'tool_use',
          toolCallId: 'a2',
          toolName: 'bash',
          args: { command: 'cat .iteration-results/9e48/report.html' },
        },
      ],
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await runReportAgent(
      {
        pi,
        sse: new InMemorySseHub(),
        control: new InMemoryStepSessionRegistry(),
        workspaceRoot: root,
        db,
      },
      { issueId, containerName: 'c', hostDir: join(root, issueId), prompt: 'p' },
    );

    // Максимум один путь на прогон — берётся первый, `bash` тоже виден.
    expect(reportWarningsFor(issueId, join(root, issueId))).toEqual([
      'anchored on previous report: reports/2026-10-23T09:26:39.028Z/report.md',
    ]);
    // Тег warn'а общий с утечкой модели; якорение — отдельной строкой в warnings.
    expect(warn).toHaveBeenCalledWith(
      'model id leaked into report artifacts',
      expect.objectContaining({
        warnings: [
          'anchored on previous report: reports/2026-10-23T09:26:39.028Z/report.md',
        ],
      }),
    );
    warn.mockRestore();
  });

  it('F36: легальные источники (report-1.md, .resolve.md) → без anchoring warning', async () => {
    const root = tempRoot();
    const db = createDb(':memory:');
    const { issueId } = seedIteration(db);
    mkdirSync(join(root, issueId), { recursive: true });
    const pi = new ReportStubPi(root, {
      'report.md': '# ok\n',
      'report.html': SELF_CONTAINED_HTML,
    });
    pi.enqueue({
      ...pass('report'),
      events: [
        {
          type: 'tool_use',
          toolCallId: 'b1',
          toolName: 'read',
          args: { file_path: '.iteration-results/9e48/report-2.md' },
        },
        {
          type: 'tool_use',
          toolCallId: 'b2',
          toolName: 'read',
          args: { path: 'iterations/1/.resolve.md' },
        },
        {
          type: 'tool_use',
          toolCallId: 'b3',
          toolName: 'read',
          args: { path: '.issue-step-result.json' },
        },
      ],
    });

    await runReportAgent(
      {
        pi,
        sse: new InMemorySseHub(),
        control: new InMemoryStepSessionRegistry(),
        workspaceRoot: root,
        db,
      },
      { issueId, containerName: 'c', hostDir: join(root, issueId), prompt: 'p' },
    );

    expect(reportWarningsFor(issueId, join(root, issueId))).toEqual([]);
  });

  it('F37: reportModelFor — report-ключ, иначе модель итерации (единый источник)', () => {
    const db = createDb(':memory:');
    const { issueId, iteration } = seedIteration(db);

    // Нет ключа report, итерация pending → ручной путь (last completed) пуст.
    expect(reportModelFor(db, issueId, iteration.id)).toBeUndefined();
    expect(reportModelFor(db, issueId)).toBeUndefined();

    db.update(iterations)
      .set({ model: 'iteration-model-y', status: 'completed' })
      .where(eq(iterations.id, iteration.id))
      .run();

    // Оба входа — движковый (по id итерации) и ручной (last completed) — дают одно.
    expect(reportModelFor(db, issueId, iteration.id)).toBe('iteration-model-y');
    expect(reportModelFor(db, issueId)).toBe('iteration-model-y');

    // Ключ report перебивает модель итерации на обоих входах.
    db.update(issues)
      .set({ step_models: { resolve: 'x', report: 'report-model-z' } })
      .where(eq(issues.id, issueId))
      .run();
    expect(reportModelFor(db, issueId, iteration.id)).toBe('report-model-z');
    expect(reportModelFor(db, issueId)).toBe('report-model-z');
  });

  it('F38: терминальный путь отчёта берёт модель итерации', async () => {
    const root = tempRoot();
    const db = createDb(':memory:');
    const { issueId, iteration } = seedIteration(db);
    db.update(iterations)
      .set({ model: 'iteration-model-y' })
      .where(eq(iterations.id, iteration.id))
      .run();
    const pi = new ReportStubPi(root, {
      'report.md': '# ok\n',
      'report.html': SELF_CONTAINED_HTML,
    });
    const deps = makeDeps(pi);

    await runOnce(db, deps, issueId, iteration);

    expect(reportCall(pi, issueId)?.options?.model).toBe('iteration-model-y');
  });

  it('F27: падение агента → старый отчёт только в архиве, в корне пусто', async () => {
    const root = tempRoot();
    const db = createDb(':memory:');
    const { issueId, iteration } = seedIteration(db, ['resolve']);
    const wsDir = join(root, issueId);
    mkdirSync(wsDir, { recursive: true });
    writeFileSync(join(wsDir, 'report.md'), '# СТАРЫЙ\n', 'utf8');

    class FailingReportPi extends FakePiRunner {
      override run(
        containerName: string,
        prompt: string,
        options?: PiRunOptions,
      ) {
        if (options?.stepRunId?.endsWith('/report')) {
          return Promise.reject(new Error('report boom'));
        }
        return super.run(containerName, prompt, options);
      }
    }
    const pi = new FailingReportPi();
    const deps = makeDeps(pi);
    deps.workspaceRoot = root;
    pi.enqueue(pass('resolve'));

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await runOnce(db, deps, issueId, iteration);

      // Старый файл не восстанавливается в корень — честное неготовое состояние.
      expect(existsSync(join(wsDir, 'report.md'))).toBe(false);
      const stamps = readdirSync(join(wsDir, 'reports'));
      expect(stamps).toHaveLength(1);
      expect(
        readFileSync(join(wsDir, 'reports', stamps[0], 'report.md'), 'utf8'),
      ).toBe('# СТАРЫЙ\n');
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('F30: второй прогон поверх активного не архивирует корень и не спавнит агента', async () => {
    const root = tempRoot();
    const db = createDb(':memory:');
    const { issueId } = seedIteration(db, ['resolve']);
    const wsDir = join(root, issueId);
    mkdirSync(wsDir, { recursive: true });
    writeFileSync(join(wsDir, 'report.md'), '# СТАРЫЙ\n', 'utf8');

    const releases: Array<() => void> = [];
    class PendingReportPi extends FakePiRunner {
      override run(
        containerName: string,
        prompt: string,
        options?: PiRunOptions,
      ) {
        if (options?.stepRunId?.endsWith('/report')) {
          return new Promise<StepExecutionResult>((resolve) => {
            releases.push(() =>
              resolve({
                step: 'report',
                exitCode: 0,
                report: null,
                stdout: '',
                stderr: '',
                aborted: false,
              } as unknown as StepExecutionResult),
            );
          });
        }
        return super.run(containerName, prompt, options);
      }
    }

    const pi = new PendingReportPi();
    const deps: ReportRunDeps = {
      pi,
      sse: new InMemorySseHub(),
      control: new InMemoryStepSessionRegistry(),
      workspaceRoot: root,
      db,
    };
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const first = runReportAgent(deps, {
        issueId,
        containerName: 'c',
        hostDir: wsDir,
        prompt: 'p',
        trigger: 'post-iteration',
      });
      // Запись прогона в БД асинхронна (строка `step_runs` создаётся до
      // архивации), поэтому спавн ждём, а не считаем синхронным.
      await vi.waitFor(() => expect(releases).toHaveLength(1));
      expect(isReportRunActive(issueId)).toBe(true);
      const stamps = readdirSync(join(wsDir, 'reports'));
      expect(stamps).toHaveLength(1);

      // Ручной запуск поверх активного: отказ до архивации, без спавна.
      await runReportAgent(deps, {
        issueId,
        containerName: 'c',
        hostDir: wsDir,
        prompt: 'p',
        trigger: 'manual',
      });
      expect(releases).toHaveLength(1);
      expect(readdirSync(join(wsDir, 'reports'))).toEqual(stamps);
      expect(isReportRunActive(issueId)).toBe(true);

      releases[0]();
      await first;
      expect(isReportRunActive(issueId)).toBe(false);
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('F28: архивировать нечего → dir=null, корень не трогается', () => {
    const root = tempRoot();
    expect(archiveReportArtifacts(root, 'no-such-issue')).toEqual({
      dir: null,
      files: [],
    });
  });
});