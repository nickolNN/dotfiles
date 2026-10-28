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
  DEFAULT_DEVOPS_TIMEOUT_MS,
  DEFAULT_RESOLVE_AGENT_TIMEOUT_MS,
  DEVOPS_TIMEOUT_ENV,
  LEGACY_DEVOPS_TIMEOUT_ENV,
  MIN_RESOLVE_AGENT_TIMEOUT_MS,
  resolveAgentTimeoutMs,
  resolveDevOpsTimeoutMs,
} from '../src/workflow/timeout';

const NOW = '2026-01-01T00:00:00.000Z';

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
    issueId?: string;
    iterationId: string | null;
    step: PipelineStep;
    attempt: number;
    context: string;
  }): Promise<StepRun> {
    const run: StepRun = {
      id: `run-${++this.seq}`,
      issue_id: input.issueId ?? 'issue-1',
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
    workspaceRoot: `/tmp/issue-resolver-timeout-test-${process.pid}`,
  };
  return { deps, store };
};

const makeInput = (
  steps: PipelineStep[],
  agentTimeoutMs?: number,
  agentStallTimeoutMs?: number,
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
  ...(agentStallTimeoutMs !== undefined ? { agentStallTimeoutMs } : {}),
});

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

describe('resolveDevOpsTimeoutMs — env-таймаут подготовки', () => {
  it('пустой/битый env → дефолт 90 минут', () => {
    expect(resolveDevOpsTimeoutMs(undefined)).toBe(
      DEFAULT_DEVOPS_TIMEOUT_MS,
    );
    expect(resolveDevOpsTimeoutMs('')).toBe(
      DEFAULT_DEVOPS_TIMEOUT_MS,
    );
    expect(resolveDevOpsTimeoutMs('abc')).toBe(
      DEFAULT_DEVOPS_TIMEOUT_MS,
    );
    expect(resolveDevOpsTimeoutMs('-5')).toBe(
      DEFAULT_DEVOPS_TIMEOUT_MS,
    );
  });

  it('env меньше 60с поднимается до минимума, больше — как есть', () => {
    expect(resolveDevOpsTimeoutMs('5000')).toBe(
      MIN_RESOLVE_AGENT_TIMEOUT_MS,
    );
    expect(resolveDevOpsTimeoutMs('120000')).toBe(120_000);
  });

  it('фолбэк на прежнее имя env при отсутствии нового', () => {
    const prevNew = process.env[DEVOPS_TIMEOUT_ENV];
    const prevLegacy = process.env[LEGACY_DEVOPS_TIMEOUT_ENV];
    delete process.env[DEVOPS_TIMEOUT_ENV];
    delete process.env[LEGACY_DEVOPS_TIMEOUT_ENV];
    try {
      process.env[LEGACY_DEVOPS_TIMEOUT_ENV] = '120000';
      expect(resolveDevOpsTimeoutMs()).toBe(120_000);
      process.env[DEVOPS_TIMEOUT_ENV] = '180000';
      expect(resolveDevOpsTimeoutMs()).toBe(180_000);
    } finally {
      if (prevNew === undefined) delete process.env[DEVOPS_TIMEOUT_ENV];
      else process.env[DEVOPS_TIMEOUT_ENV] = prevNew;
      if (prevLegacy === undefined) delete process.env[LEGACY_DEVOPS_TIMEOUT_ENV];
      else process.env[LEGACY_DEVOPS_TIMEOUT_ENV] = prevLegacy;
    }
  });
});

describe('runIteration — падение/зависание pi-агента завершает resolve терминально', () => {
  it('single: зависание (never-resolving) катится до таймаута → 4 попытки, все failed', async () => {
    const { deps, store } = makeDeps();
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
    expect(output.stderr).toMatch(/timed out|unexpected pi call/);

    expect(pi.calls[0].options?.timeoutMs).toBe(25);
  });

  it('room: reject pi.run у исполнителя → 4 resolve попытки, все failed, координатор не решает', async () => {
    const { deps, store } = makeDeps();
    const pi = new ScriptedPiRunner([
      () => Promise.resolve(refineResolve(roomPlan)),
      () => Promise.reject(new Error('spawn pi ENOENT')),
      () => Promise.resolve(passResolve('worker1')),
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

    const output = resolveOutput(store);
    expect(JSON.parse(output.report)).toEqual({
      status: 'fail',
      summary: 'resolve agent failed/hung',
    });
    expect(output.stderr).toMatch(/spawn pi ENOENT|unexpected pi call/);
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
    expect(resolveOutput(store).stderr).toMatch(/child error|unexpected pi call/);
  });

  it('room: зависание исполнителей катится до таймаута → 4 resolve попытки', async () => {
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
    expect(pi.calls[1].options?.stepRunId).toContain('.s1.w0');
  });

  it('single: молчащее зависание → сторож тишины снимает прогон, не дожидаясь 3ч', async () => {
    const { deps, store } = makeDeps();
    deps.pi = new ScriptedPiRunner([hang]);

    const result = await runIteration(
      deps,
      makeInput(['resolve'], DEFAULT_RESOLVE_AGENT_TIMEOUT_MS, 30),
    );

    expect(result).toEqual({ iterationStatus: 'failed', needsInput: false });
    expect(trace(store)[0]).toBe('resolve#1:failed');
    expect(store.outputs[0].stderr).toMatch(/stalled: no output for 30ms/);
  });

  it('single: тишина → сначала follow-up nudge и compact, потом abort', async () => {
    const { deps, store } = makeDeps();
    const seen: string[] = [];
    deps.pi = {
      run: (_container, _prompt, options) => {
        options?.registry?.register(
          options.stepRunId!,
          options.iterationId!,
          {
            steer: () => seen.push('steer'),
            abort: () => seen.push('abort'),
            respond: () => {},
            prompt: async (_message, mode) => {
              seen.push(`prompt:${mode ?? 'plain'}`);
              return { ok: true } as never;
            },
            send: async (command) => {
              seen.push(`send:${String(command.type)}`);
              return { ok: true } as never;
            },
          },
        );
        return hang();
      },
    };

    const result = await runIteration(
      deps,
      makeInput(['resolve'], DEFAULT_RESOLVE_AGENT_TIMEOUT_MS, 30),
    );

    expect(result).toEqual({ iterationStatus: 'failed', needsInput: false });
    expect(seen.slice(0, 4)).toEqual([
      'prompt:followUp',
      'send:compact',
      'send:abort_retry',
      'abort',
    ]);
    expect(seen.filter((entry) => entry === 'send:abort_retry')).toHaveLength(4);
    expect(store.outputs[0].stderr).toMatch(/tried: nudge, compact/);
  });

  it('single: поток вывода дольше «тишины» → сторож не срабатывает', async () => {
    const { deps, store } = makeDeps();
    deps.pi = new ScriptedPiRunner([
      (call) =>
        new Promise<StepExecutionResult>((resolve) => {
          let ticks = 0;
          const timer = setInterval(() => {
            ticks += 1;
            call.options?.onStdout?.(`chunk ${ticks}`);
            if (ticks < 6) return;
            clearInterval(timer);
            resolve(passResolve('живой агент'));
          }, 15);
        }),
    ]);

    const result = await runIteration(deps, makeInput(['resolve'], 60_000, 60));

    expect(result).toEqual({ iterationStatus: 'completed', needsInput: false });
    expect(trace(store)).toEqual(['resolve#1:success']);
  });
});