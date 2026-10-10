import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type {
  Iteration,
  PipelineStep,
  SessionEvent,
  SessionStats,
  SSEEvent,
  StepExecutionResult,
  StepOutput,
  StepRun,
  StepRunStatus,
} from '@issue-resolver/shared';
import { FakeContainerController } from '../src/docker/controller';
import { FakeGitService } from '../src/git/service';
import { FakePiRunner } from '../src/pi/runner';
import { InMemoryStepSessionRegistry } from '../src/pi/session-registry';
import { FakeMrClient } from '../src/pr/mr';
import { InMemorySseHub } from '../src/sse/hub';
import type {
  RunIterationInput,
  StepRunStore,
  WorkflowDeps,
} from '../src/workflow/engine';
import { runIteration } from '../src/workflow/engine';

const NOW = '2026-01-01T00:00:00.000Z';

/** In-memory-реализация StepRunStore для тестов движка. */
class InMemoryStepRunStore implements StepRunStore {
  readonly runs: StepRun[] = [];
  readonly outputs: StepOutput[] = [];
  private seq = 0;

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
    if ('feedback' in patch) run.feedback = patch.feedback ?? null;
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
  const container = new FakeContainerController();
  const git = new FakeGitService();
  const pi = new FakePiRunner();
  const sse = new InMemorySseHub();
  const store = new InMemoryStepRunStore();
  const mr = new FakeMrClient();
  const control = new InMemoryStepSessionRegistry();
  const deps: WorkflowDeps = { container, git, pi, sse, store, mr, control };
  return { deps, container, git, pi, sse, store, mr, control };
};

const makeInput = (
  steps: PipelineStep[],
  model?: string,
  desiredResult?: 'html' | 'pr',
): RunIterationInput => ({
  issue: {
    id: 'issue-1',
    title: 'Fix bug',
    pipelineSteps: steps,
    desiredResult,
  },
  iteration: {
    id: 'iter-1',
    issue_id: 'issue-1',
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
  model,
});

const noReport = (
  step: PipelineStep,
  exitCode = 0,
): StepExecutionResult => ({
  step,
  exitCode,
  report: null,
  stdout: `${step} out`,
  stderr: '',
});

const pass = (step: PipelineStep): StepExecutionResult => ({
  step,
  exitCode: 0,
  report: { status: 'pass', summary: `${step} ok` },
  stdout: `${step} out`,
  stderr: '',
});

const fail = (step: PipelineStep): StepExecutionResult => ({
  step,
  exitCode: 1,
  report: { status: 'fail', summary: `${step} no` },
  stdout: '',
  stderr: `${step} err`,
});

const aborted = (step: PipelineStep): StepExecutionResult => ({
  ...fail(step),
  aborted: true,
});

const trace = (store: InMemoryStepRunStore): string[] =>
  store.runs.map((run) => `${run.step}#${run.attempt}:${run.status}`);

describe('runIteration — один шаг', () => {
  it('resolve успех → completed, stepRun success, output создан, SSE-события', async () => {
    const { deps, store, sse, pi, git } = makeDeps();
    pi.enqueue(pass('resolve'));

    const events: SSEEvent[] = [];
    sse.subscribe('iter-1', (event) => events.push(event));

    const result = await runIteration(deps, makeInput(['resolve']));

    expect(result).toEqual({ iterationStatus: 'completed', needsInput: false });
    expect(trace(store)).toEqual(['resolve#1:success']);

    expect(store.outputs).toHaveLength(1);
    expect(store.outputs[0].step_run_id).toBe(store.runs[0].id);
    expect(store.outputs[0].stdout).toBe('resolve out');
    expect(store.outputs[0].stderr).toBe('');
    expect(JSON.parse(store.outputs[0].report)).toEqual({
      status: 'pass',
      summary: 'resolve ok',
    });

    const statuses = events
      .filter((event) => event.type === 'step_status')
      .map((event) => event.data);
    expect(statuses).toContain('running');
    expect(statuses).toContain('success');
    expect(
      events.some((event) => event.type === 'log' && event.stream === 'stdout'),
    ).toBe(true);

    // git.prepare вызван на workspace итерации; контейнер — один на итерацию.
    expect(git.prepares).toHaveLength(1);
    expect(git.prepares[0]).toMatchObject({
      repoUrls: ['https://example.com/a.git'],
      baseBranches: ['main'],
      workspacePath: '/workspaces/issue-1',
    });
    expect(pi.calls[0].containerName).toBe('issue-resolver-issue-1');
  });

  it('статус running пишется в store во время шага (не только в SSE)', async () => {
    const { deps, store } = makeDeps();
    const observed: StepRunStatus[] = [];
    deps.pi = {
      run: async () => {
        observed.push(store.runs[0].status);
        return pass('resolve');
      },
    };

    const result = await runIteration(deps, makeInput(['resolve']));

    // В момент исполнения шага прогон в store — running.
    expect(observed).toEqual(['running']);
    expect(result).toEqual({ iterationStatus: 'completed', needsInput: false });
    // Завершение перезаписывает running финальным статусом.
    expect(trace(store)).toEqual(['resolve#1:success']);
  });

  it('падение шага перезаписывает running на failed', async () => {
    const { deps, store } = makeDeps();
    const observed: StepRunStatus[] = [];
    deps.pi = {
      run: async () => {
        observed.push(store.runs[0].status);
        return fail('resolve');
      },
    };

    await runIteration(deps, makeInput(['resolve']));

    expect(observed).toEqual(['running']);
    expect(trace(store)).toEqual(['resolve#1:failed']);
  });

  it('prompt детерминирован: содержит шаг и контекст итерации', async () => {    const { deps, pi } = makeDeps();
    pi.enqueue(pass('resolve'));

    await runIteration(deps, makeInput(['resolve']));

    expect(pi.calls[0].prompt).toContain('resolve');
    expect(pi.calls[0].prompt).toContain('context text');
  });

  it('previousOutcome пробрасывается в промпт шага', async () => {
    const { deps, pi } = makeDeps();
    pi.enqueue(pass('resolve'));

    await runIteration(deps, {
      ...makeInput(['resolve']),
      previousOutcome: 'Previous iteration #1 (status pass): done.\nResult document:\nX',
    });

    expect(pi.calls[0].prompt).toContain(
      'Previous iteration outcome (build on it, do not redo from scratch):',
    );
    expect(pi.calls[0].prompt).toContain(
      'Previous iteration #1 (status pass): done.',
    );
  });

  it('desiredResult html → resolve prompt содержит report.html', async () => {
    const { deps, pi } = makeDeps();
    pi.enqueue(pass('resolve'));

    await runIteration(deps, makeInput(['resolve'], undefined, 'html'));

    expect(pi.calls[0].prompt).toContain('report.html');
  });

  it('desiredResult pr → resolve prompt без report.html', async () => {
    const { deps, pi } = makeDeps();
    pi.enqueue(pass('resolve'));

    await runIteration(deps, makeInput(['resolve'], undefined, 'pr'));

    expect(pi.calls[0].prompt).not.toContain('report.html');
  });

  it('прокидывает registry/stepRunId/iterationId живого шага в pi.run', async () => {
    const { deps, store, pi } = makeDeps();
    pi.enqueue(pass('resolve'));

    await runIteration(deps, makeInput(['resolve']));

    const options = pi.calls[0].options;
    expect(options?.stepRunId).toBe(store.runs[0].id);
    expect(options?.iterationId).toBe('iter-1');
    expect(options?.registry).toBe(deps.control);
  });

  it('resolve fail → iteration failed без needsInput', async () => {
    const { deps, store, pi } = makeDeps();
    pi.enqueue(fail('resolve'));

    const result = await runIteration(deps, makeInput(['resolve', 'review']));

    expect(result).toEqual({ iterationStatus: 'failed', needsInput: false });
    expect(trace(store)).toEqual(['resolve#1:failed']);
    expect(pi.calls).toHaveLength(1);
  });

  it('stdout/stderr прокидываются в createStepOutput', async () => {
    const { deps, store, pi } = makeDeps();
    pi.enqueue(fail('resolve'));

    await runIteration(deps, makeInput(['resolve']));

    expect(store.outputs).toHaveLength(1);
    expect(store.outputs[0].stdout).toBe('');
    expect(store.outputs[0].stderr).toBe('resolve err');
  });

  it('events прокидываются в createStepOutput и живьём в step_event', async () => {
    const { deps, store, pi } = makeDeps();
    const sessionEvents: SessionEvent[] = [
      { type: 'text', text: 'hi' },
      { type: 'thinking', thinking: 'размышляю над задачей' },
      {
        type: 'tool_use',
        toolCallId: 'c1',
        toolName: 'bash',
        args: { command: 'pwd' },
      },
    ];
    pi.enqueue({
      step: 'resolve',
      exitCode: 0,
      report: { status: 'pass', summary: 'ok' },
      stdout: 'hi',
      stderr: '',
      events: sessionEvents,
    });

    const seen: SSEEvent[] = [];
    deps.sse.subscribe('iter-1', (event) => seen.push(event));

    await runIteration(deps, makeInput(['resolve']));

    expect(store.outputs[0].events).toEqual(sessionEvents);
    const stepEvents = seen.filter((event) => event.type === 'step_event');
    expect(stepEvents).toHaveLength(3);
    expect(stepEvents[0].stepRunId).toBe(store.runs[0].id);
    expect(JSON.parse(stepEvents[0].data)).toEqual({
      stepRunId: store.runs[0].id,
      event: sessionEvents[0],
    });
    // thinking — обычный SessionEvent и течёт тем же step_event-каналом.
    expect(JSON.parse(stepEvents[1].data).event).toEqual({
      type: 'thinking',
      thinking: 'размышляю над задачей',
    });
  });

  it('stats прокидываются в createStepOutput', async () => {
    const { deps, store, pi } = makeDeps();
    const stats: SessionStats = {
      sessionId: 's1',
      userMessages: 1,
      assistantMessages: 1,
      toolCalls: 0,
      toolResults: 0,
      totalMessages: 2,
      tokens: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, total: 3 },
      cost: 0.1,
      contextUsage: { tokens: 5, contextWindow: 100, percent: 5 },
    };
    pi.enqueue({
      step: 'resolve',
      exitCode: 0,
      report: { status: 'pass', summary: 'ok' },
      stdout: '',
      stderr: '',
      stats,
    });

    await runIteration(deps, makeInput(['resolve']));

    expect(store.outputs[0].stats).toEqual(stats);
  });

  it('report blocked + exit 0 → needs_input', async () => {
    const { deps, store, pi } = makeDeps();
    pi.enqueue({
      step: 'resolve',
      exitCode: 0,
      report: { status: 'blocked', summary: 'need input' },
      stdout: '',
      stderr: '',
    });

    const result = await runIteration(deps, makeInput(['resolve']));

    expect(result).toEqual({ iterationStatus: 'failed', needsInput: true });
    expect(trace(store)).toEqual(['resolve#1:needs_input']);
  });
});

describe('runIteration — канонический порядок шагов', () => {
  it('входящий порядок resolve→refine исполняется как refine→resolve', async () => {
    const { deps, store, pi } = makeDeps();
    pi.enqueue(pass('refine'));
    pi.enqueue(pass('resolve'));

    const result = await runIteration(deps, makeInput(['resolve', 'refine']));

    expect(result).toEqual({ iterationStatus: 'completed', needsInput: false });
    expect(trace(store)).toEqual(['refine#1:success', 'resolve#1:success']);
    expect(pi.calls).toHaveLength(2);
  });

  it('дубли шагов схлопываются, порядок остаётся каноническим', async () => {
    const { deps, store, pi } = makeDeps();
    pi.enqueue(pass('resolve'));
    pi.enqueue(pass('review'));

    const result = await runIteration(
      deps,
      makeInput(['review', 'resolve', 'resolve', 'review']),
    );

    expect(result).toEqual({ iterationStatus: 'completed', needsInput: false });
    expect(trace(store)).toEqual(['resolve#1:success', 'review#1:success']);
    expect(pi.calls).toHaveLength(2);
  });
});

describe('runIteration — отчёт из файла .issue-step-result.json', () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  /** Создаёт временный workspaceRoot и, если задан, умеренно пишет файл отчёта. */
  const withWorkspace = async (
    reportContent?: string,
  ): Promise<{ root: string; dir: string }> => {
    const root = await mkdtemp(join(tmpdir(), 'issue-engine-'));
    roots.push(root);
    const dir = join(root, 'issue-1');
    await mkdir(dir, { recursive: true });
    if (reportContent !== undefined) {
      await writeFile(join(dir, '.issue-step-result.json'), reportContent);
    }
    return { root, dir };
  };

  it('нет файла и result.report=null → report хранится пустой строкой, exit0 success', async () => {
    const { deps, store, pi } = makeDeps();
    const { root } = await withWorkspace();
    deps.workspaceRoot = root;
    pi.enqueue(noReport('resolve'));

    const result = await runIteration(deps, makeInput(['resolve']));

    expect(result).toEqual({ iterationStatus: 'completed', needsInput: false });
    expect(trace(store)).toEqual(['resolve#1:success']);
    expect(store.outputs[0].report).toBe('');
  });

  it('файл {status:fail,summary} перекрывает result.report → status failed + report-json', async () => {
    const { deps, store, pi } = makeDeps();
    const { root } = await withWorkspace(
      JSON.stringify({ status: 'fail', summary: 'найдено 3 дефекта' }),
    );
    deps.workspaceRoot = root;
    // result.report — pass, но файл важнее (источник истины в RPC-режиме).
    pi.enqueue(pass('resolve'));

    const result = await runIteration(deps, makeInput(['resolve']));

    expect(result).toEqual({ iterationStatus: 'failed', needsInput: false });
    expect(trace(store)).toEqual(['resolve#1:failed']);
    expect(JSON.parse(store.outputs[0].report)).toEqual({
      status: 'fail',
      summary: 'найдено 3 дефекта',
    });
  });

  it('файл {status:blocked} → needs_input', async () => {
    const { deps, store, pi } = makeDeps();
    const { root } = await withWorkspace(
      JSON.stringify({ status: 'blocked', summary: 'нужен доступ' }),
    );
    deps.workspaceRoot = root;
    pi.enqueue(noReport('resolve'));

    const result = await runIteration(deps, makeInput(['resolve']));

    expect(result).toEqual({ iterationStatus: 'failed', needsInput: true });
    expect(trace(store)).toEqual(['resolve#1:needs_input']);
    expect(JSON.parse(store.outputs[0].report)).toEqual({
      status: 'blocked',
      summary: 'нужен доступ',
    });
  });

  it('битый JSON не роняет прогон: report пустой, exit0 → success', async () => {
    const { deps, store, pi } = makeDeps();
    const { root } = await withWorkspace('{not json');
    deps.workspaceRoot = root;
    pi.enqueue(noReport('resolve'));

    const result = await runIteration(deps, makeInput(['resolve']));

    expect(result).toEqual({ iterationStatus: 'completed', needsInput: false });
    expect(trace(store)).toEqual(['resolve#1:success']);
    expect(store.outputs[0].report).toBe('');
  });
});

describe('runIteration — цикл фидбека', () => {
  it('review fail → откат на resolve#2 → review#2 success → completed', async () => {
    const { deps, store, pi } = makeDeps();
    pi.enqueue(pass('resolve'));
    pi.enqueue(fail('review'));
    pi.enqueue(pass('resolve'));
    pi.enqueue(pass('review'));

    const result = await runIteration(deps, makeInput(['resolve', 'review']));

    expect(result).toEqual({ iterationStatus: 'completed', needsInput: false });
    expect(trace(store)).toEqual([
      'resolve#1:success',
      'review#1:failed',
      'resolve#2:success',
      'review#2:success',
    ]);
  });

  it('review падает 3 раза → needsInput, iteration failed', async () => {
    const { deps, store, pi } = makeDeps();
    pi.enqueue(pass('resolve'));
    pi.enqueue(fail('review'));
    pi.enqueue(pass('resolve'));
    pi.enqueue(fail('review'));
    pi.enqueue(pass('resolve'));
    pi.enqueue(fail('review'));

    const result = await runIteration(deps, makeInput(['resolve', 'review']));

    expect(result).toEqual({ iterationStatus: 'failed', needsInput: true });
    expect(trace(store)).toEqual([
      'resolve#1:success',
      'review#1:failed',
      'resolve#2:success',
      'review#2:failed',
      'resolve#3:success',
      'review#3:failed',
    ]);
    expect(pi.calls).toHaveLength(6);
  });

  it('model пробрасывается в pi.run вместе с cwd воркспейса', async () => {
    const { deps, pi } = makeDeps();
    pi.enqueue(pass('resolve'));

    await runIteration(deps, makeInput(['resolve'], 'gpt-5'));

    expect(pi.calls).toHaveLength(1);
    expect(pi.calls[0].options?.model).toBe('gpt-5');
    expect(pi.calls[0].options?.cwd).toBe('/workspaces/issue-1');
  });
});

describe('runIteration — abort', () => {
  it('abort-результат → шаг aborted, итерация cancelled, без retry и следующих шагов', async () => {
    const { deps, store, pi, sse } = makeDeps();
    pi.enqueue(pass('resolve'));
    pi.enqueue(aborted('review'));

    const events: SSEEvent[] = [];
    sse.subscribe('iter-1', (event) => events.push(event));

    const result = await runIteration(deps, makeInput(['resolve', 'review']));

    // Терминальный abort: ни retry (review#2), ни следующих шагов.
    expect(result).toEqual({ iterationStatus: 'cancelled', needsInput: false });
    expect(trace(store)).toEqual(['resolve#1:success', 'review#1:aborted']);
    expect(pi.calls).toHaveLength(2);
    // Отчёт и output всё равно фиксируются для прерванного шага.
    expect(store.outputs).toHaveLength(2);
    expect(
      events
        .filter((event) => event.type === 'step_status')
        .map((event) => event.data),
    ).toContain('aborted');
  });
});

describe('runIteration — per-step модели', () => {
  it('step_models[step] переопределяет общий model только для своего шага', async () => {
    const { deps, pi } = makeDeps();
    pi.enqueue(pass('resolve'));
    pi.enqueue(pass('review'));

    await runIteration(deps, {
      ...makeInput(['resolve', 'review'], 'fallback-model'),
      step_models: { review: 'review-model' },
    });

    expect(pi.calls.map((call) => call.options?.model)).toEqual([
      'fallback-model',
      'review-model',
    ]);
  });

  it('шаг без step_models берёт общий model (фолбек таска)', async () => {
    const { deps, pi } = makeDeps();
    pi.enqueue(pass('resolve'));

    await runIteration(deps, makeInput(['resolve'], 'fallback-model'));

    expect(pi.calls[0].options?.model).toBe('fallback-model');
  });

  it('без step_models и без model → model undefined (дефолт pi)', async () => {
    const { deps, pi } = makeDeps();
    pi.enqueue(pass('resolve'));

    await runIteration(deps, makeInput(['resolve']));

    expect(pi.calls[0].options?.model).toBeUndefined();
  });
});

describe('runIteration — без репозиториев', () => {
  const emptyReposInput = (steps: PipelineStep[]): RunIterationInput => ({
    ...makeInput(steps),
    repositories: [],
  });

  it('prepare НЕ вызывается, контейнер спавнится, итерация завершается', async () => {
    const { deps, git, pi } = makeDeps();
    pi.enqueue(pass('resolve'));

    const result = await runIteration(deps, emptyReposInput(['resolve']));

    expect(result).toEqual({ iterationStatus: 'completed', needsInput: false });
    expect(git.prepares).toEqual([]);
    expect(pi.calls).toHaveLength(1);
    expect(pi.calls[0].options?.cwd).toBe('/workspaces/issue-1');
  });

  it('pr при пустых репо: pi отработал, но commit/push/MR НЕ вызваны', async () => {
    const { deps, git, mr, pi } = makeDeps();
    pi.enqueue(pass('resolve'));
    pi.enqueue(pass('pr'));

    const result = await runIteration(deps, emptyReposInput(['resolve', 'pr']));

    expect(result).toEqual({ iterationStatus: 'completed', needsInput: false });
    expect(git.prepares).toEqual([]);
    expect(git.commits).toEqual([]);
    expect(mr.calls).toEqual([]);
  });
});

describe('runIteration — pr-шаг (git commit/push + MR)', () => {
  const repos = [
    {
      repository_url: 'https://github.com/acme/app.git',
      base_branch: 'main',
      create_mr: true,
    },
    {
      repository_url: 'git@gitlab.example.com:team/lib.git',
      base_branch: 'develop',
      create_mr: true,
    },
  ];

  const makePrInput = (
    steps: PipelineStep[],
    mrToken = 'dummy-token',
    repositories = repos,
  ): RunIterationInput => ({
    issue: { id: 'issue-1', title: 'Fix bug', pipelineSteps: steps },
    iteration: {
      id: 'iter-1',
      issue_id: 'issue-1',
      number: 1,
      context: 'context text',
      review_context: '',
      is_review_need: false,
      steps,
      status: 'running',
      created_at: NOW,
      updated_at: NOW,
    } satisfies Iteration,
    repositories,
    mrToken,
  });

  it('resolve+pr success → completed; commit/push и MR по каждому репо', async () => {
    const { deps, pi, git, mr, sse } = makeDeps();
    const events: SSEEvent[] = [];
    sse.subscribe('iter-1', (event) => events.push(event));
    pi.enqueue(pass('resolve'));
    pi.enqueue(pass('pr'));

    const result = await runIteration(deps, makePrInput(['resolve', 'pr']));

    expect(result).toEqual({ iterationStatus: 'completed', needsInput: false });

    // commit/push: по одному на репозиторий, с ветвями из prepare.
    expect(git.commits).toHaveLength(2);
    expect(git.commits.map((commit) => commit.branchName)).toEqual([
      'main',
      'develop',
    ]);
    for (const commit of git.commits) {
      expect(commit.commitMessage).toBe('feat: Fix bug');
    }

    // MR: по одному на репозиторий, source выведен из URL.
    expect(mr.calls).toHaveLength(2);
    expect(mr.calls.map((call) => call.source)).toEqual(['github', 'gitlab']);
    expect(mr.calls.map((call) => call.baseBranch)).toEqual(['main', 'develop']);
    expect(mr.calls.map((call) => call.headBranch)).toEqual(['main', 'develop']);
    expect(mr.calls[0]).toMatchObject({
      repositoryUrl: 'https://github.com/acme/app.git',
      title: 'Fix bug',
      description: 'pr ok',
      token: 'dummy-token',
    });

    // log-события о commit (system) и MR (mr) ушли в SSE с честными stream.
    const systemData = events
      .filter((event) => event.type === 'log' && event.stream === 'system')
      .map((event) => event.data);
    expect(systemData).toEqual(['committed main', 'committed develop']);

    const mrData = events
      .filter((event) => event.type === 'log' && event.stream === 'mr')
      .map((event) => event.data);
    expect(mrData).toHaveLength(2);
    for (const url of mrData) {
      expect(url).toContain('merge_requests');
      expect(url.startsWith('mr:')).toBe(false);
    }
  });

  it('create_mr:false у всех репо → pr success, commit/push и MR НЕ вызваны', async () => {
    const { deps, pi, git, mr } = makeDeps();
    pi.enqueue(pass('resolve'));
    pi.enqueue(pass('pr'));

    const repositories = repos.map((repo) => ({ ...repo, create_mr: false }));
    const result = await runIteration(
      deps,
      makePrInput(['resolve', 'pr'], 'dummy-token', repositories),
    );

    expect(result).toEqual({ iterationStatus: 'completed', needsInput: false });
    expect(git.prepares).toHaveLength(1);
    expect(git.commits).toEqual([]);
    expect(mr.calls).toEqual([]);
  });

  it('per-repo create_mr: MR только для помеченных репозиториев', async () => {
    const { deps, pi, git, mr } = makeDeps();
    pi.enqueue(pass('resolve'));
    pi.enqueue(pass('pr'));

    const repositories = [
      { ...repos[0], create_mr: false },
      { ...repos[1], create_mr: true },
    ];
    const result = await runIteration(
      deps,
      makePrInput(['resolve', 'pr'], 'dummy-token', repositories),
    );

    expect(result).toEqual({ iterationStatus: 'completed', needsInput: false });
    expect(git.commits).toHaveLength(1);
    expect(mr.calls).toHaveLength(1);
    expect(mr.calls[0].repositoryUrl).toBe(
      'git@gitlab.example.com:team/lib.git',
    );
  });

  it('pr fail → failed; commitAndPush и createMr НЕ вызывались', async () => {
    const { deps, pi, git, mr } = makeDeps();
    pi.enqueue(pass('resolve'));
    pi.enqueue(fail('pr'));

    const result = await runIteration(deps, makePrInput(['resolve', 'pr']));

    expect(result).toEqual({ iterationStatus: 'failed', needsInput: false });
    expect(git.commits).toEqual([]);
    expect(mr.calls).toEqual([]);
  });

  it('без pr в шагах → commitAndPush и createMr НЕ вызывались', async () => {
    const { deps, pi, git, mr } = makeDeps();
    pi.enqueue(pass('resolve'));

    const result = await runIteration(deps, makePrInput(['resolve']));

    expect(result).toEqual({ iterationStatus: 'completed', needsInput: false });
    expect(git.commits).toEqual([]);
    expect(mr.calls).toEqual([]);
  });
});