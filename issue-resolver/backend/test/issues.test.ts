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
import type { SSEEvent, StepExecutionResult } from '@issue-resolver/shared';
import { eq } from 'drizzle-orm';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app';
import { createDb } from '../src/db/client';
import { issueRepositories, issues, iterations, stepRuns } from '../src/db/schema';
import { FakePiRunner, type PiRunOptions } from '../src/pi/runner';
import { InMemorySseHub } from '../src/sse/hub';
import { isReportRunActive } from '../src/workflow/run-iteration.service';

const db = createDb(':memory:');
const app = buildApp(db);

const ENDPOINT = '/issue-resolver/api/v1/issues';

const post = (payload: object) =>
  app.inject({ method: 'POST', url: ENDPOINT, payload });

afterAll(async () => {
  await app.close();
});

describe('POST /issues — успешное создание', () => {
  it('только jira_issue_url + 1 репозиторий → 201, title из ключа тикета', async () => {
    const response = await post({
      jira_issue_url: 'https://jira.example.com/browse/KLA-5672',
      repositories: [
        { repository_url: 'https://github.com/acme/app.git', base_branch: 'main' },
      ],
    });

    expect(response.statusCode).toBe(201);

    const body = response.json();
    expect(typeof body.id).toBe('string');
    expect(body.title).toBe('KLA-5672');
    expect(body.status).toBe('pending');
    expect(body.jira_issue_url).toBe('https://jira.example.com/browse/KLA-5672');
    expect(body.pipeline_steps).toEqual(['refine', 'resolve']);
    expect(body.repositories).toHaveLength(1);
    expect(body.repositories[0].repository_url).toBe(
      'https://github.com/acme/app.git',
    );
    expect(body.repositories[0].branch_name).toBe('main');
    expect(body.repositories[0].created_at).toBe(body.repositories[0].updated_at);
    expect(typeof body.created_at).toBe('string');
  });

  it('bootstrap_enabled:false сохраняется per-repo, отсутствие → true', async () => {
    const response = await post({
      title: 'Без DevOps',
      repositories: [
        {
          repository_url: 'https://github.com/acme/app.git',
          base_branch: 'main',
          bootstrap_enabled: false,
        },
        {
          repository_url: 'https://github.com/acme/lib.git',
          base_branch: 'main',
        },
      ],
    });

    expect(response.statusCode).toBe(201);
    const body = response.json();

    const responseByUrl = new Map<string, boolean>(
      body.repositories.map((repo: { repository_url: string; bootstrap_enabled: boolean }) => [
        repo.repository_url,
        repo.bootstrap_enabled,
      ]),
    );
    expect(responseByUrl.get('https://github.com/acme/app.git')).toBe(false);
    expect(responseByUrl.get('https://github.com/acme/lib.git')).toBe(true);

    const dbByUrl = new Map<string, boolean>(
      db
        .select()
        .from(issueRepositories)
        .where(eq(issueRepositories.issue_id, body.id))
        .all()
        .map((row) => [row.repository_url, row.bootstrap_enabled]),
    );
    expect(dbByUrl.get('https://github.com/acme/app.git')).toBe(false);
    expect(dbByUrl.get('https://github.com/acme/lib.git')).toBe(true);
  });

  it('title передан без jira → 201, jira_issue_url === null', async () => {
    const response = await post({
      title: 'Моя задача',
      repositories: [
        { repository_url: 'https://github.com/acme/app.git', base_branch: 'main' },
      ],
    });

    expect(response.statusCode).toBe(201);

    const body = response.json();
    expect(body.title).toBe('Моя задача');
    expect(body.jira_issue_url).toBeNull();
    expect(body.status).toBe('pending');
  });

  it('pipeline_steps: дедуп с сохранением порядка, resolve уже есть', async () => {
    const response = await post({
      title: 'Шаги',
      pipeline_steps: ['review', 'resolve', 'review', 'test'],
      repositories: [
        { repository_url: 'https://github.com/acme/app.git', base_branch: 'main' },
      ],
    });

    expect(response.statusCode).toBe(201);
    expect(response.json().pipeline_steps).toEqual(['review', 'resolve', 'test']);
  });

  it('pipeline_steps без resolve → ровно выбранное, resolve не навязан', async () => {
    const response = await post({
      title: 'Без resolve',
      pipeline_steps: ['review', 'test'],
      repositories: [
        { repository_url: 'https://github.com/acme/app.git', base_branch: 'main' },
      ],
    });

    expect(response.statusCode).toBe(201);
    expect(response.json().pipeline_steps).toEqual(['review', 'test']);
  });

  it('пишет issue_repositories и iteration #1 в БД (одна транзакция)', async () => {
    const response = await post({
      title: 'С контекстом',
      additional_context: 'доп контекст',
      pipeline_steps: ['review'],
      repositories: [
        { repository_url: 'https://github.com/acme/app.git', base_branch: 'main' },
        { repository_url: 'https://github.com/acme/lib.git', base_branch: 'develop' },
      ],
    });

    expect(response.statusCode).toBe(201);
    const body = response.json();

    const repoRows = db
      .select()
      .from(issueRepositories)
      .where(eq(issueRepositories.issue_id, body.id))
      .all();
    expect(repoRows).toHaveLength(2);
    expect(repoRows.map((row) => row.branch_name).sort()).toEqual([
      'develop',
      'main',
    ]);

    const iterationRows = db
      .select()
      .from(iterations)
      .where(eq(iterations.issue_id, body.id))
      .all();
    expect(iterationRows).toHaveLength(1);
    expect(iterationRows[0].number).toBe(1);
    expect(['running', 'completed']).toContain(iterationRows[0].status);
    expect(iterationRows[0].context).toBe('доп контекст');
    expect(iterationRows[0].steps).toEqual(['review']);
  });

  it('шаги: review-only НЕ добавляет test', async () => {
    const response = await post({
      title: 'Только ревью',
      pipeline_steps: ['review'],
      repositories: [
        { repository_url: 'https://github.com/acme/app.git', base_branch: 'main' },
      ],
    });

    expect(response.statusCode).toBe(201);
    const steps = response.json().pipeline_steps as string[];
    expect(steps).toEqual(['review']);
    expect(steps).not.toContain('test');
  });

  it('шаги: test-only НЕ добавляет review', async () => {
    const response = await post({
      title: 'Только тест',
      pipeline_steps: ['test'],
      repositories: [
        { repository_url: 'https://github.com/acme/app.git', base_branch: 'main' },
      ],
    });

    expect(response.statusCode).toBe(201);
    const steps = response.json().pipeline_steps as string[];
    expect(steps).toEqual(['test']);
    expect(steps).not.toContain('review');
  });

  it('шаги: review+test — оба и в исходном порядке', async () => {
    const response = await post({
      title: 'Ревью и тест',
      pipeline_steps: ['review', 'test'],
      repositories: [
        { repository_url: 'https://github.com/acme/app.git', base_branch: 'main' },
      ],
    });

    expect(response.statusCode).toBe(201);
    expect(response.json().pipeline_steps).toEqual(['review', 'test']);
  });

  it('шаги: без review/test в pipeline_steps — ни одного (is_review_need больше не навязывает)', async () => {
    const response = await post({
      title: 'Без ревью, но с флагом',
      is_review_need: true,
      repositories: [
        { repository_url: 'https://github.com/acme/app.git', base_branch: 'main' },
      ],
    });

    expect(response.statusCode).toBe(201);
    const steps = response.json().pipeline_steps as string[];
    expect(steps).toEqual(['refine', 'resolve']);
    expect(steps).not.toContain('review');
    expect(steps).not.toContain('test');
  });

  it('create_mr:true у репозитория → pr в конец', async () => {
    const response = await post({
      title: 'MR',
      repositories: [
        {
          repository_url: 'https://github.com/acme/app.git',
          base_branch: 'main',
          create_mr: true,
        },
      ],
    });

    expect(response.statusCode).toBe(201);
    expect(response.json().pipeline_steps).toEqual(['refine', 'resolve', 'pr']);
  });

  it('pipeline_steps review+test + create_mr:true → pr в конец', async () => {
    const response = await post({
      title: 'Ревью + тест + MR',
      pipeline_steps: ['review', 'test'],
      repositories: [
        {
          repository_url: 'https://github.com/acme/app.git',
          base_branch: 'main',
          create_mr: true,
        },
      ],
    });

    expect(response.statusCode).toBe(201);
    expect(response.json().pipeline_steps).toEqual([
      'review',
      'test',
      'pr',
    ]);
  });
});

describe('POST /issues — валидация', () => {
  it('без title и без jira → 400', async () => {
    const response = await post({
      repositories: [
        { repository_url: 'https://github.com/acme/app.git', base_branch: 'main' },
      ],
    });

    expect(response.statusCode).toBe(400);
    expect(typeof response.json().error).toBe('string');
  });

  it('repositories не массив → 400', async () => {
    const response = await post({ title: 'Пусто', repositories: 'nope' });

    expect(response.statusCode).toBe(400);
    expect(typeof response.json().error).toBe('string');
  });

  it('repository_url не URL → 400', async () => {
    const response = await post({
      title: 'Кривой URL',
      repositories: [{ repository_url: 'not-a-url', base_branch: 'main' }],
    });

    expect(response.statusCode).toBe(400);
    expect(typeof response.json().error).toBe('string');
  });

  it('base_branch пустой → 400', async () => {
    const response = await post({
      title: 'Пустая ветка',
      repositories: [{ repository_url: 'https://github.com/acme/app.git', base_branch: '' }],
    });

    expect(response.statusCode).toBe(400);
    expect(typeof response.json().error).toBe('string');
  });

  it('jira_issue_url без ключа в пути → 400', async () => {
    const response = await post({
      jira_issue_url: 'https://jira.example.com/',
      repositories: [
        { repository_url: 'https://github.com/acme/app.git', base_branch: 'main' },
      ],
    });

    expect(response.statusCode).toBe(400);
    expect(typeof response.json().error).toBe('string');
  });

  it('step_models с невалидным ключом шага → 400', async () => {
    const response = await post({
      title: 'Кривой шаг',
      step_models: { bogus: 'm' },
      repositories: [],
    });

    expect(response.statusCode).toBe(400);
    expect(typeof response.json().error).toBe('string');
  });

  it('step_models с нестроковым значением → 400', async () => {
    const response = await post({
      title: 'Кривой тип',
      step_models: { resolve: 5 },
      repositories: [],
    });

    expect(response.statusCode).toBe(400);
    expect(typeof response.json().error).toBe('string');
  });
});

class PendingReportPi extends FakePiRunner {
  private release: (() => void) | null = null;

  override run(
    containerName: string,
    prompt: string,
    options?: PiRunOptions,
  ): Promise<StepExecutionResult> {
    if (options?.stepRunId?.endsWith('.report')) {
      return new Promise((resolve) => {
        this.release = () =>
          resolve({
            step: 'report',
            exitCode: 0,
            report: null,
            stdout: '',
            stderr: '',
            aborted: false,
          } as unknown as StepExecutionResult);
      });
    }
    return super.run(containerName, prompt, options);
  }

  releaseRun(): void {
    this.release?.();
  }
}

class FailingReportPi extends FakePiRunner {
  override run(
    containerName: string,
    prompt: string,
    options?: PiRunOptions,
  ): Promise<StepExecutionResult> {
    if (options?.stepRunId?.endsWith('.report')) {
      return Promise.reject(new Error('report boom'));
    }
    return super.run(containerName, prompt, options);
  }
}

class LeakyReportPi extends FakePiRunner {
  constructor(private readonly model: string) {
    super();
  }

  override run(
    containerName: string,
    prompt: string,
    options?: PiRunOptions,
  ): Promise<StepExecutionResult> {
    if (options?.stepRunId?.endsWith('.report') && options.cwd) {
      mkdirSync(options.cwd, { recursive: true });
      writeFileSync(
        join(options.cwd, 'report.md'),
        `# Отчёт\nМодель: ${this.model}\n`,
        'utf8',
      );
      writeFileSync(
        join(options.cwd, 'report.json'),
        JSON.stringify({ subtitle: this.model }),
        'utf8',
      );
    }
    return super.run(containerName, prompt, options);
  }
}

class ObservedModelPi extends FakePiRunner {
  constructor(private readonly observed: string) {
    super();
  }

  override run(
    containerName: string,
    prompt: string,
    options?: PiRunOptions,
  ): Promise<StepExecutionResult> {
    if (options?.stepRunId?.endsWith('.report') && options.cwd) {
      mkdirSync(options.cwd, { recursive: true });
      writeFileSync(
        join(options.cwd, 'report.md'),
        `# Отчёт\nПровайдер: ${this.observed}\n`,
        'utf8',
      );
      return Promise.resolve({
        step: 'report',
        exitCode: 0,
        report: { status: 'pass', summary: 'ok' },
        stdout: '',
        stderr: '',
        stats: {
          model: this.observed,
          userMessages: 0,
          assistantMessages: 0,
          toolCalls: 0,
          toolResults: 0,
          totalMessages: 0,
          tokens: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            total: 0,
          },
          cost: null,
          contextUsage: null,
        },
      });
    }
    return super.run(containerName, prompt, options);
  }
}

class AnchoringReportPi extends FakePiRunner {
  override run(
    containerName: string,
    prompt: string,
    options?: PiRunOptions,
  ): Promise<StepExecutionResult> {
    if (options?.stepRunId?.endsWith('.report') && options.cwd) {
      mkdirSync(options.cwd, { recursive: true });
      writeFileSync(join(options.cwd, 'report.md'), '# Отчёт\n', 'utf8');
      writeFileSync(
        join(options.cwd, 'report.html'),
        '<html><body>Отчёт</body></html>',
        'utf8',
      );
      options.onEvent?.({
        type: 'tool_use',
        toolCallId: 'x1',
        toolName: 'read',
        args: {
          file_path: 'reports/2026-10-23T09:26:39.028Z/report.md',
        },
      });
      return Promise.resolve({
        step: 'report',
        exitCode: 0,
        report: { status: 'pass', summary: 'ok' },
        stdout: '',
        stderr: '',
      });
    }
    return super.run(containerName, prompt, options);
  }
}

describe('report routes (D13–D18)', () => {
  const root = mkdtempSync(join(tmpdir(), 'ir-routes-report-'));
  const reportSse = new InMemorySseHub();
  const reportApp = buildApp(db, {
    workspaceRoot: root,
    sse: reportSse,
    pi: new FakePiRunner(),
  });

  afterAll(async () => {
    await reportApp.close();
    rmSync(root, { recursive: true, force: true });
  });

  const createIssue = async (): Promise<string> => {
    const response = await post({
      title: 'Report route',
      repositories: [
        { repository_url: 'https://github.com/acme/app.git', base_branch: 'main' },
      ],
    });
    expect(response.statusCode).toBe(201);
    return response.json().id as string;
  };

  const seedIssueRow = (): string => {
    const id = randomUUID();
    const now = new Date().toISOString();
    db.insert(issues)
      .values({
        id,
        title: 'Report seed',
        jira_issue_url: null,
        pipeline_steps: ['resolve'],
        container_name: null,
        status: 'completed',
        created_at: now,
        updated_at: now,
      })
      .run();
    return id;
  };

  it('D13: POST /issues/:id/report → 202 { ok: true, reportRunId }', async () => {
    const id = await createIssue();

    const response = await reportApp.inject({
      method: 'POST',
      url: `${ENDPOINT}/${id}/report`,
    });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({ ok: true, reportRunId: `issue.${id}.report` });
  });

  it('D14: POST /issues/:id/report неизвестной задачи → 404', async () => {
    const response = await reportApp.inject({
      method: 'POST',
      url: `${ENDPOINT}/no-such-issue/report`,
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: 'issue not found' });
  });

  it('D15: GET /issues/:id/report/status без report.md → idle', async () => {
    const id = await createIssue();

    const response = await reportApp.inject({
      method: 'GET',
      url: `${ENDPOINT}/${id}/report/status`,
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.status).toBe('idle');
    expect(body.artifacts.md).toEqual({
      present: false,
      bytes: 0,
      mtime: null,
    });
    expect(body.artifacts.html.present).toBe(false);
  });

  it('D16: GET /issues/:id/report/status с report.md → success + lastRunAt', async () => {
    const id = await createIssue();
    mkdirSync(join(root, id), { recursive: true });
    writeFileSync(join(root, id, 'report.md'), '# Отчёт\n', 'utf8');

    const response = await reportApp.inject({
      method: 'GET',
      url: `${ENDPOINT}/${id}/report/status`,
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.status).toBe('success');
    expect(body.lastRunAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  });

  it('D17: GET /issues/:id/report/status неизвестной задачи → 404', async () => {
    const response = await reportApp.inject({
      method: 'GET',
      url: `${ENDPOINT}/no-such-issue/report/status`,
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: 'issue not found' });
  });

  it('D17b: строка running без сердцебиения → failed, строка погашена', async () => {
    const id = await createIssue();
    const staleAt = new Date(Date.now() - 10 * 60_000).toISOString();
    const runId = randomUUID();
    db.insert(stepRuns)
      .values({
        id: runId,
        issue_id: id,
        iteration_id: null,
        step: 'report',
        attempt: 1,
        status: 'running',
        context: 'manual',
        feedback: null,
        created_at: staleAt,
        updated_at: staleAt,
      })
      .run();

    const response = await reportApp.inject({
      method: 'GET',
      url: `${ENDPOINT}/${id}/report/status`,
    });

    const body = response.json();
    expect(body.status).toBe('failed');
    expect(body.feedback).toContain('нет активности');
    expect(body.finishedAt).toBe(staleAt);
    const row = db.select().from(stepRuns).where(eq(stepRuns.id, runId)).get();
    expect(row?.status).toBe('failed');
  });

  it('D17c: живой прогон остаётся running и без finishedAt', async () => {
    const id = await createIssue();
    const freshAt = new Date().toISOString();
    const runId = randomUUID();
    db.insert(stepRuns)
      .values({
        id: runId,
        issue_id: id,
        iteration_id: null,
        step: 'report',
        attempt: 1,
        status: 'running',
        context: 'manual',
        feedback: null,
        created_at: freshAt,
        updated_at: freshAt,
      })
      .run();

    const body = (
      await reportApp.inject({
        method: 'GET',
        url: `${ENDPOINT}/${id}/report/status`,
      })
    ).json();

    expect(body.status).toBe('running');
    expect(body.runStatus).toBe('running');
    expect(body.finishedAt).toBeUndefined();
    expect(body.updatedAt).toBe(freshAt);
  });

  it('D18: POST /report публикует step_status running → success по reportRunId', async () => {
    const id = await createIssue();
    const events: SSEEvent[] = [];
    reportSse.subscribeByIssue(id, (event) => events.push(event));

    const response = await reportApp.inject({
      method: 'POST',
      url: `${ENDPOINT}/${id}/report`,
    });
    expect(response.statusCode).toBe(202);
    const reportRunId = response.json().reportRunId as string;
    const statuses = () =>
      events.filter(
        (event) =>
          event.type === 'step_status' && event.stepRunId === reportRunId,
      );

    await vi.waitFor(() => expect(statuses()).toHaveLength(2));
    expect(JSON.parse(statuses()[0].data)).toMatchObject({
      status: 'running',
      step: 'report',
    });
    expect(statuses()[1].data).toBe('failed');
    const status = await reportApp.inject({
      method: 'GET',
      url: `${ENDPOINT}/${id}/report/status`,
    });
    expect(status.json().status).toBe('failed');
    expect(status.json().feedback).toContain('report.md');
  });

  it('D19: POST /report архивирует прошлый отчёт до спавна; /result → 404, не 500', async () => {
    const id = await createIssue();
    const wsDir = join(root, id);
    mkdirSync(wsDir, { recursive: true });
    writeFileSync(join(wsDir, 'report.md'), '# СТАРЫЙ\n', 'utf8');

    const response = await reportApp.inject({
      method: 'POST',
      url: `${ENDPOINT}/${id}/report`,
    });
    expect(response.statusCode).toBe(202);

    const archivedRoot = join(wsDir, 'reports');
    const stamps = readdirSync(archivedRoot);
    expect(stamps).toHaveLength(1);
    expect(readFileSync(join(archivedRoot, stamps[0], 'report.md'), 'utf8')).toBe(
      '# СТАРЫЙ\n',
    );
    expect(existsSync(join(wsDir, 'report.md'))).toBe(false);

    const result = await reportApp.inject({
      method: 'GET',
      url: `${ENDPOINT}/${id}/result`,
    });
    expect(result.statusCode).toBe(404);
    expect(result.json()).toEqual({ error: 'result not found' });
  });

  it('D20: во время прогона /result отдаёт снапшот с x-artifact-source; статус running', async () => {
    const id = seedIssueRow();
    const iterId = randomUUID();
    mkdirSync(join(root, id, '.iteration-results', iterId), { recursive: true });
    writeFileSync(
      join(root, id, '.iteration-results', iterId, 'report.html'),
      '<html>OLD SNAPSHOT</html>',
      'utf8',
    );
    db.insert(iterations)
      .values({
        id: iterId,
        issue_id: id,
        number: 1,
        context: '',
        review_context: '',
        is_review_need: false,
        steps: ['resolve'],
        status: 'completed',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .run();

    const pi = new PendingReportPi();
    const guardApp = buildApp(db, {
      workspaceRoot: root,
      sse: new InMemorySseHub(),
      pi,
    });
    try {
      const before = await guardApp.inject({
        method: 'GET',
        url: `${ENDPOINT}/${id}/result`,
      });
      expect(before.statusCode).toBe(200);
      expect(before.headers['x-artifact-source']).toBe('iteration-snapshot');
      expect(before.headers['x-artifact-mtime']).toBeDefined();
      expect(before.body).toContain('OLD SNAPSHOT');

      const start = await guardApp.inject({
        method: 'POST',
        url: `${ENDPOINT}/${id}/report`,
      });
      expect(start.statusCode).toBe(202);
      expect(isReportRunActive(id)).toBe(true);

      const during = await guardApp.inject({
        method: 'GET',
        url: `${ENDPOINT}/${id}/result`,
      });
      expect(during.statusCode).toBe(200);
      expect(during.headers['x-artifact-source']).toBe('iteration-snapshot');
      expect(during.body).toContain('OLD SNAPSHOT');

      const statusDuring = await guardApp.inject({
        method: 'GET',
        url: `${ENDPOINT}/${id}/report/status`,
      });
      expect(statusDuring.json().status).toBe('running');

      pi.releaseRun();
      await vi.waitFor(() => expect(isReportRunActive(id)).toBe(false));
    } finally {
      await guardApp.close();
    }
  });

  it('D22: POST /report во время активного прогона → 409, без второго архива', async () => {
    const id = seedIssueRow();
    const wsDir = join(root, id);
    mkdirSync(wsDir, { recursive: true });
    writeFileSync(join(wsDir, 'report.md'), '# СТАРЫЙ\n', 'utf8');

    const pi = new PendingReportPi();
    const guardApp = buildApp(db, {
      workspaceRoot: root,
      sse: new InMemorySseHub(),
      pi,
    });
    try {
      const first = await guardApp.inject({
        method: 'POST',
        url: `${ENDPOINT}/${id}/report`,
      });
      expect(first.statusCode).toBe(202);
      const stamps = readdirSync(join(wsDir, 'reports'));
      expect(stamps).toHaveLength(1);

      const second = await guardApp.inject({
        method: 'POST',
        url: `${ENDPOINT}/${id}/report`,
      });
      expect(second.statusCode).toBe(409);
      expect(second.json()).toEqual({ error: 'report run already active' });
      expect(readdirSync(join(wsDir, 'reports'))).toEqual(stamps);

      expect(isReportRunActive(id)).toBe(true);
      const status = await guardApp.inject({
        method: 'GET',
        url: `${ENDPOINT}/${id}/report/status`,
      });
      expect(status.json().status).toBe('running');

      pi.releaseRun();
      await vi.waitFor(() => expect(isReportRunActive(id)).toBe(false));
    } finally {
      await guardApp.close();
    }
  });

  it('D21: /result из корня → source=root; нет ни там, ни там → 404', async () => {
    const id = seedIssueRow();
    mkdirSync(join(root, id), { recursive: true });
    writeFileSync(join(root, id, 'report.html'), '<h1>Fresh</h1>', 'utf8');

    const fromRoot = await reportApp.inject({
      method: 'GET',
      url: `${ENDPOINT}/${id}/result`,
    });
    expect(fromRoot.statusCode).toBe(200);
    expect(fromRoot.headers['x-artifact-source']).toBe('root');
    expect(fromRoot.body).toContain('Fresh');

    const empty = seedIssueRow();
    const missing = await reportApp.inject({
      method: 'GET',
      url: `${ENDPOINT}/${empty}/result`,
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual({ error: 'result not found' });
  });

  it('D22: /report/status → failed, если прогон упал и корень пуст', async () => {
    const id = seedIssueRow();
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const failApp = buildApp(db, {
      workspaceRoot: root,
      sse: new InMemorySseHub(),
      pi: new FailingReportPi(),
    });
    try {
      const res = await failApp.inject({
        method: 'POST',
        url: `${ENDPOINT}/${id}/report`,
      });
      expect(res.statusCode).toBe(202);

      await vi.waitFor(async () => {
        const status = await failApp.inject({
          method: 'GET',
          url: `${ENDPOINT}/${id}/report/status`,
        });
        expect(status.json()).toMatchObject({ status: 'failed' });
      });
    } finally {
      await failApp.close();
      errSpy.mockRestore();
    }
  });

  it('D23: html нет нигде, md есть только в снапшоте → /result 200 text/markdown + iteration-snapshot', async () => {
    const id = seedIssueRow();
    const iterId = randomUUID();
    mkdirSync(join(root, id, '.iteration-results', iterId), { recursive: true });
    writeFileSync(
      join(root, id, '.iteration-results', iterId, 'report.md'),
      '# SNAPSHOT MD\n',
      'utf8',
    );
    db.insert(iterations)
      .values({
        id: iterId,
        issue_id: id,
        number: 1,
        context: '',
        review_context: '',
        is_review_need: false,
        steps: ['resolve'],
        status: 'completed',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .run();

    const res = await reportApp.inject({
      method: 'GET',
      url: `${ENDPOINT}/${id}/result`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/markdown');
    expect(res.headers['x-artifact-source']).toBe('iteration-snapshot');
    expect(res.headers['x-artifact-mtime']).toBeDefined();
    expect(res.body).toContain('SNAPSHOT MD');

    const md = await reportApp.inject({
      method: 'GET',
      url: `${ENDPOINT}/${id}/result/md`,
    });
    expect(md.statusCode).toBe(200);
    expect(md.headers['x-artifact-source']).toBe('iteration-snapshot');
  });

  it('D24: утечка id модели → warnings в статусе + x-artifact-warning на /result', async () => {
    const model = 'provider1/leaky-model-x1';
    const id = seedIssueRow();
    db.update(issues)
      .set({ step_models: { report: model } })
      .where(eq(issues.id, id))
      .run();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const leakApp = buildApp(db, {
      workspaceRoot: root,
      sse: new InMemorySseHub(),
      pi: new LeakyReportPi(model),
    });
    try {
      const res = await leakApp.inject({
        method: 'POST',
        url: `${ENDPOINT}/${id}/report`,
      });
      expect(res.statusCode).toBe(202);

      await vi.waitFor(async () => {
        const status = await leakApp.inject({
          method: 'GET',
          url: `${ENDPOINT}/${id}/report/status`,
        });
        expect(status.json()).toMatchObject({
          status: 'success',
          lastRunAt: expect.any(String),
          warnings: [
            'model id leaked into report.md',
            'model id leaked into report.json',
          ],
        });
      });

      const result = await leakApp.inject({
        method: 'GET',
        url: `${ENDPOINT}/${id}/result`,
      });
      expect(result.headers['x-artifact-warning']).toBe(
        'model id leaked into report.md; model id leaked into report.json',
      );
    } finally {
      await leakApp.close();
      warnSpy.mockRestore();
    }
  });

  it('D25: POST /report → лог trigger=manual + origin; мутация → строка mutate', async () => {
    const id = seedIssueRow();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const auditApp = buildApp(db, {
      workspaceRoot: root,
      sse: new InMemorySseHub(),
      pi: new FakePiRunner(),
    });
    try {
      const res = await auditApp.inject({
        method: 'POST',
        url: `${ENDPOINT}/${id}/report`,
        headers: { origin: 'http://localhost:5173' },
      });
      expect(res.statusCode).toBe(202);

      const lines = (): string[] =>
        logSpy.mock.calls.map((call) => String(call[0]));

      await vi.waitFor(() => {
        expect(
          lines().some(
            (line) =>
              line.includes('report agent started:') &&
              line.includes('trigger=manual') &&
              line.includes('origin=http://localhost:5173'),
          ),
        ).toBe(true);
      });

      expect(
        lines().some(
          (line) =>
            line.startsWith(
              `mutate POST ${ENDPOINT}/${id}/report`,
            ) && line.includes('status=202'),
        ),
      ).toBe(true);
    } finally {
      await auditApp.close();
      logSpy.mockRestore();
    }
  });

  it('D26: warnings читаются из файлов — переживают рестарт, не только кэш', async () => {
    const id = seedIssueRow();
    mkdirSync(join(root, id), { recursive: true });
    writeFileSync(
      join(root, id, 'report.md'),
      '# Отчёт\nПровайдер: provider2/deepseek-x\n',
      'utf8',
    );

    const status = await reportApp.inject({
      method: 'GET',
      url: `${ENDPOINT}/${id}/report/status`,
    });
    expect(status.statusCode).toBe(200);
    expect(status.json().warnings).toEqual([
      'model-like id leaked into report.md',
    ]);

    const artifact = await reportApp.inject({
      method: 'GET',
      url: `${ENDPOINT}/${id}/result/md`,
    });
    expect(artifact.headers['x-artifact-warning']).toContain(
      'model-like id leaked into report.md',
    );
  });

  it('D27: observedModel — модель из stats сессии, а не из step_models', async () => {
    const observed = 'provider9/x';
    const id = seedIssueRow();
    const app = buildApp(db, {
      workspaceRoot: root,
      sse: new InMemorySseHub(),
      pi: new ObservedModelPi(observed),
    });
    try {
      const res = await app.inject({
        method: 'POST',
        url: `${ENDPOINT}/${id}/report`,
      });
      expect(res.statusCode).toBe(202);

      await vi.waitFor(async () => {
        const status = await app.inject({
          method: 'GET',
          url: `${ENDPOINT}/${id}/report/status`,
        });
        const body = status.json();
        expect(body.observedModel).toBe(observed);
        expect(body.warnings).toEqual(['model id leaked into report.md']);
      });
    } finally {
      await app.close();
    }
  });

  it('D28: якорение на прошлом отчёте → warnings + x-artifact-warning', async () => {
    const id = seedIssueRow();
    const app = buildApp(db, {
      workspaceRoot: root,
      sse: new InMemorySseHub(),
      pi: new AnchoringReportPi(),
    });
    try {
      const res = await app.inject({
        method: 'POST',
        url: `${ENDPOINT}/${id}/report`,
      });
      expect(res.statusCode).toBe(202);

      const expected =
        'anchored on previous report: reports/2026-10-23T09:26:39.028Z/report.md';
      await vi.waitFor(async () => {
        const status = await app.inject({
          method: 'GET',
          url: `${ENDPOINT}/${id}/report/status`,
        });
        expect(status.json().warnings).toEqual([expected]);
      });

      const result = await app.inject({
        method: 'GET',
        url: `${ENDPOINT}/${id}/result`,
      });
      expect(result.headers['x-artifact-warning']).toBe(expected);
    } finally {
      await app.close();
    }
  });

  it('D29: ручной POST /report берёт модель итерации, а не системный дефолт', async () => {
    const id = seedIssueRow();
    db.update(issues)
      .set({ step_models: { resolve: 'resolve-model-x' } })
      .where(eq(issues.id, id))
      .run();
    const now = new Date().toISOString();
    db.insert(iterations)
      .values({
        id: randomUUID(),
        issue_id: id,
        number: 1,
        context: '',
        review_context: '',
        is_review_need: false,
        steps: ['resolve'],
        model: 'iteration-model-y',
        status: 'completed',
        created_at: now,
        updated_at: now,
      })
      .run();

    const pi = new FakePiRunner();
    const app = buildApp(db, {
      workspaceRoot: root,
      sse: new InMemorySseHub(),
      pi,
    });
    try {
      const res = await app.inject({
        method: 'POST',
        url: `${ENDPOINT}/${id}/report`,
      });
      expect(res.statusCode).toBe(202);

      await vi.waitFor(() => {
        const call = pi.calls.find(
          (item) => item.options?.stepRunId === `issue.${id}.report`,
        );
        expect(call?.options?.model).toBe('iteration-model-y');
      });
    } finally {
      await app.close();
    }
  });
});