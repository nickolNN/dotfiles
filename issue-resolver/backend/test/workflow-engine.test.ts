import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type {
  ExecutionPlan,
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
import { parseStepReport } from '@issue-resolver/shared';
import { FakeContainerController } from '../src/docker/controller';
import { FakeGitService } from '../src/git/service';
import { FakePiRunner } from '../src/pi/runner';
import { InMemoryStepSessionRegistry } from '../src/pi/session-registry';
import { FakeMrClient } from '../src/pr/mr';
import { InMemorySseHub } from '../src/sse/hub';
import type {
  IterationTerminalOutcome,
  RunIterationInput,
  StepRunStore,
  WorkflowDeps,
} from '../src/workflow/engine';
import { runIteration } from '../src/workflow/engine';
import { featureBranchName } from '../src/workflow/engine';

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
  desiredResult?: 'md' | 'html',
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
  preparedRepoWorkspaces: [
    {
      repoUrl: 'https://example.com/a.git',
      path: '/workspaces/issue-1/a',
      branch: 'main',
    },
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
    const runningPayload = statuses
      .filter((data) => data.startsWith('{'))
      .map((data) => JSON.parse(data) as { status: string })
      .find((payload) => payload.status === 'running');
    expect(runningPayload).toBeDefined();
    expect(statuses).toContain('success');
    expect(
      events.some((event) => event.type === 'log' && event.stream === 'stdout'),
    ).toBe(true);

    expect(git.prepares).toEqual([]);
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

    expect(observed).toEqual(['running']);
    expect(result).toEqual({ iterationStatus: 'completed', needsInput: false });
    expect(trace(store)).toEqual(['resolve#1:success']);
  });

  it('падение шага перезаписывает running на failed', async () => {
    const { deps, store } = makeDeps();
    const observed: StepRunStatus[] = [];
    deps.pi = {
      run: async () => {
        observed.push(store.runs[store.runs.length - 1]?.status ?? 'pending');
        return fail('resolve');
      },
    };

    await runIteration(deps, makeInput(['resolve']));

    expect(observed[0]).toBe('running');
    expect(trace(store)).toEqual([
      'resolve#1:failed',
      'resolve#2:failed',
      'resolve#3:failed',
      'resolve#4:failed',
    ]);
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

  it('desiredResult html → resolve prompt HE содержит report.html (это удел report-шага)', async () => {
    const { deps, pi } = makeDeps();
    pi.enqueue(pass('resolve'));

    await runIteration(deps, makeInput(['resolve'], undefined, 'html'));

    expect(pi.calls[0].prompt).not.toContain('report.html');
    expect(pi.calls[0].prompt).not.toContain('report.md');
  });

  it('desiredResult не задан → resolve prompt HE требует report.md и report.html', async () => {
    const { deps, pi } = makeDeps();
    pi.enqueue(pass('resolve'));

    await runIteration(deps, makeInput(['resolve']));

    expect(pi.calls[0].prompt).not.toContain('report.md');
    expect(pi.calls[0].prompt).not.toContain('report.html');
  });

  it('devServerPort → test-промпт несёт URL живого приложения', async () => {
    const { deps, pi } = makeDeps();
    pi.enqueue(pass('test'));

    await runIteration(deps, { ...makeInput(['test']), devServerPort: 4321 });

    expect(pi.calls[0].prompt).toContain('http://localhost:4321');
  });

  it('без devServerPort → test-промпт велит поднять приложение самому', async () => {
    const { deps, pi } = makeDeps();
    pi.enqueue(pass('test'));

    await runIteration(deps, makeInput(['test']));

    expect(pi.calls[0].prompt).toContain('No dev server is running');
  });

  it('pr-промпт несёт цели публикации: рабочая копия + base-ветка + create_mr', async () => {
    const { deps, pi } = makeDeps();
    pi.enqueue(pass('pr'));

    await runIteration(deps, {
      ...makeInput(['pr']),
      repositories: [
        {
          repository_url: 'https://example.com/a.git',
          base_branch: 'release-7',
          create_mr: true,
        },
      ],
    });

    expect(pi.calls[0].prompt).toContain(
      '/workspaces/issue-1/a — base `release-7`, create MR: yes',
    );
    expect(pi.calls[0].prompt).toContain('git status --porcelain');
    expect(pi.calls[0].prompt).not.toContain('<base>...HEAD');
  });

  it('прокидывает registry/stepRunId/iterationId живого шага в pi.run', async () => {
    const { deps, store, pi } = makeDeps();
    pi.enqueue(pass('resolve'));

    await runIteration(deps, makeInput(['resolve']));

    const options = pi.calls[0].options;
    expect(options?.stepRunId).toBe(store.runs[0].id);
    expect(options?.iterationId).toBe('iter-1');
    expect(options?.issueId).toBe('issue-1');
    expect(options?.registry).toBe(deps.control);
  });

  it('resolve fail → после self-retry с defaultSuccess → completed', async () => {
    const { deps, store, pi } = makeDeps();
    pi.enqueue(fail('resolve'));

    const result = await runIteration(deps, makeInput(['resolve']));

    expect(result).toEqual({ iterationStatus: 'completed', needsInput: false });
    expect(trace(store)).toEqual(['resolve#1:failed', 'resolve#2:success']);
    expect(pi.calls).toHaveLength(2);
  });

  it('resolve fail ×4 (исчерпаны self-retry) → iteration failed', async () => {
    const { deps, store, pi } = makeDeps();
    pi.enqueue(fail('resolve'));
    pi.enqueue(fail('resolve'));
    pi.enqueue(fail('resolve'));
    pi.enqueue(fail('resolve'));

    const result = await runIteration(deps, makeInput(['resolve', 'review']));

    expect(result).toEqual({ iterationStatus: 'failed', needsInput: false });
    expect(trace(store)).toEqual([
      'resolve#1:failed',
      'resolve#2:failed',
      'resolve#3:failed',
      'resolve#4:failed',
    ]);
    expect(pi.calls).toHaveLength(4);
  });

  it('stdout/stderr прокидываются в createStepOutput (с self-retry)', async () => {
    const { deps, store, pi } = makeDeps();
    pi.enqueue(fail('resolve'));

    await runIteration(deps, makeInput(['resolve']));

    expect(store.outputs).toHaveLength(2);
    expect(store.outputs[0].stderr).toBe('resolve err');
    expect(store.outputs[1].stdout).toBe('');
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
    expect(JSON.parse(stepEvents[1].data).event).toEqual({
      type: 'thinking',
      thinking: 'размышляю над задачей',
    });
  });

  it('вопрос агента → question, ответ → running (хук статуса задачи)', async () => {
    const { deps, pi } = makeDeps();
    const statuses: Array<'question' | 'running'> = [];
    deps.onQuestionStatus = (status) => statuses.push(status);
    pi.enqueue({
      step: 'resolve',
      exitCode: 0,
      report: { status: 'pass', summary: 'ok' },
      stdout: '',
      stderr: '',
      events: [
        { type: 'question', id: 'q1', method: 'select', title: 'Выбор?' },
        { type: 'question_answered', questionId: 'q1', answer: 'A' },
      ],
    });

    await runIteration(deps, makeInput(['resolve']));

    expect(statuses).toEqual(['question', 'running']);
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

  const piWritesDuringRun = (
    pi: FakePiRunner,
    writes: () => [string, string][],
  ): void => {
    const run = pi.run.bind(pi);
    pi.run = async (containerName, prompt, options) => {
      const result = await run(containerName, prompt, options);
      for (const [path, content] of writes()) await writeFile(path, content);
      return result;
    };
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

  it('каталог screenshots/ шага → screenshots_dir в output (строка UI «Скриншоты»)', async () => {
    const { deps, store, pi } = makeDeps();
    const { root, dir } = await withWorkspace();
    await mkdir(join(dir, 'screenshots'), { recursive: true });
    deps.workspaceRoot = root;
    pi.enqueue(pass('test'));

    await runIteration(deps, makeInput(['test']));

    expect(store.outputs[0].screenshots_dir).toBe('screenshots');
  });

  it('нет каталога screenshots/ → screenshots_dir null', async () => {
    const { deps, store, pi } = makeDeps();
    const { root } = await withWorkspace();
    deps.workspaceRoot = root;
    pi.enqueue(pass('resolve'));

    await runIteration(deps, makeInput(['resolve']));

    expect(store.outputs[0].screenshots_dir).toBeNull();
  });

  it('файл {status:fail,summary} перекрывает result.report → 4 попытки fail, self-retry исчерпаны', async () => {
    const { deps, store, pi } = makeDeps();
    const { root, dir } = await withWorkspace();
    deps.workspaceRoot = root;
    piWritesDuringRun(pi, () => [
      [
        join(dir, '.issue-step-result.json'),
        JSON.stringify({ status: 'fail', summary: 'найдено 3 дефекта' }),
      ],
    ]);
    pi.enqueue(pass('resolve'));

    const result = await runIteration(deps, makeInput(['resolve']));

    expect(result).toEqual({ iterationStatus: 'failed', needsInput: false });
    expect(trace(store)).toEqual([
      'resolve#1:failed',
      'resolve#2:failed',
      'resolve#3:failed',
      'resolve#4:failed',
    ]);
    expect(JSON.parse(store.outputs[0].report)).toEqual({
      status: 'fail',
      summary: 'найдено 3 дефекта',
    });
  });

  it('файл {status:blocked} → needs_input', async () => {
    const { deps, store, pi } = makeDeps();
    const { root, dir } = await withWorkspace();
    deps.workspaceRoot = root;
    piWritesDuringRun(pi, () => [
      [
        join(dir, '.issue-step-result.json'),
        JSON.stringify({ status: 'blocked', summary: 'нужен доступ' }),
      ],
    ]);
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
    const { root, dir } = await withWorkspace();
    deps.workspaceRoot = root;
    piWritesDuringRun(pi, () => [[join(dir, '.issue-step-result.json'), '{not json']]);
    pi.enqueue(noReport('resolve'));

    const result = await runIteration(deps, makeInput(['resolve']));

    expect(result).toEqual({ iterationStatus: 'completed', needsInput: false });
    expect(trace(store)).toEqual(['resolve#1:success']);
    expect(store.outputs[0].report).toBe('');
  });

  it('отчёт, записанный в клон репозитория, читается: клон — тоже рабочая папка', async () => {
    const { deps, store, pi } = makeDeps();
    const { root, dir } = await withWorkspace();
    await mkdir(join(dir, 'app'), { recursive: true });
    deps.workspaceRoot = root;
    piWritesDuringRun(pi, () => [
      [
        join(dir, 'app', '.issue-step-result.json'),
        JSON.stringify({ status: 'fail', summary: 'из клона' }),
      ],
    ]);
    pi.enqueue(pass('resolve'));

    const result = await runIteration(deps, makeInput(['resolve']));

    expect(result).toEqual({ iterationStatus: 'failed', needsInput: false });
    expect(trace(store)[0]).toBe('resolve#1:failed');
    expect(JSON.parse(store.outputs[0].report)).toEqual({
      status: 'fail',
      summary: 'из клона',
    });
  });

  it('отчёт прошлого шага не наследуется: шаг его не трогал → статус по exit-коду', async () => {
    const { deps, store, pi } = makeDeps();
    const { root } = await withWorkspace(
      JSON.stringify({ status: 'fail', summary: 'отчёт прошлого шага' }),
    );
    deps.workspaceRoot = root;
    pi.enqueue(pass('resolve'));

    const result = await runIteration(deps, makeInput(['resolve']));

    expect(result).toEqual({ iterationStatus: 'completed', needsInput: false });
    expect(trace(store)).toEqual(['resolve#1:success']);
    expect(JSON.parse(store.outputs[0].report)).toEqual({
      status: 'pass',
      summary: 'resolve ok',
    });
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

    expect(result).toEqual({ iterationStatus: 'cancelled', needsInput: false });
    expect(trace(store)).toEqual(['resolve#1:success', 'review#1:aborted']);
    expect(pi.calls).toHaveLength(2);
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
    const { deps, pi, sse } = makeDeps();
    pi.enqueue(pass('resolve'));
    pi.enqueue(pass('review'));
    const events: SSEEvent[] = [];
    sse.subscribe('iter-1', (event) => events.push(event));

    await runIteration(deps, {
      ...makeInput(['resolve', 'review'], 'fallback-model'),
      step_models: { review: 'review-model' },
    });

    expect(pi.calls.map((call) => call.options?.model)).toEqual([
      'fallback-model',
      'review-model',
    ]);

    const runningPayloads = events
      .filter((event) => event.type === 'step_status')
      .map((event) => event.data)
      .filter((data) => data.startsWith('{'))
      .map(
        (data) =>
          JSON.parse(data) as {
            status: string;
            step: string;
            model: string | null;
          },
      )
      .filter((payload) => payload.status === 'running');
    expect(runningPayloads).toEqual([
      { status: 'running', step: 'resolve', model: 'fallback-model' },
      { status: 'running', step: 'review', model: 'review-model' },
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

describe('runIteration — уровни размышления', () => {
  it('step_thinking_levels[step] переопределяет общий thinking_level', async () => {
    const { deps, pi } = makeDeps();
    pi.enqueue(pass('resolve'));
    pi.enqueue(pass('review'));

    await runIteration(deps, {
      ...makeInput(['resolve', 'review']),
      thinking_level: 'medium',
      step_thinking_levels: { review: 'high' },
    });

    expect(pi.calls.map((call) => call.options?.thinkingLevel)).toEqual([
      'medium',
      'high',
    ]);
  });

  it('шаг без step_thinking_levels берёт общий thinking_level', async () => {
    const { deps, pi } = makeDeps();
    pi.enqueue(pass('resolve'));

    await runIteration(deps, {
      ...makeInput(['resolve']),
      thinking_level: 'low',
    });

    expect(pi.calls[0].options?.thinkingLevel).toBe('low');
  });

  it('без step_thinking_levels и без thinking_level → undefined (дефолт pi)', async () => {
    const { deps, pi } = makeDeps();
    pi.enqueue(pass('resolve'));

    await runIteration(deps, makeInput(['resolve']));

    expect(pi.calls[0].options?.thinkingLevel).toBeUndefined();
  });
});

describe('runIteration — без репозиториев', () => {
  const emptyReposInput = (steps: PipelineStep[]): RunIterationInput => ({
    ...makeInput(steps),
    repositories: [],
    preparedRepoWorkspaces: [],
  });

  it('prepare НЕ вызывается, пайплайн исполняется в cwd задачи', async () => {
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
    preparedRepoWorkspaces: repositories.map((repo) => ({
      repoUrl: repo.repository_url,
      path: `/workspaces/issue-1/${repo.repository_url
        .replace(/\/+$/, '')
        .replace(/\.git$/, '')
        .split(/[\\/]/)
        .pop()}`,
      branch: repo.base_branch,
    })),
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

    expect(git.commits).toHaveLength(2);
    const featureBranches = git.commits.map((commit) => commit.branchName);
    for (const branch of featureBranches) {
      expect(branch).toMatch(/^feature\//);
    }
    expect(featureBranches).not.toContain('main');
    expect(featureBranches).not.toContain('develop');
    for (const commit of git.commits) {
      expect(commit.commitMessage).toBe('feat: Fix bug');
    }

    expect(mr.calls).toHaveLength(2);
    expect(mr.calls.map((call) => call.source)).toEqual(['github', 'gitlab']);
    expect(mr.calls.map((call) => call.baseBranch)).toEqual(['main', 'develop']);
    expect(mr.calls.map((call) => call.headBranch)).toEqual(featureBranches);
    for (const call of mr.calls) {
      expect(call.headBranch).not.toBe(call.baseBranch);
    }
    expect(mr.calls[0]).toMatchObject({
      repositoryUrl: 'https://github.com/acme/app.git',
      title: 'Fix bug',
      description: 'pr ok',
      token: 'dummy-token',
    });

    const systemData = events
      .filter((event) => event.type === 'log' && event.stream === 'system')
      .map((event) => event.data);
    expect(systemData).toEqual(
      featureBranches.map((branch) => `committed ${branch}`),
    );

    const mrData = events
      .filter((event) => event.type === 'log' && event.stream === 'mr')
      .map((event) => event.data);
    expect(mrData).toHaveLength(2);
    for (const url of mrData) {
      expect(
        url.includes('merge_requests') || url.includes('/pull/'),
      ).toBe(true);
      expect(url.startsWith('mr:')).toBe(false);
    }
  });

  it('branch protection: push в feature-ветку, MR head≠base (base не пушится)', async () => {
    const { deps, pi, git, mr } = makeDeps();
    pi.enqueue(pass('resolve'));
    pi.enqueue(pass('pr'));

    const result = await runIteration(deps, makePrInput(['resolve', 'pr']));

    expect(result).toEqual({ iterationStatus: 'completed', needsInput: false });
    expect(git.commits).toHaveLength(2);
    for (const commit of git.commits) {
      expect(commit.branchName).toMatch(/^feature\//);
      expect(commit.branchName).not.toMatch(/^(main|develop)$/);
      expect(commit.squashBase).toMatch(/^origin\/(main|develop)$/);
    }
    for (const call of mr.calls) {
      expect(call.headBranch).toMatch(/^feature\//);
      expect(call.baseBranch).toMatch(/^(main|develop)$/);
      expect(call.headBranch).not.toBe(call.baseBranch);
    }
  });

  it('create_mr:false у всех репо → pr success, commit/push и MR НЕ вызваны', async () => {
    const { deps, pi, git, mr, store } = makeDeps();
    pi.enqueue(pass('resolve'));
    pi.enqueue(pass('pr'));

    const repositories = repos.map((repo) => ({ ...repo, create_mr: false }));
    const result = await runIteration(
      deps,
      makePrInput(['resolve', 'pr'], 'dummy-token', repositories),
    );

    expect(result).toEqual({ iterationStatus: 'completed', needsInput: false });
    expect(git.prepares).toEqual([]);
    expect(git.commits).toEqual([]);
    expect(mr.calls).toEqual([]);

    const prRun = store.runs.find((run) => run.step === 'pr');
    const prOutput = store.outputs.find(
      (output) => output.step_run_id === prRun?.id,
    );
    expect(prRun?.status).toBe('success');
    expect(
      prOutput?.events?.some(
        (event) => event.type === 'notice' && event.level === 'warning',
      ),
    ).toBe(true);
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

  it('createMr падает → итерация completed, но шаг pr failed и причина видна (publish не роняет прогон)', async () => {
    const { deps, pi, git, mr, sse, store } = makeDeps();
    const events: SSEEvent[] = [];
    sse.subscribe('iter-1', (event) => events.push(event));
    pi.enqueue(pass('resolve'));
    pi.enqueue(pass('pr'));
    mr.failNextWith(new Error('mr api 403'));

    const result = await runIteration(deps, makePrInput(['resolve', 'pr']));

    expect(result).toEqual({ iterationStatus: 'completed', needsInput: false });
    expect(git.commits).toHaveLength(1);
    expect(mr.calls).toEqual([]);

    const prRun = store.runs.find((run) => run.step === 'pr');
    expect(prRun?.status).toBe('failed');
    const prOutput = store.outputs.find(
      (output) => output.step_run_id === prRun?.id,
    );
    const persisted = parseStepReport(prOutput?.report ?? '');
    expect(persisted?.pr_error).toBeDefined();
    expect(persisted?.pr_error).toContain('MR');
    expect(persisted?.pr_error).toContain('mr api 403');
    expect(
      prOutput?.events?.some(
        (event) =>
          event.type === 'notice' &&
          event.level === 'error' &&
          event.message.includes('mr api 403'),
      ),
    ).toBe(true);
    expect(
      events.some(
        (event) =>
          event.type === 'step_status' &&
          event.stepRunId === prRun?.id &&
          event.data === 'failed',
      ),
    ).toBe(true);
    expect(
      events.some(
        (event) =>
          event.type === 'step_event' &&
          event.data.includes('mr api 403'),
      ),
    ).toBe(true);
  });

  it('commitAndPush падает → итерация completed, шаг pr failed с причиной (publish не роняет прогон)', async () => {
    const { deps, pi, git, mr, store } = makeDeps();
    pi.enqueue(pass('resolve'));
    pi.enqueue(pass('pr'));
    git.failNextWith(new Error('git push rejected'));

    const result = await runIteration(deps, makePrInput(['resolve', 'pr']));

    expect(result).toEqual({ iterationStatus: 'completed', needsInput: false });
    expect(git.commits).toEqual([]);
    expect(mr.calls).toEqual([]);

    const prRun = store.runs.find((run) => run.step === 'pr');
    expect(prRun?.status).toBe('failed');
    const persisted = parseStepReport(
      store.outputs.find((output) => output.step_run_id === prRun?.id)
        ?.report ?? '',
    );
    expect(persisted?.pr_error).toContain('commit/push');
    expect(persisted?.pr_error).toContain('git push rejected');
  });

  it('неизвестный git-хост при публикации → шаг pr failed, причина «unknown git host»', async () => {
    const { deps, pi, git, mr, store } = makeDeps();
    pi.enqueue(pass('resolve'));
    pi.enqueue(pass('pr'));
    const repositories = [
      {
        repository_url: 'https://unknown.example.org/team/app.git',
        base_branch: 'main',
        create_mr: true,
      },
    ];

    const result = await runIteration(
      deps,
      makePrInput(['resolve', 'pr'], 'dummy-token', repositories),
    );

    expect(result).toEqual({ iterationStatus: 'completed', needsInput: false });
    expect(git.commits).toHaveLength(1);
    expect(mr.calls).toEqual([]);
    const prRun = store.runs.find((run) => run.step === 'pr');
    expect(prRun?.status).toBe('failed');
    const persisted = parseStepReport(
      store.outputs.find((output) => output.step_run_id === prRun?.id)
        ?.report ?? '',
    );
    expect(persisted?.pr_error).toContain('unknown git host');
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

  it('только pr в шагах → один агент, публикация, completed (MR без перезапуска resolve)', async () => {
    const { deps, pi, git, mr, store } = makeDeps();
    pi.enqueue(pass('pr'));

    const result = await runIteration(
      deps,
      makePrInput(['pr'], 'dummy-token', [repos[0]]),
    );

    expect(result).toEqual({ iterationStatus: 'completed', needsInput: false });
    expect(trace(store)).toEqual(['pr#1:success']);
    expect(pi.calls).toHaveLength(1);
    expect(git.commits).toHaveLength(1);
    expect(mr.calls).toHaveLength(1);
  });

  it('только pr и он упал → iteration failed, ветка/MR не трогались', async () => {
    const { deps, pi, git, mr, store } = makeDeps();
    pi.enqueue(fail('pr'));

    const result = await runIteration(
      deps,
      makePrInput(['pr'], 'dummy-token', [repos[0]]),
    );

    expect(result).toEqual({ iterationStatus: 'failed', needsInput: false });
    expect(trace(store)).toEqual(['pr#1:failed']);
    expect(git.commits).toEqual([]);
    expect(mr.calls).toEqual([]);
  });

  it('refine + pr без resolve: планирование → публикация, resolve не запускался', async () => {
    const { deps, pi, store } = makeDeps();
    pi.enqueue(pass('refine'));
    pi.enqueue(pass('pr'));

    const result = await runIteration(deps, makePrInput(['refine', 'pr']));

    expect(result).toEqual({ iterationStatus: 'completed', needsInput: false });
    expect(trace(store)).toEqual(['refine#1:success', 'pr#1:success']);
  });

  it('review без resolve упал → iteration failed (откатывать некуда, resolve в шагах нет)', async () => {
    const { deps, pi, store } = makeDeps();
    pi.enqueue(fail('review'));

    const result = await runIteration(deps, makePrInput(['review', 'pr']));

    expect(result).toEqual({ iterationStatus: 'failed', needsInput: false });
    expect(trace(store)).toEqual(['review#1:failed']);
  });

  it('resolve + review + test + pr (полный набор) → канонический порядок и completed', async () => {
    const { deps, pi, store } = makeDeps();
    (['resolve', 'review', 'test', 'pr'] as PipelineStep[]).forEach((step) =>
      pi.enqueue(pass(step)),
    );

    const result = await runIteration(
      deps,
      makePrInput(['resolve', 'review', 'test', 'pr']),
    );

    expect(result).toEqual({ iterationStatus: 'completed', needsInput: false });
    expect(trace(store)).toEqual([
      'resolve#1:success',
      'review#1:success',
      'test#1:success',
      'pr#1:success',
    ]);
  });

  it('уже есть открытый MR из той же ветки → push обновляет его, createMr НЕ вызывается', async () => {
    const { deps, pi, git, mr, sse } = makeDeps();
    const events: SSEEvent[] = [];
    sse.subscribe('iter-1', (event) => events.push(event));
    pi.enqueue(pass('resolve'));
    pi.enqueue(pass('pr'));

    const existingGhUrl = 'https://github.com/acme/app/pull/42';
    const existingGlUrl =
      'https://gitlab.example.com/team/lib/-/merge_requests/7';
    const branch = featureBranchName('Fix bug', 'issue-1');
    mr.openMrs = [
      {
        repositoryUrl: 'https://github.com/acme/app.git',
        headBranch: branch,
        baseBranch: 'main',
        mrUrl: existingGhUrl,
      },
      {
        repositoryUrl: 'git@gitlab.example.com:team/lib.git',
        headBranch: branch,
        baseBranch: 'develop',
        mrUrl: existingGlUrl,
      },
    ];

    const result = await runIteration(deps, makePrInput(['resolve', 'pr']));

    expect(result).toEqual({ iterationStatus: 'completed', needsInput: false });
    expect(git.commits.length).toBeGreaterThanOrEqual(1);
    expect(mr.calls).toHaveLength(0);

    expect(mr.updateCalls.map((call) => call.mrId)).toEqual([
      existingGhUrl,
      existingGlUrl,
    ]);
    expect(mr.updateCalls[0]).toMatchObject({
      repositoryUrl: 'https://github.com/acme/app.git',
      source: 'github',
      title: 'Fix bug',
      description: 'pr ok',
    });

    const mrEvents = events.filter(
      (event) => event.type === 'log' && event.stream === 'mr',
    );
    expect(mrEvents.map((event) => event.data)).toEqual([
      `заголовок и описание MR обновлены — ${existingGhUrl}`,
      existingGhUrl,
      `заголовок и описание MR обновлены — ${existingGlUrl}`,
      existingGlUrl,
    ]);

    const systemEvents = events
      .filter(
        (event) => event.type === 'log' && event.stream === 'system',
      )
      .map((event) => event.data);
    expect(
      systemEvents.some((data) => data.includes('MR уже существует')),
    ).toBe(true);
  });

  it('код-шаг принёс title+description → pr-агент всё равно пишет текст сам', async () => {
    const { deps, pi, mr } = makeDeps();
    pi.enqueue({
      step: 'resolve',
      exitCode: 0,
      report: {
        status: 'pass',
        summary: 'resolve ok',
        title: 'stale per-iteration title',
        description: 'describes only this iteration',
      },
      stdout: '',
      stderr: '',
    });
    pi.enqueue({
      step: 'pr',
      exitCode: 0,
      report: {
        status: 'pass',
        summary: 'pr ok',
        title: 'KOS-1: whole task, all iterations',
        description: '## Summary\nfull payload\n',
      },
      stdout: '',
      stderr: '',
    });

    const result = await runIteration(deps, makePrInput(['resolve', 'pr']));

    expect(result).toEqual({ iterationStatus: 'completed', needsInput: false });
    expect(pi.calls).toHaveLength(2);
    expect(mr.calls).toHaveLength(2);
    expect(mr.calls[0]).toMatchObject({
      title: 'KOS-1: whole task, all iterations',
      description: '## Summary\nfull payload\n',
    });
  });

  it('updateMr падает → MR остаётся открытым, прогон не роняется, текст в отчёте', async () => {
    const { deps, pi, git, mr, sse } = makeDeps();
    const events: SSEEvent[] = [];
    sse.subscribe('iter-1', (event) => events.push(event));
    const branch = featureBranchName('Fix bug', 'issue-1');
    mr.openMrs = [
      {
        repositoryUrl: 'https://github.com/acme/app.git',
        headBranch: branch,
        baseBranch: 'main',
        mrUrl: 'https://github.com/acme/app/pull/42',
      },
    ];
    mr.failNextUpdateWith(new Error('gitlab mr update failed: 403'));
    pi.enqueue(pass('resolve'));
    pi.enqueue(pass('pr'));

    const result = await runIteration(deps, makePrInput(['resolve', 'pr']));

    expect(result).toEqual({ iterationStatus: 'completed', needsInput: false });
    expect(git.commits).toHaveLength(2);
    expect(mr.updateCalls).toHaveLength(1);
    expect(mr.calls).toHaveLength(1);
    expect(mr.calls[0].repositoryUrl).toBe('git@gitlab.example.com:team/lib.git');
    expect(
      events
        .filter((event) => event.type === 'log' && event.stream === 'mr')
        .map((event) => event.data)
        .some((data) => data.includes('текст обновить не удалось')),
    ).toBe(true);
  });

  it('второй прогон pr: push в ту же ветку с squashBase → force-push, findOpenMr находит существующий MR, updateMr обновляет описание', async () => {
    const { deps, pi, git, mr } = makeDeps();
    pi.enqueue(pass('resolve'));
    pi.enqueue(pass('pr'));

    const branch = featureBranchName('Fix bug', 'issue-1');
    const existingUrl = 'https://github.com/acme/app/pull/42';
    mr.openMrs = [
      {
        repositoryUrl: 'https://github.com/acme/app.git',
        headBranch: branch,
        baseBranch: 'main',
        mrUrl: existingUrl,
      },
    ];

    const singleRepo = [
      {
        repository_url: 'https://github.com/acme/app.git',
        base_branch: 'main',
        create_mr: true,
      },
    ];
    const result = await runIteration(deps, {
      issue: { id: 'issue-1', title: 'Fix bug', pipelineSteps: ['resolve', 'pr'] },
      iteration: {
        id: 'iter-1',
        issue_id: 'issue-1',
        number: 1,
        context: 'context text',
        review_context: '',
        is_review_need: false,
        steps: ['resolve', 'pr'],
        status: 'running',
        created_at: NOW,
        updated_at: NOW,
      },
      repositories: singleRepo,
      preparedRepoWorkspaces: singleRepo.map((repo) => ({
        repoUrl: repo.repository_url,
        path: '/workspaces/issue-1/app',
        branch: repo.base_branch,
      })),
      mrToken: 'dummy-token',
    });

    expect(result).toEqual({ iterationStatus: 'completed', needsInput: false });

    expect(git.commits.length).toBeGreaterThanOrEqual(1);
    for (const commit of git.commits) {
      expect(commit.squashBase).toBeDefined();
      expect(commit.squashBase).toMatch(/^origin\//);
    }

    expect(mr.calls).toHaveLength(0);
    expect(mr.updateCalls).toHaveLength(1);
    expect(mr.updateCalls[0]).toMatchObject({
      mrId: existingUrl,
      title: 'Fix bug',
      description: 'pr ok',
    });
  });
});

describe('runIteration — resolve как комната (multi-agent)', () => {
  const refineWith = (execution: ExecutionPlan): StepExecutionResult => ({
    step: 'refine',
    exitCode: 0,
    report: { status: 'pass', summary: 'plan', execution },
    stdout: '',
    stderr: '',
  });

  const resolveWith = (summary: string): StepExecutionResult => ({
    step: 'resolve',
    exitCode: 0,
    report: { status: 'pass', summary },
    stdout: `${summary} out`,
    stderr: '',
  });

  it('refine room(2) → 2 исполнителя + 1 координатор; отчёт = координатора', async () => {
    const { deps, store, pi, sse, control } = makeDeps();
    const events: SSEEvent[] = [];
    sse.subscribe('iter-1', (event) => events.push(event));
    pi.enqueue(
      refineWith({
        mode: 'room',
        executors: 2,
        decomposition: ['a', 'b'],
      }),
    );
    pi.enqueue(resolveWith('worker0'));
    pi.enqueue(resolveWith('worker1'));
    pi.enqueue(resolveWith('coordinator'));

    const result = await runIteration(deps, makeInput(['refine', 'resolve']));

    expect(result).toEqual({ iterationStatus: 'completed', needsInput: false });
    expect(trace(store)).toEqual(['refine#1:success', 'resolve#1:success']);

    expect(pi.calls).toHaveLength(4);
    const resolveRunId = store.runs[1].id;
    expect(pi.calls[1].options?.stepRunId).toBe(`run.${resolveRunId}.w0`);
    expect(pi.calls[2].options?.stepRunId).toBe(`run.${resolveRunId}.w1`);
    expect(pi.calls[3].options?.stepRunId).toBe(resolveRunId);

    expect(JSON.parse(store.outputs[1].report)).toMatchObject({
      status: 'pass',
      summary: 'coordinator',
    });

    expect(pi.calls[1].prompt).toContain('Sub-task 1 of 2: a');
    expect(pi.calls[2].prompt).toContain('Sub-task 2 of 2: b');
    expect(pi.calls[1].prompt).toContain('NOT the lead');
    expect(pi.calls[1].prompt).toContain('Refined plan');

    expect(pi.calls[3].prompt).toContain('LEAD');
    expect(pi.calls[3].prompt).toContain('worker0');
    expect(pi.calls[3].prompt).toContain('worker1');

    const systemData = events
      .filter((event) => event.type === 'log' && event.stream === 'system')
      .map((event) => event.data);
    expect(systemData).toContain('worker 1/2: a');
    expect(systemData).toContain('worker 2/2: b');

    expect(control.listAgents('iter-1')).toEqual([
      {
        id: `run.${resolveRunId}.w0`,
        role: 'worker',
        index: 1,
        label: 'Исполнитель 1',
        stage: null,
        stageName: null,
        status: 'running',
        startedAt: expect.any(String),
        endedAt: null,
        stats: null,
      },
      {
        id: `run.${resolveRunId}.w1`,
        role: 'worker',
        index: 2,
        label: 'Исполнитель 2',
        stage: null,
        stageName: null,
        status: 'running',
        startedAt: expect.any(String),
        endedAt: null,
        stats: null,
      },
      {
        id: resolveRunId,
        role: 'coordinator',
        index: null,
        label: 'Координатор',
        stage: null,
        stageName: null,
        status: 'running',
        startedAt: expect.any(String),
        endedAt: null,
        stats: null,
      },
    ]);

    const tagged = events.filter(
      (event) => event.type === 'step_event' && event.agentId !== undefined,
    );
    const perAgent = new Map<string, number>();
    for (const event of tagged) {
      perAgent.set(event.agentId ?? '', (perAgent.get(event.agentId ?? '') ?? 0) + 1);
    }
    expect(perAgent.get(`run.${resolveRunId}.w0`)).toBe(3);
    expect(perAgent.get(`run.${resolveRunId}.w1`)).toBe(3);
    expect(perAgent.get(resolveRunId)).toBe(3);
    expect(
      JSON.parse(tagged[0].data) as { agentId?: string },
    ).toMatchObject({
      stepRunId: resolveRunId,
      agentId: `run.${resolveRunId}.w0`,
    });
  });

  it('worker_count = 1 гасит room-рекомендацию refine → resolve одним агентом', async () => {
    const { deps, store, pi } = makeDeps();
    pi.enqueue(
      refineWith({
        mode: 'room',
        executors: 3,
        decomposition: ['a', 'b', 'c'],
      }),
    );
    pi.enqueue(resolveWith('solo'));

    const input = makeInput(['refine', 'resolve']);
    const result = await runIteration(deps, {
      ...input,
      iteration: { ...input.iteration, worker_count: 1 },
    });

    expect(result).toEqual({ iterationStatus: 'completed', needsInput: false });
    expect(pi.calls).toHaveLength(2);
    expect(pi.calls[1].options?.stepRunId).toBe(store.runs[1].id);
    expect(pi.calls[1].options?.agent).toBeUndefined();
    expect(pi.calls[1].prompt).toContain('Role: implementer');
  });

  it('worker_count = 2 режет room-план refine с 4 исполнителями до двух', async () => {
    const { deps, pi } = makeDeps();
    pi.enqueue(
      refineWith({
        mode: 'room',
        executors: 4,
        decomposition: ['a', 'b', 'c', 'd'],
      }),
    );
    pi.enqueue(resolveWith('w1'));
    pi.enqueue(resolveWith('w2'));
    pi.enqueue(resolveWith('lead'));

    const input = makeInput(['refine', 'resolve']);
    await runIteration(deps, {
      ...input,
      iteration: { ...input.iteration, worker_count: 2 },
    });

    expect(pi.calls).toHaveLength(4);
    expect(pi.calls.map((call) => call.options?.stepRunId).slice(1)).toEqual([
      expect.stringContaining('.w0'),
      expect.stringContaining('.w1'),
      expect.not.stringContaining('.w'),
    ]);
  });

  it('room + aborted исполнитель → координатор НЕ стартует, итерация cancelled', async () => {
    const { deps, store, pi } = makeDeps();
    pi.enqueue(
      refineWith({
        mode: 'room',
        executors: 2,
        decomposition: ['a', 'b'],
      }),
    );
    pi.enqueue({
      ...resolveWith('worker0'),
      exitCode: 1,
      report: { status: 'fail', summary: 'aborted' },
      aborted: true,
    });
    pi.enqueue(resolveWith('worker1'));

    const result = await runIteration(deps, makeInput(['refine', 'resolve']));

    expect(result).toEqual({ iterationStatus: 'cancelled', needsInput: false });
    expect(pi.calls).toHaveLength(3);
    const resolveRunId = store.runs[1].id;
    expect(pi.calls[1].options?.stepRunId).toBe(`run.${resolveRunId}.w0`);
    expect(pi.calls[2].options?.stepRunId).toBe(`run.${resolveRunId}.w1`);
    expect(store.runs[1].status).toBe('aborted');
    expect(trace(store)).toEqual(['refine#1:success', 'resolve#1:aborted']);
  });

  it('refine single/без execution → resolve один pi-вызов', async () => {
    const { deps, store, pi } = makeDeps();
    pi.enqueue(pass('refine'));
    pi.enqueue(pass('resolve'));

    const result = await runIteration(deps, makeInput(['refine', 'resolve']));

    expect(result).toEqual({ iterationStatus: 'completed', needsInput: false });
    expect(trace(store)).toEqual(['refine#1:success', 'resolve#1:success']);
    expect(pi.calls).toHaveLength(2);
    expect(pi.calls[1].options?.stepRunId).toBe(store.runs[1].id);
    expect(pi.calls[1].prompt).not.toContain('NOT the lead');
  });

  it('refine execution single с executors — всё равно один вызов', async () => {
    const { deps, store, pi } = makeDeps();
    pi.enqueue(refineWith({ mode: 'single', executors: 4 }));
    pi.enqueue(pass('resolve'));

    await runIteration(deps, makeInput(['refine', 'resolve']));

    expect(pi.calls).toHaveLength(2);
    expect(trace(store)).toEqual(['refine#1:success', 'resolve#1:success']);
  });

  it('refine stages(2) → этапы последовательно + финальный lead; отчёт = final', async () => {
    const { deps, store, pi, control } = makeDeps();
    pi.enqueue(
      refineWith({
        mode: 'stages',
        stages: [
          {
            index: 1,
            name: 'Сбор',
            task: 'собрать',
            executors: 2,
            decomposition: ['a', 'b'],
          },
          { index: 2, name: 'Починка', task: 'починить', executors: 1 },
        ],
      }),
    );
    pi.enqueue(resolveWith('s1w1'));
    pi.enqueue(resolveWith('s1w2'));
    pi.enqueue(resolveWith('s1coord'));
    pi.enqueue(resolveWith('s2'));
    pi.enqueue(resolveWith('final'));

    const result = await runIteration(deps, makeInput(['refine', 'resolve']));

    expect(result).toEqual({ iterationStatus: 'completed', needsInput: false });
    expect(trace(store)).toEqual(['refine#1:success', 'resolve#1:success']);

    const resolveRunId = store.runs[1].id;
    expect(pi.calls.slice(1).map((call) => call.options?.stepRunId)).toEqual([
      `run.${resolveRunId}.s1.w0`,
      `run.${resolveRunId}.s1.w1`,
      `run.${resolveRunId}.s1.lead`,
      `run.${resolveRunId}.s2.w0`,
      resolveRunId,
    ]);
    expect(JSON.parse(store.outputs[1].report)).toMatchObject({
      status: 'pass',
      summary: 'final',
    });
    expect(control.listAgents('iter-1').map((agent) => agent.stage)).toEqual([
      1, 1, 1, 2, null,
    ]);
  });

  it('steps без refine → resolve single, один вызов', async () => {
    const { deps, store, pi } = makeDeps();
    pi.enqueue(pass('resolve'));

    const result = await runIteration(deps, makeInput(['resolve']));

    expect(result).toEqual({ iterationStatus: 'completed', needsInput: false });
    expect(trace(store)).toEqual(['resolve#1:success']);
    expect(pi.calls).toHaveLength(1);
  });
});

describe('runIteration — onIterationTerminal (A1–A5)', () => {
  const collect = (deps: WorkflowDeps): IterationTerminalOutcome[] => {
    const seen: IterationTerminalOutcome[] = [];
    deps.onIterationTerminal = (outcome) => seen.push(outcome);
    return seen;
  };

  it('A1: completed-итерация дёргает колбэк ровно один раз с iterationStatus=completed', async () => {
    const { deps, pi } = makeDeps();
    pi.enqueue(pass('resolve'));
    const seen = collect(deps);

    const result = await runIteration(deps, makeInput(['resolve']));

    expect(result).toEqual({ iterationStatus: 'completed', needsInput: false });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      issueId: 'issue-1',
      issueTitle: 'Fix bug',
      iterationNumber: 1,
      iterationCount: 1,
      iterationStatus: 'completed',
    });
  });

  it('A2: resolve исчерпал self-retry → колбэк failed', async () => {
    const { deps, pi } = makeDeps();
    pi.enqueue(fail('resolve'));
    pi.enqueue(fail('resolve'));
    pi.enqueue(fail('resolve'));
    pi.enqueue(fail('resolve'));
    const seen = collect(deps);

    const result = await runIteration(deps, makeInput(['resolve']));

    expect(result).toEqual({ iterationStatus: 'failed', needsInput: false });
    expect(seen).toHaveLength(1);
    expect(seen[0].iterationStatus).toBe('failed');
  });

  it('A3: abort (cancelled) → колбэк вызван с iterationStatus=failed', async () => {
    const { deps, pi } = makeDeps();
    pi.enqueue(pass('resolve'));
    pi.enqueue(aborted('review'));
    const seen = collect(deps);

    const result = await runIteration(deps, makeInput(['resolve', 'review']));

    expect(result).toEqual({ iterationStatus: 'cancelled', needsInput: false });
    expect(seen).toHaveLength(1);
    expect(seen[0].iterationStatus).toBe('failed');
  });

  it('A4: review→resolve retry, финал needs_input → колбэк НЕ вызывается', async () => {
    const { deps, pi } = makeDeps();
    pi.enqueue(pass('resolve'));
    pi.enqueue(fail('review'));
    pi.enqueue(pass('resolve'));
    pi.enqueue(fail('review'));
    pi.enqueue(pass('resolve'));
    pi.enqueue(fail('review'));
    const seen = collect(deps);

    const result = await runIteration(deps, makeInput(['resolve', 'review']));

    expect(result).toEqual({ iterationStatus: 'failed', needsInput: true });
    expect(seen).toHaveLength(0);
  });

  it('A5: retry→успех не дёргает колбэк дважды — ровно один completed', async () => {
    const { deps, pi } = makeDeps();
    pi.enqueue(pass('resolve'));
    pi.enqueue(fail('review'));
    pi.enqueue(pass('resolve'));
    pi.enqueue(pass('review'));
    const seen = collect(deps);

    const result = await runIteration(deps, makeInput(['resolve', 'review']));

    expect(result).toEqual({ iterationStatus: 'completed', needsInput: false });
    expect(seen).toHaveLength(1);
    expect(seen[0].iterationStatus).toBe('completed');
  });
});