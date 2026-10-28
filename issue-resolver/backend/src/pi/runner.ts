import type {
  ControlResult,
  PipelineStep,
  PromptMode,
  PromptResult,
  SessionEvent,
  StepExecutionResult,
} from '@issue-resolver/shared';

/** Опции запуска pi-раннера внутри контейнера. */
export interface PiRunOptions {
  model?: string;
  /** Уровень размышления pi (`--thinking`): off|minimal|low|medium|high|xhigh|max. */
  thinkingLevel?: string;
  cwd?: string;
  /** `--tools`: replace the selection with this allowlist. */
  tools?: string[];
  /** `--exclude-tools`: remove from the selection after everything else. */
  excludeTools?: string[];
  timeoutMs?: number;
  /**
   * Pi session id (`--session-id`), see `SessionAddress`. Supplying it makes the
   * agent's own session file carry the id we route logs and control by.
   */
  sessionId?: string;
  /** `--session-dir`: where this session's file is stored (see issueSessionDir). */
  sessionDir?: string;
  /** `--append-system-prompt`: contract text that must survive compaction. */
  systemAppend?: string;
  /** `--name`: human-readable session name for listings. */
  sessionName?: string;
  /** id прогона шага: адрес живой сессии в реестре. */
  stepRunId?: string;
  /** id итерации: адрес живой сессии по итерации. */
  iterationId?: string;
  /** id задачи (issue): комната агента → `issue-<issueId>`. */
  issueId?: string;
  /** Реестр живых сессий для steer/abort. */
  registry?: import('../pi/session-registry').StepSessionRegistry;
  /** Дескриптор агента комнаты (worker/coordinator) для `listAgents`. */
  agent?: import('../pi/session-registry').RoomAgentInfo;
  /** Колбэк живого stdout (delta-стрим шага). */
  onStdout?: (chunk: string) => void;
  /** Колбэк живого stderr. */
  onStderr?: (chunk: string) => void;
  /** Колбэк живых структурированных событий сессии (текст/tool_use/tool_result). */
  onEvent?: (event: SessionEvent) => void;
}

/** Узкий порт запуска pi-агента; позволяет подменять реальный CLI фейком. */
export interface PiRunner {
  run(
    containerName: string,
    prompt: string,
    options?: PiRunOptions,
  ): Promise<StepExecutionResult>;
}

/** Зафиксированный вызов раннера (для assert'ов в тестах). */
export interface PiRunCall {
  containerName: string;
  prompt: string;
  options?: PiRunOptions;
}

/** Зафиксированный вызов управления живой сессией (для assert'ов в тестах). */
export interface PiControlCall {
  kind: 'steer' | 'abort' | 'respond' | 'prompt' | 'send';
  stepRunId: string;
  text?: string;
  mode?: PromptMode;
  command?: Record<string, unknown>;
  payload?: import('./session-registry').UiResponsePayload;
}

const DEFAULT_STEP: PipelineStep = 'resolve';

/** Демо-события FakePiRunner: проза + один вызов инструмента и его результат. */
const DEMO_EVENTS: SessionEvent[] = [
  { type: 'text', text: 'demo: analyzing the task' },
  {
    type: 'tool_use',
    toolCallId: 'demo-tool-1',
    toolName: 'bash',
    args: { command: 'pwd' },
  },
  {
    type: 'tool_result',
    toolCallId: 'demo-tool-1',
    toolName: 'bash',
    isError: false,
    durationMs: 12,
    resultText: '/workspace',
  },
];

const defaultSuccess = (): StepExecutionResult => ({
  step: DEFAULT_STEP,
  exitCode: 0,
  report: { status: 'pass', summary: 'ok' },
  stdout: '',
  stderr: '',
});

/**
 * Детерминированный фейк PiRunner для юнит-тестов контроллера/движка.
 *
 * Результаты отдаются из очереди replayQueue в порядке enqueue (shift).
 * Когда очередь пуста — возвращается успешный результат по умолчанию.
 * Каждый вызов записывается в `calls`; команды управления живой сессией,
 * полученные через registry, — в `controlCalls`.
 */
export class FakePiRunner implements PiRunner {
  readonly calls: PiRunCall[] = [];
  readonly controlCalls: PiControlCall[] = [];
  private readonly replayQueue: StepExecutionResult[] = [];

  /** Кладёт результат, который вернёт следующий run(). */
  enqueue(result: StepExecutionResult): void {
    this.replayQueue.push(result);
  }

  run(
    containerName: string,
    prompt: string,
    options?: PiRunOptions,
  ): Promise<StepExecutionResult> {
    this.calls.push({ containerName, prompt, options });
    const result = this.replayQueue.shift() ?? defaultSuccess();
    const opts = options ?? {};

    if (result.stdout) opts.onStdout?.(result.stdout);
    if (result.stderr) opts.onStderr?.(result.stderr);

    // Демо-события сессии: дают тестам/движку непустой events без pi.
    if (!result.events) result.events = DEMO_EVENTS;
    for (const event of result.events) opts.onEvent?.(event);

    const { registry, stepRunId, iterationId } = opts;
    // Как и в RpcPiRunner: прогоны без итерации (отчёт) группируются под их
    // собственным stepRunId — control-роут находит их по тому же адресу.
    if (registry && stepRunId) {
      registry.register(stepRunId, iterationId ?? stepRunId, {
        steer: (text) =>
          this.controlCalls.push({ kind: 'steer', stepRunId, text }),
        abort: () => this.controlCalls.push({ kind: 'abort', stepRunId }),
        respond: (payload) =>
          this.controlCalls.push({ kind: 'respond', stepRunId, payload }),
        prompt: (message, mode): Promise<PromptResult> => {
          this.controlCalls.push({
            kind: 'prompt',
            stepRunId,
            text: message,
            ...(mode ? { mode } : {}),
          });
          return Promise.resolve({ ok: true, disposition: 'started' });
        },
        send: (command): Promise<ControlResult> => {
          this.controlCalls.push({ kind: 'send', stepRunId, command });
          return Promise.resolve({ ok: true });
        },
      }, opts.agent);
    }

    return Promise.resolve(result);
  }
}