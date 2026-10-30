import { writeFileSync } from 'node:fs';
import type { StepExecutionResult } from '@issue-resolver/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import type { Db } from '../src/db/client';
import { createDb } from '../src/db/client';
import { getRetroRun } from '../src/db/retro-runs.repo';
import type { PiRunOptions, PiRunner } from '../src/pi/runner';
import { retroRuns } from '../src/db/schema';
import { retroReportPath } from '../src/retro/service';

const ENDPOINT = '/issue-resolver/api/v1/settings/retro';

const openApps: Array<{ close: () => Promise<void> }> = [];

afterEach(async () => {
  await Promise.all(openApps.splice(0).map((app) => app.close()));
});

interface RunnerCall {
  prompt: string;
  options: PiRunOptions;
}

function fakeRunner(
  behaviour: (
    prompt: string,
    options: PiRunOptions,
  ) => StepExecutionResult | Promise<StepExecutionResult>,
  calls: RunnerCall[] = [],
): PiRunner {
  return {
    async run(_containerName, prompt, options = {}) {
      calls.push({ prompt, options });
      return behaviour(prompt, options);
    },
  };
}

function okResult(): StepExecutionResult {
  return { step: 'resolve', exitCode: 0, report: null, stdout: '', stderr: '' };
}

function makeApp(db: Db, pi: PiRunner) {
  const app = buildApp(db, { retroPi: pi, local: true });
  openApps.push(app);
  return app;
}

async function waitForTerminal(db: Db, id: string): Promise<string> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const run = getRetroRun(db, id);
    if (run && run.status !== 'running') return run.status;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('прогон не завершился за отведённое время');
}

describe('POST /settings/retro', () => {
  it('202: запускает прогон с моделью, лимитом сессий и инструкциями', async () => {
    const db = createDb(':memory:');
    const calls: RunnerCall[] = [];
    const app = makeApp(
      db,
      fakeRunner((_prompt, options) => {
        writeFileSync(retroReportPath(String(options.sessionId)), '# Отчёт');
        return okResult();
      }, calls),
    );

    const response = await app.inject({
      method: 'POST',
      url: ENDPOINT,
      payload: {
        model: 'qwen-test',
        thinking_level: 'max',
        session_limit: 3,
        instructions: 'сфокусируйся на навигации',
      },
    });

    expect(response.statusCode).toBe(202);
    const created = response.json() as { id: string; status: string };
    expect(created.status).toBe('running');

    expect(await waitForTerminal(db, created.id)).toBe('success');
    expect(getRetroRun(db, created.id)?.model).toBe('qwen-test');
    expect(getRetroRun(db, created.id)?.session_limit).toBe(3);
    expect(getRetroRun(db, created.id)?.thinking_level).toBe('max');
    expect(getRetroRun(db, created.id)?.instructions).toBe(
      'сфокусируйся на навигации',
    );
    expect(calls[0]?.options.model).toBe('qwen-test');
    expect(calls[0]?.options.thinkingLevel).toBe('max');
    expect(calls[0]?.prompt).toContain('сфокусируйся на навигации');
    expect(calls[0]?.prompt).toContain('sessions');
    expect(calls[0]?.prompt).toContain('3');
  });

  it('202 без тела: прогон идёт на дефолтах', async () => {
    const db = createDb(':memory:');
    const calls: RunnerCall[] = [];
    const app = makeApp(
      db,
      fakeRunner((_prompt, options) => {
        writeFileSync(retroReportPath(String(options.sessionId)), '# Отчёт');
        return okResult();
      }, calls),
    );

    const response = await app.inject({ method: 'POST', url: ENDPOINT });

    expect(response.statusCode).toBe(202);
    const created = response.json() as { id: string };
    expect(await waitForTerminal(db, created.id)).toBe('success');
    expect(calls[0]?.options.model).toBeUndefined();
    expect(getRetroRun(db, created.id)?.model).toBeNull();
    expect(calls[0]?.prompt).not.toContain('Extra instructions from the operator');
  });

  it('400: лимит сессий вне диапазона', async () => {
    const db = createDb(':memory:');
    const app = makeApp(db, fakeRunner(() => okResult()));

    const response = await app.inject({
      method: 'POST',
      url: ENDPOINT,
      payload: { session_limit: 0 },
    });

    expect(response.statusCode).toBe(400);
  });

  it('409: второй прогон не стартует, пока первый идёт', async () => {
    const db = createDb(':memory:');
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const app = makeApp(
      db,
      fakeRunner(async (_prompt, options) => {
        await gate;
        writeFileSync(retroReportPath(String(options.sessionId)), '# Отчёт');
        return okResult();
      }),
    );

    const first = await app.inject({ method: 'POST', url: ENDPOINT });
    expect(first.statusCode).toBe(202);
    const second = await app.inject({ method: 'POST', url: ENDPOINT });
    expect(second.statusCode).toBe(409);
    expect((second.json() as { id: string }).id).toBe(
      (first.json() as { id: string }).id,
    );

    const firstId = (first.json() as { id: string }).id;
    release();
    expect(await waitForTerminal(db, firstId)).toBe('success');
  });
});

describe('GET /settings/retro', () => {
  it('отдаёт историю от новых к старым и прогон с логом', async () => {
    const db = createDb(':memory:');
    const app = makeApp(
      db,
      fakeRunner((_prompt, options) => {
        options.onStdout?.('лог прогона');
        writeFileSync(retroReportPath(String(options.sessionId)), '# Отчёт');
        return okResult();
      }),
    );

    const first = await app.inject({ method: 'POST', url: ENDPOINT });
    const firstId = (first.json() as { id: string }).id;
    expect(await waitForTerminal(db, firstId)).toBe('success');

    const second = await app.inject({
      method: 'POST',
      url: ENDPOINT,
      payload: { model: 'вторая-модель' },
    });
    const secondId = (second.json() as { id: string }).id;
    expect(await waitForTerminal(db, secondId)).toBe('success');

    const list = await app.inject({ method: 'GET', url: ENDPOINT });
    expect(list.statusCode).toBe(200);
    const runs = (list.json() as { runs: Array<{ id: string }> }).runs;
    expect(runs.map((run) => run.id)).toEqual([secondId, firstId]);

    const detail = await app.inject({
      method: 'GET',
      url: `${ENDPOINT}/${firstId}`,
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.json()).toMatchObject({
      id: firstId,
      status: 'success',
      report: '# Отчёт',
    });
    expect((detail.json() as { stdout: string }).stdout).toContain('лог прогона');
  });

  it('404: неизвестный прогон', async () => {
    const db = createDb(':memory:');
    const app = makeApp(db, fakeRunner(() => okResult()));

    const response = await app.inject({
      method: 'GET',
      url: `${ENDPOINT}/нет-такого`,
    });

    expect(response.statusCode).toBe(404);
  });

  it('прерванный прогон из прошлого запуска помечается failed', async () => {
    const db = createDb(':memory:');
    const stale = createStaleRunningRun(db);
    const app = makeApp(
      db,
      fakeRunner((_prompt, options) => {
        writeFileSync(retroReportPath(String(options.sessionId)), '# Отчёт');
        return okResult();
      }),
    );

    const response = await app.inject({ method: 'POST', url: ENDPOINT });
    const createdId = (response.json() as { id: string }).id;
    expect(await waitForTerminal(db, createdId)).toBe('success');

    const staleRow = getRetroRun(db, stale);
    expect(staleRow?.status).toBe('failed');
    expect(staleRow?.error).toContain('перезапуском');
  });
});

describe('POST /settings/retro/:id/abort', () => {
  it('202: останавливает идущий прогон, прогон становится failed', async () => {
    const db = createDb(':memory:');
    const app = makeApp(db, hangingRunner());

    const created = await app.inject({ method: 'POST', url: ENDPOINT });
    const id = (created.json() as { id: string }).id;

    const aborted = await app.inject({
      method: 'POST',
      url: `${ENDPOINT}/${id}/abort`,
    });

    expect(aborted.statusCode).toBe(202);
    expect(aborted.json()).toEqual({ ok: true });
    expect(await waitForTerminal(db, id)).toBe('failed');
    expect(getRetroRun(db, id)?.error).toBe('прогон остановлен оператором');
  });

  it('404: неизвестный прогон', async () => {
    const db = createDb(':memory:');
    const app = makeApp(db, fakeRunner(() => okResult()));

    const response = await app.inject({
      method: 'POST',
      url: `${ENDPOINT}/нет-такого/abort`,
    });

    expect(response.statusCode).toBe(404);
  });

  it('409: завершённый прогон останавливать нечего', async () => {
    const db = createDb(':memory:');
    const app = makeApp(
      db,
      fakeRunner((_prompt, options) => {
        writeFileSync(retroReportPath(String(options.sessionId)), '# Отчёт');
        return okResult();
      }),
    );

    const created = await app.inject({ method: 'POST', url: ENDPOINT });
    const id = (created.json() as { id: string }).id;
    expect(await waitForTerminal(db, id)).toBe('success');

    const response = await app.inject({
      method: 'POST',
      url: `${ENDPOINT}/${id}/abort`,
    });

    expect(response.statusCode).toBe(409);
  });
});

/** Registers itself in the session registry and waits until aborted. */
function hangingRunner(): PiRunner {
  return {
    async run(_containerName, _prompt, options = {}) {
      return new Promise<StepExecutionResult>((resolve) => {
        const stepRunId = String(options.stepRunId);
        options.registry?.register(stepRunId, stepRunId, {
          steer: () => {},
          abort: () => {
            resolve({ ...okResult(), exitCode: 1, aborted: true });
          },
          respond: () => {},
          prompt: async () => ({ ok: true, disposition: 'started' }),
          send: async () => ({ ok: true }),
        });
      });
    },
  };
}

function createStaleRunningRun(db: Db): string {
  const now = new Date().toISOString();
  const id = '11111111-1111-4111-8111-111111111111';
  db.insert(retroRuns)
    .values({
      id,
      status: 'running',
      model: null,
      report: null,
      error: null,
      created_at: now,
      updated_at: now,
    })
    .run();
  return id;
}