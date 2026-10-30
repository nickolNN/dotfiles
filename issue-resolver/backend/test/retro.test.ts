import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  SSEEvent,
  StepExecutionResult,
} from '@issue-resolver/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { createDb } from '../src/db/client';
import {
  createRetroRun,
  getRetroRunWithLog,
} from '../src/db/retro-runs.repo';
import type { PiRunOptions, PiRunner } from '../src/pi/runner';
import {
  RETRO_SCOPE_ID,
  abortRetroRun,
  renderRetroPrompt,
  retroPromptValues,
  retroReportPath,
  runRetroSession,
} from '../src/retro/service';
import { InMemoryStepSessionRegistry } from '../src/pi/session-registry';
import type { SseHub } from '../src/sse/hub';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ir-retro-'));
  roots.push(dir);
  return dir;
}

class RecordingSseHub implements SseHub {
  readonly events: SSEEvent[] = [];

  publish(event: SSEEvent): void {
    this.events.push(event);
  }

  subscribe(): () => void {
    return () => {};
  }

  subscribeByIssue(): () => void {
    return () => {};
  }

  subscribeGlobal(): () => void {
    return () => {};
  }
}

interface RunnerCall {
  containerName: string;
  prompt: string;
  options: PiRunOptions;
}

function fakeRunner(
  behaviour: (
    prompt: string,
    options: PiRunOptions,
  ) => StepExecutionResult | Promise<StepExecutionResult>,
): { runner: PiRunner; calls: RunnerCall[] } {
  const calls: RunnerCall[] = [];
  const runner: PiRunner = {
    async run(containerName, prompt, options = {}) {
      calls.push({ containerName, prompt, options });
      return behaviour(prompt, options);
    },
  };
  return { runner, calls };
}

function okResult(): StepExecutionResult {
  return {
    step: 'resolve',
    exitCode: 0,
    report: null,
    stdout: '',
    stderr: '',
  };
}

function promptFile(dir: string, text = '{{REPORT_FILE}}'): string {
  const path = join(dir, 'retro.md');
  writeFileSync(path, text);
  return path;
}

function depsFor(
  db: ReturnType<typeof createDb>,
  dir: string,
  runner: PiRunner,
  sse?: SseHub,
) {
  return {
    db,
    pi: runner,
    ...(sse ? { sse } : {}),
    repoRoot: dir,
    promptPath: promptFile(dir),
    memoryDir: join(dir, 'memory'),
    sessionsDir: join(dir, 'sessions'),
    dbPath: join(dir, 'app.db'),
    retroSkillPath: join(dir, 'retro', 'SKILL.md'),
    writingSkillPath: join(dir, 'writing', 'SKILL.md'),
    timeoutMs: 5_000,
  };
}

describe('renderRetroPrompt — подстановки', () => {
  it('заменяет все плейсхолдеры промпта', () => {
    const values = {
      REPO_DIR: '/repo',
      MEMORY_DIR: '/memory',
      SESSIONS_DIR: '/sessions',
      DB_PATH: '/db.sqlite',
      RETRO_SKILL: '/skills/retro/SKILL.md',
      WRITING_SKILL: '/skills/writing/SKILL.md',
      REPORT_FILE: '/tmp/report.md',
      DATE: '2026-10-30',
      SESSION_LIMIT: '7',
      EXTRA_INSTRUCTIONS: '',
    };

    expect(
      renderRetroPrompt(
        '{{REPO_DIR}} {{MEMORY_DIR}} {{SESSIONS_DIR}} {{DB_PATH}} {{RETRO_SKILL}} {{WRITING_SKILL}} {{REPORT_FILE}} {{DATE}} {{SESSION_LIMIT}}',
        values,
      ),
    ).toBe(
      '/repo /memory /sessions /db.sqlite /skills/retro/SKILL.md /skills/writing/SKILL.md /tmp/report.md 2026-10-30 7',
    );
  });

  it('без инструкций оператора секции нет, с инструкциями — есть', () => {
    const dir = tempDir();
    const base = depsFor(createDb(':memory:'), dir, fakeRunner(okResult).runner);

    const without = retroPromptValues(base, '/tmp/r.md');
    expect(renderRetroPrompt('{{EXTRA_INSTRUCTIONS}}', without)).toBe('');

    const withText = retroPromptValues(
      { ...base, extraInstructions: '  сделай упор на nav  ' },
      '/tmp/r.md',
    );
    const rendered = renderRetroPrompt('{{EXTRA_INSTRUCTIONS}}', withText);
    expect(rendered).toContain('## Extra instructions from the operator');
    expect(rendered).toContain('сделай упор на nav');
  });
});

describe('runRetroSession — один maintenance-прогон', () => {
  it('пишет отчёт, события и статусы в базу, SSE идёт в scope настроек', async () => {
    const db = createDb(':memory:');
    const dir = tempDir();
    const run = createRetroRun(db, { model: 'qwen-test' });
    const sse = new RecordingSseHub();
    const { runner, calls } = fakeRunner((_prompt, options) => {
      options.onStdout?.('stdout line\n');
      options.onStderr?.('stderr line\n');
      options.onEvent?.({ type: 'text', text: 'думаю' });
      writeFileSync(retroReportPath(run.id), '# Отчёт\n');
      return okResult();
    });

    const result = await runRetroSession(
      depsFor(db, dir, runner, sse),
      run.id,
    );

    expect(result.status).toBe('success');
    expect(result.report).toBe('# Отчёт');
    expect(result.error).toBeNull();

    const stored = getRetroRunWithLog(db, run.id);
    expect(stored?.model).toBe('qwen-test');
    expect(stored?.status).toBe('success');
    expect(stored?.stdout).toContain('stdout line');
    expect(stored?.stderr).toContain('stderr line');
    expect(stored?.events.map((event) => event.type)).toContain('text');

    expect(calls[0]?.options.model).toBe('qwen-test');
    expect(calls[0]?.options.cwd).toBe(dir);
    expect(calls[0]?.options.sessionDir).toBe(join(dir, 'sessions', 'retro'));

    const scopeIds = new Set(sse.events.map((event) => event.issueId));
    expect([...scopeIds]).toEqual([RETRO_SCOPE_ID]);
    expect(
      sse.events.every((event) => event.stepRunId === run.id),
    ).toBe(true);
    const statuses = sse.events
      .filter((event) => event.type === 'step_status')
      .map((event) => JSON.parse(event.data).status);
    expect(statuses).toEqual(['running', 'success']);
    expect(
      sse.events.some(
        (event) => event.type === 'log' && event.data === 'stdout line\n',
      ),
    ).toBe(true);
  });

  it('без файла отчёта помечает прогон failed и объясняет причину', async () => {
    const db = createDb(':memory:');
    const dir = tempDir();
    const run = createRetroRun(db);
    const { runner } = fakeRunner(() => okResult());

    const result = await runRetroSession(depsFor(db, dir, runner), run.id);

    expect(result.status).toBe('failed');
    expect(result.error).toContain('без отчёта');
    expect(getRetroRunWithLog(db, run.id)?.status).toBe('failed');
  });

  it('ненулевой код выхода помечает прогон failed и цитирует stderr', async () => {
    const db = createDb(':memory:');
    const dir = tempDir();
    const run = createRetroRun(db);
    const { runner } = fakeRunner(() => ({
      ...okResult(),
      exitCode: 2,
      stderr: 'boom',
    }));

    const result = await runRetroSession(depsFor(db, dir, runner), run.id);

    expect(result.status).toBe('failed');
    expect(result.error).toContain('кодом 2');
    expect(result.error).toContain('boom');
  });

  it('исключение в раннере не оставляет прогон в running', async () => {
    const db = createDb(':memory:');
    const dir = tempDir();
    const run = createRetroRun(db);
    const { runner } = fakeRunner(() => {
      throw new Error('раннер упал');
    });

    const result = await runRetroSession(depsFor(db, dir, runner), run.id);

    expect(result.status).toBe('failed');
    expect(result.error).toBe('раннер упал');
  });

  it('отчёт из прошлого прогона не подхватывается как новый', async () => {
    const db = createDb(':memory:');
    const dir = tempDir();
    const run = createRetroRun(db);
    writeFileSync(retroReportPath(run.id), 'старый отчёт');
    const { runner } = fakeRunner(() => okResult());

    const result = await runRetroSession(depsFor(db, dir, runner), run.id);

    expect(result.status).toBe('failed');
    expect(result.error).toContain('без отчёта');
  });

  it('сохранённые параметры прогона возвращаются в промпт и в раннер', async () => {
    const db = createDb(':memory:');
    const dir = tempDir();
    const run = createRetroRun(db, {
      model: 'stored-model',
      instructions: 'смотри на ревью',
      sessionLimit: 4,
      thinkingLevel: 'max',
    });
    const { runner, calls } = fakeRunner((_prompt, options) => {
      writeFileSync(retroReportPath(String(options.sessionId)), '# Отчёт');
      return okResult();
    });

    await runRetroSession(
      {
        ...depsFor(db, dir, runner),
        promptPath: promptFile(
          dir,
          '{{EXTRA_INSTRUCTIONS}}limit={{SESSION_LIMIT}}',
        ),
      },
      run.id,
    );

    expect(calls[0]?.options.model).toBe('stored-model');
    expect(calls[0]?.options.thinkingLevel).toBe('max');
    expect(calls[0]?.prompt).toContain('смотри на ревью');
    expect(calls[0]?.prompt).toContain('limit=4');
  });

  it('остановка оператором помечает прогон failed и объясняет причину', async () => {
    const db = createDb(':memory:');
    const dir = tempDir();
    const run = createRetroRun(db);
    const { runner } = fakeRunner(() => ({
      ...okResult(),
      exitCode: 1,
      aborted: true,
    }));

    const result = await runRetroSession(depsFor(db, dir, runner), run.id);

    expect(result.status).toBe('failed');
    expect(result.error).toBe('прогон остановлен оператором');
  });
});

describe('abortRetroRun', () => {
  it('нет такого прогона — not_running', () => {
    const db = createDb(':memory:');
    const dir = tempDir();
    const deps = depsFor(db, dir, fakeRunner(okResult).runner);

    expect(abortRetroRun(deps, 'нет-такого')).toBe('not_running');
  });

  it('идущий прогон останавливается через реестр сессий', async () => {
    const db = createDb(':memory:');
    const dir = tempDir();
    const registry = new InMemoryStepSessionRegistry();
    const run = createRetroRun(db);
    let aborts = 0;
    let registered: () => void = () => {};
    const ready = new Promise<void>((resolve) => {
      registered = resolve;
    });
    const { runner } = fakeRunner(
      (_prompt, options) =>
        new Promise<StepExecutionResult>((resolve) => {
          const stepRunId = String(options.stepRunId);
          options.registry?.register(stepRunId, stepRunId, {
            steer: () => {},
            abort: () => {
              aborts += 1;
              resolve({ ...okResult(), exitCode: 1, aborted: true });
            },
            respond: () => {},
            prompt: async () => ({ ok: true, disposition: 'started' }),
            send: async () => ({ ok: true }),
          });
          registered();
        }),
    );
    const deps = { ...depsFor(db, dir, runner), registry };

    const pending = runRetroSession(deps, run.id);
    await ready;

    expect(abortRetroRun(deps, run.id)).toBe('aborted');
    const result = await pending;

    expect(aborts).toBe(1);
    expect(result.status).toBe('failed');
    expect(result.error).toBe('прогон остановлен оператором');
  });

  it('без реестра идущий прогон не остановить — unavailable', async () => {
    const db = createDb(':memory:');
    const dir = tempDir();
    const run = createRetroRun(db);
    let registered: () => void = () => {};
    const ready = new Promise<void>((resolve) => {
      registered = resolve;
    });
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { runner } = fakeRunner(async (_prompt, options) => {
      registered();
      await gate;
      writeFileSync(retroReportPath(String(options.sessionId)), '# Отчёт');
      return okResult();
    });
    const deps = depsFor(db, dir, runner);

    const pending = runRetroSession(deps, run.id);
    await ready;

    expect(abortRetroRun(deps, run.id)).toBe('unavailable');
    release();
    expect((await pending).status).toBe('success');
  });
});