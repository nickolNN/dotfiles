import type { FastifyInstance } from 'fastify';
import type {
  SessionQuestion,
  StepExecutionResult,
  StepReport,
} from '@issue-resolver/shared';
import {
  allSuccessScenario,
  builtinScenario,
  type MockPiScenario,
  type MockPiStep,
  type ScenarioBootstrapMode,
  type ScenarioPipelineStep,
} from '../../e2e/scenarios';
import { FakeGitService } from '../src/git/service';
import type { PiRunCall, PiRunner, PiRunOptions } from '../src/pi/runner';
import type { UiResponsePayload } from '../src/pi/session-registry';
import type { DevOpsFactory } from '../src/workflow/engine';

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const PIPELINE_STEPS: readonly ScenarioPipelineStep[] = [
  'refine',
  'resolve',
  'review',
  'test',
  'pr',
];

function stepFromPrompt(prompt: string): ScenarioPipelineStep {
  const match = /^Pipeline step:\s*([a-z]+)/m.exec(prompt);
  const candidate = match?.[1] as ScenarioPipelineStep | undefined;
  return candidate && PIPELINE_STEPS.includes(candidate) ? candidate : 'resolve';
}

const cloneScenario = (scenario: MockPiScenario): MockPiScenario => ({
  ...scenario,
  steps: scenario.steps.map((step) => ({
    ...step,
    ...(step.questionEvent
      ? {
          questionEvent: {
            ...step.questionEvent,
            ...(step.questionEvent.options
              ? { options: [...step.questionEvent.options] }
              : {}),
          },
        }
      : {}),
  })),
});

export class ScenarioController {
  private scenario: MockPiScenario = cloneScenario(allSuccessScenario);
  private name: string | null = allSuccessScenario.name ?? null;

  current(): { name: string | null; scenario: MockPiScenario } {
    return { name: this.name, scenario: cloneScenario(this.scenario) };
  }

  get steps(): readonly MockPiStep[] {
    return this.scenario.steps;
  }

  get questionTimeoutMs(): number {
    return this.scenario.questionTimeoutMs ?? 15_000;
  }

  get bootstrapMode(): ScenarioBootstrapMode {
    return this.scenario.bootstrap ?? 'success';
  }

  set(scenario: MockPiScenario, name: string | null = null): void {
    this.scenario = cloneScenario(scenario);
    this.name = name;
  }

  reset(): void {
    this.set(allSuccessScenario, allSuccessScenario.name ?? null);
  }
}

export class ScenarioPiRunner implements PiRunner {
  readonly calls: PiRunCall[] = [];
  private readonly cursors = new Map<string, number>();
  private readonly pending = new Map<
    string,
    (payload: UiResponsePayload | null) => void
  >();

  constructor(private readonly controller: ScenarioController) {}

  clearCursors(): void {
    this.cursors.clear();
  }

  async run(
    containerName: string,
    prompt: string,
    options?: PiRunOptions,
  ): Promise<StepExecutionResult> {
    const opts = options ?? {};
    this.calls.push({ containerName, prompt, options });
    const step = stepFromPrompt(prompt);
    const cursorKey = opts.iterationId ?? containerName;
    const cursor = this.cursors.get(cursorKey) ?? 0;
    this.cursors.set(cursorKey, cursor + 1);
    const mock = this.controller.steps[cursor] ?? { type: 'success' };

    this.registerControl(opts);

    if (mock.delayMs && mock.delayMs > 0) {
      await sleep(mock.delayMs);
    }

    if (mock.type === 'timeout') {
      throw new Error(`E2E scenario: step '${step}' timed out`);
    }

    if (mock.type === 'failure') {
      return this.failureResult(step, mock);
    }

    if (mock.type === 'question') {
      return this.questionResult(step, mock, cursorKey, opts);
    }

    return this.successResult(step, mock);
  }

  private registerControl(opts: PiRunOptions): void {
    const { registry, stepRunId, iterationId } = opts;
    if (!registry || !stepRunId || !iterationId) return;
    const key = iterationId;
    registry.register(
      stepRunId,
      iterationId,
      {
        steer: () => undefined,
        abort: () => undefined,
        respond: (payload) => {
          const resolve = this.pending.get(key);
          if (!resolve) return;
          this.pending.delete(key);
          resolve(payload);
        },
        prompt: () => Promise.resolve({ ok: true, disposition: 'started' }),
        send: () => Promise.resolve({ ok: true }),
      },
      opts.agent,
    );
  }

  private async questionResult(
    step: ScenarioPipelineStep,
    mock: MockPiStep,
    cursorKey: string,
    opts: PiRunOptions,
  ): Promise<StepExecutionResult> {
    const prompt = mock.questionEvent ?? { question: 'E2E: нужен ответ' };
    const options = prompt.options ?? [];
    const question: SessionQuestion = {
      id: `e2e-q-${cursorKey}-${Date.now().toString(36)}`,
      method: options.length > 0 ? 'select' : 'input',
      title: prompt.question,
      message: prompt.question,
      ...(options.length > 0 ? { options } : {}),
    };

    const answered = new Promise<UiResponsePayload | null>((resolve) => {
      this.pending.set(cursorKey, resolve);
    });
    opts.onEvent?.({ type: 'question', ...question });

    const answer = await Promise.race([
      answered,
      sleep(this.controller.questionTimeoutMs).then(() => null),
    ]);
    this.pending.delete(cursorKey);

    const answerText = answer
      ? (answer.value ??
        (answer.confirmed === true
          ? 'Да'
          : answer.cancelled
            ? 'Отменено'
            : 'ответ'))
      : 'auto (timeout)';
    opts.onEvent?.({
      type: 'question_answered',
      questionId: question.id,
      answer: answerText,
    });

    return this.successResult(step, mock);
  }

  private successResult(
    step: ScenarioPipelineStep,
    mock: MockPiStep,
  ): StepExecutionResult {
    const report: StepReport = {
      status: 'pass',
      summary: `E2E: ${step} ok`,
      ...(mock.reportData ?? {}),
    } as StepReport;
    return {
      step,
      exitCode: 0,
      report,
      stdout: `E2E scenario: ${step} ok\n`,
      stderr: '',
      events: [{ type: 'text', text: `E2E scenario: ${step} done` }],
      stats: null,
    };
  }

  private failureResult(
    step: ScenarioPipelineStep,
    mock: MockPiStep,
  ): StepExecutionResult {
    const report: StepReport = {
      status: 'fail',
      summary: `E2E: ${step} failed`,
      ...(mock.reportData ?? {}),
    } as StepReport;
    return {
      step,
      exitCode: 1,
      report,
      stdout: '',
      stderr: `E2E scenario: ${step} failed on purpose\n`,
      events: [{ type: 'text', text: `E2E scenario: ${step} failed` }],
      stats: null,
    };
  }
}

export class ScenarioGitService extends FakeGitService {
  constructor(private readonly controller: ScenarioController) {
    super();
  }

  override async installDependencies(repoPaths: string[]): Promise<void> {
    if (this.controller.bootstrapMode === 'failure') {
      throw new Error('E2E scenario: dependency install failed');
    }
    return super.installDependencies(repoPaths);
  }
}

export function createScenarioDevOpsFactory(
  controller: ScenarioController,
  options: { holdMs?: number } = {},
): DevOpsFactory {
  const holdMs = options.holdMs ?? 0;
  return ({ onStdout, onStderr }) => ({
    async runDevOps(_workspaceDir, _repoUrl, repoName) {
      if (holdMs > 0) await sleep(holdMs);
      if (controller.bootstrapMode === 'failure') {
        onStderr?.(`E2E scenario: failed to analyze ${repoName}\n`);
        return {
          success: false,
          instructions: null,
          error: 'E2E scenario: devops failed',
        };
      }
      onStdout?.(`devops ${repoName}\n`);
      onStderr?.(`warning: ${repoName} lockfile missing\n`);
      return {
        success: true,
        instructions: '# E2E\nnpm ci\nnpm start',
      };
    },
  });
}

interface ScenarioRoutesDeps {
  controller: ScenarioController;
  runner: ScenarioPiRunner;
}

export function registerScenarioRoutes(
  app: FastifyInstance,
  { controller, runner }: ScenarioRoutesDeps,
): void {
  app.get('/e2e/scenarios', async () => {
    const { name, scenario } = controller.current();
    return { name, bootstrap: controller.bootstrapMode, steps: scenario.steps };
  });

  app.post('/e2e/scenarios', async (request, reply) => {
    const body = (request.body ?? {}) as {
      scenario?: unknown;
      steps?: unknown;
      bootstrap?: unknown;
      questionTimeoutMs?: unknown;
    };

    let scenario: MockPiScenario | null = null;
    let name: string | null = null;
    if (typeof body.scenario === 'string') {
      try {
        scenario = builtinScenario(body.scenario);
        name = body.scenario;
      } catch (error) {
        return reply
          .status(400)
          .send({ error: error instanceof Error ? error.message : String(error) });
      }
    } else if (Array.isArray(body.steps)) {
      scenario = { steps: body.steps as MockPiStep[] };
    } else {
      return reply
        .status(400)
        .send({ error: 'scenario or steps is required' });
    }

    const bootstrap: ScenarioBootstrapMode =
      body.bootstrap === 'failure'
        ? 'failure'
        : body.bootstrap === 'success'
          ? 'success'
          : (scenario.bootstrap ?? 'success');
    const questionTimeoutMs =
      typeof body.questionTimeoutMs === 'number'
        ? body.questionTimeoutMs
        : scenario.questionTimeoutMs;

    controller.set(
      {
        ...scenario,
        bootstrap,
        ...(questionTimeoutMs !== undefined ? { questionTimeoutMs } : {}),
      },
      name,
    );
    runner.clearCursors();

    return reply.send({
      ok: true,
      scenario: name,
      bootstrap,
      steps: controller.steps.length,
    });
  });

  app.post('/e2e/reset', async () => {
    controller.reset();
    runner.clearCursors();
    return { ok: true, name: allSuccessScenario.name };
  });
}