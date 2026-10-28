import type {
  ControlResult,
  PipelineStep,
  PromptMode,
  PromptResult,
  SessionEvent,
  StepExecutionResult,
} from '@issue-resolver/shared';

export interface PiRunOptions {
  model?: string;
  thinkingLevel?: string;
  cwd?: string;
  tools?: string[];
  excludeTools?: string[];
  timeoutMs?: number;
  sessionId?: string;
  sessionDir?: string;
  systemAppend?: string;
  sessionName?: string;
  stepRunId?: string;
  iterationId?: string;
  issueId?: string;
  registry?: import('../pi/session-registry').StepSessionRegistry;
  agent?: import('../pi/session-registry').RoomAgentInfo;
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
  onEvent?: (event: SessionEvent) => void;
}

export interface PiRunner {
  run(
    containerName: string,
    prompt: string,
    options?: PiRunOptions,
  ): Promise<StepExecutionResult>;
}

export interface PiRunCall {
  containerName: string;
  prompt: string;
  options?: PiRunOptions;
}

export interface PiControlCall {
  kind: 'steer' | 'abort' | 'respond' | 'prompt' | 'send';
  stepRunId: string;
  text?: string;
  mode?: PromptMode;
  command?: Record<string, unknown>;
  payload?: import('./session-registry').UiResponsePayload;
}

const DEFAULT_STEP: PipelineStep = 'resolve';

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

export class FakePiRunner implements PiRunner {
  readonly calls: PiRunCall[] = [];
  readonly controlCalls: PiControlCall[] = [];
  private readonly replayQueue: StepExecutionResult[] = [];

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

    if (!result.events) result.events = DEMO_EVENTS;
    for (const event of result.events) opts.onEvent?.(event);

    const { registry, stepRunId, iterationId } = opts;
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