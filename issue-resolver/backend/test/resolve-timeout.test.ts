/**
 * Регрессия «resolve не висит вечно и не даёт пустой результат».
 *
 * Падение (spawn ENOENT, child error) или зависание pi-агента обязано
 * завершать шаг терминально `failed`, а итерацию — `failed`, а не оставлять
 * их в `running` навсегда. Таймаут прокидывается в раннер и дополнительно
 * страхуется внешним `withAgentTimeout` (см. workflow/timeout.ts).
 *
 * Здесь проверяются все три ветки движка:
 *  - single  → `deps.pi.run`;
 *  - room    → `runRoomResolve` (воркер/координатор, параллельно);
 *  - stages  → `runStagedResolve` (агент этапа).
 */
import { describe, expect, it } from 'vitest';
import type {
  ExecutionPlan,
  Iteration,
  PipelineStep,
  SessionEvent,
  SessionStats,
  StepExecutionResult,
  StepOutput,
  StepRun,
  StepRunStatus,
} from '@issue-resolver/shared';
import { FakeContainerController } from '../src/docker/controller';
import { FakeGitService } from '../src/git/service';
import type { PiRunCall, PiRunOptions, PiRunner } from '../src/pi/runner';
import { InMemoryStepSessionRegistry } from '../src/pi/session-registry';
import { FakeMrClient } from '../src/pr/mr';
import { InMemorySseHub } from '../src/sse/hub';
import type {
  RunIterationInput,
  StepRunStore,
  WorkflowDeps,
} from '../src/workflow/engine';
import { runIteration } from '../src/workflow/engine';
import {
  DEFAULT_BOOTSTRAPPER_TIMEOUT_MS,
  DEFAULT_RESOLVE_AGENT_TIMEOUT_MS,
  MIN_RESOLVE_AGENT_TIMEOUT_MS,
  resolveAgentTimeoutMs,
  resolveBootstrapperTimeoutMs,
} from '../src/workflow/timeout';

const NOW = '2026-01-01T00:00:00.000Z';

/** In-memory-реализация StepRunStore (как в workflow-engine.test.ts). */
class InMemoryStepRunStore implements StepRunStore {
  readonly runs: StepRun[] = [];
  readonly outputs: StepOutput[] = [];
  readonly persistedEvents = new Map<string, SessionEvent[]>();
  private seq = 0;

  async appendStepRunEvent(id: string, event: SessionEvent): Promise<void> {
    const events = this.persistedEvents.get(id) ?? [];
    events.push(event);
    this.persistedEvents.set(id, events);
  }

  async createStepRun(input: {
    iterationId: string;
    step: PipelineStep;
    attempt: number;
    context: string;
  }): Promise<StepRun> {
    const run: StepRun = {
      id: `run-${++this.seq}`,
      iteration_id: input.iterationId,
      step: input.step,
      attempt: input.attempt,
      status: 'pending',
      context: input.context,
      feedback: null,
      created_at: NOW,
      updated_at: NOW,
    };
    this.runs.push(run);
    return run;
  }

  async updateStepRun(
    id: string,
    patch: { status?: StepRunStatus; feedback?: string | null },
  ): Promise<StepRun> {
    const run = this.runs.find((candidate) => candidate.id === id);
    if (!run) throw new Error(`step run not found: ${id}`);
    if (patch.status !== undefined) run.status = patch.status;
    run.updated_at = NOW;
    return run;
  }

  async createStepOutput(input: {
    stepRunId: string;
    report: string;
    screenshotsDir?: string;
    stdout?: string;
    stderr?: string;
    events?: SessionEvent[];
    stats?: SessionStats | null;
  }): Promise<StepOutput> {
    const output: StepOutput = {
      id: `out-${++this.seq}`,
      step_run_id: input.stepRunId,
      report: input.report,
      screenshots_dir: input.screenshotsDir ?? null,
      stdout: input.stdout ?? '',
      stderr: input.stderr ?? '',
      events: input.events ?? [],
      stats: input.stats ?? null,
      created_at: NOW,
      updated_at: NOW,
    };
    this.outputs.push(output);
    return output;
  }
}

const makeDeps = () => {
  const store = new InMemoryStepRunStore();
  const deps: WorkflowDeps = {
    container: new FakeContainerController(),
    git: new FakeGitService(),
    pi: { run: () => Promise.reject(new Error('pi not configured')) },
    sse: new InMemorySseHub(),
    store,
    mr: new FakeMrClient(),
    control: new InMemoryStepSessionRegistry(),
    // Несуществующий корень: чтение `.issue-step-result.json` всегда null,
    // тесты не зависят от реальной ФС.
    workspaceRoot: `/tmp/issue-resolver-timeout-test-${process.pid}`,
  };
  return { deps, store };
};

const makeInput = (
  steps: PipelineStep[],
  agentTimeoutMs?: number,
): RunIterationInput => ({
  issue: {
    id: 'issue-timeout-1',
    title: 'Fix bug',
    pipelineSteps: steps,
    desiredResult: 'md',
  },
  iteration: {
    id: 'iter-1',
    issue_id: 'issue-timeout-1',
    number: 1,
    context: 'context text',
    review_context: '',
    is_review_need: false,
    steps,
    status: 'running',
    created_at: NOW,
    updated_at: NOW,
  } satisfies Iteration,
  repositories: [
    { repository_url: 'https://example.com/a.git', base_branch: 'main' },
  ],
  ...(agentTimeoutMs !== undefined ? { agentTimeoutMs } : {}),
});

/** Скриптованный PiRunner: по одному handler'у на вызов; умеет reject/hang. */
type Handler = (call: PiRunCall) => Promise<StepExecutionResult>;

class ScriptedPiRunner implements PiRunner {
  readonly calls: PiRunCall[] = [];

  constructor(private readonly handlers: Handler[]) {}

  run(
    containerName: string,
    prompt: string,
    options?: PiRunOptions,
  ): Promise<StepExecutionResult> {
    const call: PiRunCall = { containerName, prompt, options };
    this.calls.push(call);
    const handler = this.handlers[this.calls.length - 1];
    if (!handler) {
      return Promise.reject(
        new Error(`unexpected pi call #${this.calls.length}`),
      );
    }
    return handler(call);
  }
}

const refineResolve = (execution: ExecutionPlan): StepExecutionResult => ({
  step: 'refine',
  exitCode: 0,
  report: { status: 'pass', summary: 'plan', execution },
  stdout: '',
  stderr: '',
});

const passResolve = (summary: string): StepExecutionResult => ({
  step: 'resolve',
  exitCode: 0,
  report: { status: 'pass', summary },
  stdout: '',
  stderr: '',
});

const hang = (): Promise<StepExecutionResult> => new Promise(() => {});

const roomPlan: ExecutionPlan = {
  mode: 'room',
  executors: 2,
  decomposition: ['a', 'b'],
};

const stagesPlan: ExecutionPlan = {
  mode: 'stages',
  stages: [
    { index: 1, name: 'Дизайн', task: 't1', executors: 1 },
    { index: 2, name: 'Реализация', task: 't2', executors: 1 },
  ],
};

const trace = (store: InMemoryStepRunStore): string[] =>
  store.runs.map((run) => `${run.step}#${run.attempt}:${run.status}`);

const resolveOutput = (store: InMemoryStepRunStore): StepOutput => {
  // С self-retry может быть несколько resolve-прогонов — берём последний
  // (в нём финальная ошибка).
  const resolveRuns = store.runs.filter((run) => run.step === 'resolve');
  const resolveRun = resolveRuns[resolveRuns.length - 1];
  const output = store.outputs.find(
    (candidate) => candidate.step_run_id === resolveRun?.id,
  );
  if (!output) throw new Error('resolve step output not found');
  return output;
};

describe('resolveAgentTimeoutMs — env-таймаут', () => {
  it('пустой/битый env → дефолт 90 минут', () => {
    expect(resolveAgentTimeoutMs(undefined)).toBe(
      DEFAULT_RESOLVE_AGENT_TIMEOUT_MS,
    );
    expect(resolveAgentTimeoutMs('')).toBe(DEFAULT_RESOLVE_AGENT_TIMEOUT_MS);
    expect(resolveAgentTimeoutMs('abc')).toBe(DEFAULT_RESOLVE_AGENT_TIMEOUT_MS);
    expect(resolveAgentTimeoutMs('-5')).toBe(DEFAULT_RESOLVE_AGENT_TIMEOUT_MS);
    expect(resolveAgentTimeoutMs('0')).toBe(DEFAULT_RESOLVE_AGENT_TIMEOUT_MS);
  });

  it('env меньше 60с поднимается до минимума', () => {
    expect(resolveAgentTimeoutMs('5000')).toBe(MIN_RESOLVE_AGENT_TIMEOUT_MS);
    expect(resolveAgentTimeoutMs('59999')).toBe(MIN_RESOLVE_AGENT_TIMEOUT_MS);
  });

  it('env больше минимума используется как есть', () => {
    expect(resolveAgentTimeoutMs('120000')).toBe(120_000);
  });
});

describe('resolveBootstrapperTimeoutMs — env-таймаут подготовки', () => {
  it('пустой/битый env → дефолт 90 минут', () => {
    expect(resolveBootstrapperTimeoutMs(undefined)).toBe(
      DEFAULT_BOOTSTRAPPER_TIMEOUT_MS,
    );
    expect(resolveBootstrapperTimeoutMs('')).toBe(
      DEFAULT_BOOTSTRAPPER_TIMEOUT_MS,
    );
    expect(resolveBootstrapperTimeoutMs('abc')).toBe(
      DEFAULT_BOOTSTRAPPER_TIMEOUT_MS,
    );
    expect(resolveBootstrapperTimeoutMs('-5')).toBe(
      DEFAULT_BOOTSTRAPPER_TIMEOUT_MS,
    );
  });

  it('env меньше 60с поднимается до минимума, больше — как есть', () => {
    expect(resolveBootstrapperTimeoutMs('5000')).toBe(
      MIN_RESOLVE_AGENT_TIMEOUT_MS,
    );
    expect(resolveBootstrapperTimeoutMs('120000')).toBe(120_000);
  });
});

describe('runIteration — падение/зависание pi-агента завершает resolve терминально', () => {
  it('single: зависание (never-resolving) катится до таймаута → 4 попытки, все failed', async () => {
    const { deps, store } = makeDeps();
    // hang + 3 reject (no handler) = 4 попытки (1 осн + 3 self-retry).
    const pi = new ScriptedPiRunner([hang]);
    deps.pi = pi;

    const result = await runIteration(deps, makeInput(['resolve'], 25));

    expect(result).toEqual({ iterationStatus: 'failed', needsInput: false });
    expect(trace(store)).toEqual([
      'resolve#1:failed',
      'resolve#2:failed',
      'resolve#3:failed',
      'resolve#4:failed',
    ]);

    const output = resolveOutput(store);
    expect(JSON.parse(output.report)).toEqual({
      status: 'fail',
      summary: 'resolve agent failed/hung',
    });
    // Первая попытка — таймаут, последующие — no handler.
    expect(output.stderr).toMatch(/timed out|unexpected pi call/);

    // Таймаут прокинут в раннер (RpcPiRunner → reject + SIGKILL).
    expect(pi.calls[0].options?.timeoutMs).toBe(25);
  });

  it('room: reject pi.run у воркера → 4 resolve попытки, все failed, координатор не решает', async () => {
    const { deps, store } = makeDeps();
    const pi = new ScriptedPiRunner([
      () => Promise.resolve(refineResolve(roomPlan)),
      () => Promise.reject(new Error('spawn pi ENOENT')),
      () => Promise.resolve(passResolve('worker1')),
    ]);
    deps.pi = pi;

    const result = await runIteration(deps, makeInput(['refine', 'resolve']));

    expect(result).toEqual({ iterationStatus: 'failed', needsInput: false });
    // refine успешен, resolve — 4 попытки (1 осн + 3 self-retry), все failed.
    expect(trace(store)).toEqual([
      'refine#1:success',
      'resolve#1:failed',
      'resolve#2:failed',
      'resolve#3:failed',
      'resolve#4:failed',
    ]);

    const output = resolveOutput(store);
    expect(JSON.parse(output.report)).toEqual({
      status: 'fail',
      summary: 'resolve agent failed/hung',
    });
    expect(output.stderr).toMatch(/spawn pi ENOENT|unexpected pi call/);
    // Первая попытка: refine(1) + worker0(1) + worker1(1) = 3 вызова.
    expect(pi.calls.length).toBeGreaterThanOrEqual(3);
  });

  it('room: reject pi.run у координатора → 4 resolve попытки, все failed', async () => {
    const { deps, store } = makeDeps();
    const pi = new ScriptedPiRunner([
      () => Promise.resolve(refineResolve(roomPlan)),
      () => Promise.resolve(passResolve('worker0')),
      () => Promise.resolve(passResolve('worker1')),
      () => Promise.reject(new Error('child error')),
    ]);
    deps.pi = pi;

    const result = await runIteration(deps, makeInput(['refine', 'resolve']));

    expect(result).toEqual({ iterationStatus: 'failed', needsInput: false });
    expect(trace(store)).toEqual([
      'refine#1:success',
      'resolve#1:failed',
      'resolve#2:failed',
      'resolve#3:failed',
      'resolve#4:failed',
    ]);
    // Финальный output содержит ошибку координатора или no-handler.
    expect(resolveOutput(store).stderr).toMatch(/child error|unexpected pi call/);
  });

  it('room: зависание воркеров катится до таймаута → 4 resolve попытки', async () => {
    const { deps, store } = makeDeps();
    const pi = new ScriptedPiRunner([
      () => Promise.resolve(refineResolve(roomPlan)),
      hang,
      hang,
    ]);
    deps.pi = pi;

    const result = await runIteration(deps, makeInput(['refine', 'resolve'], 20));

    expect(result).toEqual({ iterationStatus: 'failed', needsInput: false });
    expect(trace(store)).toEqual([
      'refine#1:success',
      'resolve#1:failed',
      'resolve#2:failed',
      'resolve#3:failed',
      'resolve#4:failed',
    ]);
    // Первая попытка — таймаут, последующие — no handler.
    expect(resolveOutput(store).stderr).toMatch(/timed out|unexpected pi call/);
    expect(pi.calls[1].options?.timeoutMs).toBe(20);
  });

  it('stages: зависание агента этапа катится до таймаута → 4 resolve попытки', async () => {
    const { deps, store } = makeDeps();
    const pi = new ScriptedPiRunner([
      () => Promise.resolve(refineResolve(stagesPlan)),
      hang,
    ]);
    deps.pi = pi;

    const result = await runIteration(deps, makeInput(['refine', 'resolve'], 20));

    expect(result).toEqual({ iterationStatus: 'failed', needsInput: false });
    expect(trace(store)).toEqual([
      'refine#1:success',
      'resolve#1:failed',
      'resolve#2:failed',
      'resolve#3:failed',
      'resolve#4:failed',
    ]);
    expect(resolveOutput(store).stderr).toMatch(/timed out|unexpected pi call/);
    expect(pi.calls[1].options?.stepRunId).toContain('/stage/1/coordinator');
  });
});