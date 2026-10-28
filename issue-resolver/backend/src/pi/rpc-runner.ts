import { spawn } from 'node:child_process';
import {
  parseSessionStats,
  type CompactionReason,
  type ControlResult,
  type PipelineStep,
  type PromptMode,
  type PromptResult,
  type SessionCost,
  type SessionEvent,
  type SessionQuestion,
  type SessionSpeed,
  type SessionStats,
  type SessionUsage,
  type StepExecutionResult,
  type StepReport,
  isValidPiSessionId,
} from '@issue-resolver/shared';
import type { PiRunOptions, PiRunner } from './runner';
import type { RoomAgentStatus, UiResponsePayload } from './session-registry';

interface RpcAssistantMessageEvent {
  type?: string;
  contentIndex?: number;
  delta?: unknown;
  content?: unknown;
  id?: unknown;
  toolName?: unknown;
  toolCall?: unknown;
}

interface RpcEvent {
  type?: string;
  aborted?: boolean;
  assistantMessageEvent?: RpcAssistantMessageEvent;
  toolCallId?: string;
  toolName?: string;
  args?: unknown;
  result?: unknown;
  partialResult?: unknown;
  isError?: boolean;
  durationMs?: number;
  willRetry?: boolean;
  usage?: unknown;
  command?: string;
  id?: string;
  data?: unknown;
  success?: boolean;
  error?: unknown;
  method?: string;
  title?: string;
  message?: unknown;
  options?: string[];
  placeholder?: string;
  prefill?: string;
  notifyType?: unknown;
  statusKey?: unknown;
  statusText?: unknown;
  widgetKey?: unknown;
  widgetLines?: unknown;
  widgetPlacement?: unknown;
  text?: unknown;
  reason?: unknown;
  errorMessage?: unknown;
  source?: unknown;
  attempt?: unknown;
  maxAttempts?: unknown;
  delayMs?: unknown;
  finalError?: unknown;
  steering?: unknown;
  followUp?: unknown;
  level?: unknown;
  name?: unknown;
  delta?: unknown;
}

const DIALOG_METHODS = new Set<SessionQuestion['method']>([
  'select',
  'confirm',
  'input',
  'editor',
]);

export interface RpcParseHandlers {
  onStdout?: (chunk: string) => void;
  onEvent?: (event: SessionEvent) => void;
  onStats?: (stats: SessionStats) => void;
}

const num = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : 0;

const normalizeUsage = (raw: Record<string, unknown>): SessionUsage => {
  const input = num(raw.input);
  const output = num(raw.output);
  const cacheRead = num(raw.cacheRead);
  const cacheWrite = num(raw.cacheWrite);
  const total =
    num(raw.totalTokens) || input + output + cacheRead + cacheWrite;
  return { input, output, cacheRead, cacheWrite, total };
};

const normalizeCost = (raw: unknown): SessionCost | null => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  return {
    input: num(obj.input),
    output: num(obj.output),
    cacheRead: num(obj.cacheRead),
    cacheWrite: num(obj.cacheWrite),
    total: num(obj.total),
  };
};

const SPEED_MIN_ELAPSED_MS = 1000;
const SPEED_MIN_INTERVAL_MS = 250;
const SPEED_SMOOTHING_ALPHA = 0.3;

const numberOrNull = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

const stringOrNull = (value: unknown): string | null =>
  typeof value === 'string' ? value : null;

const stringArray = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const COMPACTION_REASONS: ReadonlySet<string> = new Set([
  'manual',
  'threshold',
  'overflow',
]);

const compactionReason = (value: unknown): CompactionReason =>
  typeof value === 'string' && COMPACTION_REASONS.has(value)
    ? (value as CompactionReason)
    : 'manual';

const questionAnswerText = (payload: UiResponsePayload): string => {
  if (payload.value !== undefined) return payload.value;
  if (payload.confirmed !== undefined) return payload.confirmed ? 'Да' : 'Нет';
  if (payload.cancelled === true) return 'Отменено';
  return '';
};

const agentStatusFor = (result: StepExecutionResult): RoomAgentStatus => {
  if (result.aborted) return 'aborted';
  return result.exitCode !== 0 ? 'failed' : 'finished';
};

const toolResultText = (result: unknown): string => {
  if (result && typeof result === 'object') {
    const content = (result as { content?: unknown }).content;
    if (Array.isArray(content)) {
      const text = content
        .map((part) =>
          part && typeof part === 'object' &&
          typeof (part as { text?: unknown }).text === 'string'
            ? (part as { text: string }).text
            : '',
        )
        .join('');
      if (text.length > 0) return text;
    }
    const structured = (result as { structuredContent?: unknown })
      .structuredContent;
    if (structured !== undefined) return JSON.stringify(structured);
  }
  return '';
};

export class RpcSessionParser {
  private readonly handler: RpcParseHandlers;
  private readonly textByIndex = new Map<number, string>();
  private readonly textOrder: number[] = [];
  private readonly emittedText = new Set<number>();
  private readonly thinkingByIndex = new Map<number, string>();
  private readonly thinkingOrder: number[] = [];
  private readonly emittedThinking = new Set<number>();
  private readonly collected: SessionEvent[] = [];
  private statsValue: SessionStats | null = null;
  private modelValue: string | null = null;
  private lastUsageTotal: number | null = null;
  private sessionStartMs: number | null = null;
  private speedSample: { output: number; tsMs: number } | null = null;
  private smoothedTps: number | null = null;

  constructor(handler: RpcParseHandlers = {}) {
    this.handler = handler;
  }

  stdout(): string {
    return this.textOrder
      .map((index) => this.textByIndex.get(index) ?? '')
      .join('');
  }

  events(): SessionEvent[] {
    return this.collected;
  }

  recordQuestionAnswered(questionId: string, answer: string): void {
    this.push({ type: 'question_answered', questionId, answer });
  }

  stats(): SessionStats | null {
    return this.statsValue;
  }

  handle(event: RpcEvent): void {
    if (
      event.type === 'extension_ui_request' &&
      typeof event.id === 'string' &&
      typeof event.method === 'string' &&
      DIALOG_METHODS.has(event.method as SessionQuestion['method'])
    ) {
      this.push({
        type: 'question',
        id: event.id,
        method: event.method as SessionQuestion['method'],
        title: typeof event.title === 'string' ? event.title : '',
        ...(typeof event.message === 'string' ? { message: event.message } : {}),
        ...(Array.isArray(event.options)
          ? {
              options: event.options.filter(
                (option): option is string => typeof option === 'string',
              ),
            }
          : {}),
        ...(typeof event.placeholder === 'string'
          ? { placeholder: event.placeholder }
          : {}),
        ...(typeof event.prefill === 'string' ? { prefill: event.prefill } : {}),
      });
      return;
    }

    if (event.type === 'extension_ui_request' && typeof event.method === 'string') {
      if (event.method === 'notify') {
        this.push({
          type: 'notice',
          level:
            event.notifyType === 'warning' || event.notifyType === 'error'
              ? event.notifyType
              : 'info',
          message: typeof event.message === 'string' ? event.message : '',
        });
        return;
      }
      if (event.method === 'setStatus') {
        this.push({
          type: 'status',
          key: typeof event.statusKey === 'string' ? event.statusKey : '',
          text: stringOrNull(event.statusText),
        });
        return;
      }
      if (event.method === 'setWidget') {
        const lines = event.widgetLines;
        this.push({
          type: 'widget',
          key: typeof event.widgetKey === 'string' ? event.widgetKey : '',
          lines:
            Array.isArray(lines) && lines.every((line) => typeof line === 'string')
              ? (lines as string[])
              : null,
          placement:
            event.widgetPlacement === 'belowEditor'
              ? 'belowEditor'
              : 'aboveEditor',
        });
        return;
      }
      if (event.method === 'setTitle') {
        this.push({
          type: 'title',
          title: typeof event.title === 'string' ? event.title : '',
        });
        return;
      }
      if (event.method === 'set_editor_text') {
        this.push({
          type: 'editor_text',
          text: typeof event.text === 'string' ? event.text : '',
        });
        return;
      }
    }

    if (event.command !== undefined) {
      if (event.command === 'get_state') {
        this.captureModel(event.data);
        return;
      }
      if (event.command === 'get_session_stats') {
        const stats = parseSessionStats(event.data, this.modelValue);
        if (stats) {
          const withSpeed = this.withStatsSpeed(stats, Date.now());
          this.statsValue = withSpeed;
          this.push({ type: 'stats', stats: withSpeed });
          this.handler.onStats?.(withSpeed);
        }
      }
      return;
    }

    if (event.type === 'message_start') {
      const role = asRecord(event.message)?.role;
      if (typeof role === 'string' && role !== 'assistant') return;
      this.markSessionStart();
      this.flush();
      this.textByIndex.clear();
      this.textOrder.length = 0;
      this.emittedText.clear();
      this.thinkingByIndex.clear();
      this.thinkingOrder.length = 0;
      this.emittedThinking.clear();
      return;
    }

    if (event.type === 'message_update') {
      this.handleUsage(event.usage);
      this.handleAssistantMessage(event.assistantMessageEvent);
      return;
    }

    if (event.type === 'message_end') {
      const message = asRecord(event.message);
      if (message?.role === 'assistant' && message.stopReason === 'length') {
        this.flush();
        this.push({
          type: 'notice',
          level: 'warning',
          message:
            'ответ оборван лимитом вывода модели (maxTokens) — ход закончился без tool-call',
        });
      }
      return;
    }

    if (event.type === 'tool_execution_start') {
      this.push({
        type: 'tool_use',
        toolCallId: String(event.toolCallId ?? ''),
        toolName: String(event.toolName ?? ''),
        args: event.args ?? null,
      });
      return;
    }

    if (event.type === 'tool_execution_end') {
      this.push({
        type: 'tool_result',
        toolCallId: String(event.toolCallId ?? ''),
        toolName: String(event.toolName ?? ''),
        isError: event.isError === true,
        durationMs:
          typeof event.durationMs === 'number' ? event.durationMs : null,
        resultText: toolResultText(event.result),
      });
      return;
    }

    if (event.type === 'tool_execution_update') {
      this.push({
        type: 'tool_update',
        toolCallId: String(event.toolCallId ?? ''),
        toolName: String(event.toolName ?? ''),
        partialText: toolResultText(event.partialResult),
      });
      return;
    }

    if (event.type === 'compaction_start') {
      this.push({
        type: 'compaction_start',
        reason: compactionReason(event.reason),
      });
      return;
    }

    if (event.type === 'compaction_end') {
      const result = asRecord(event.result);
      this.push({
        type: 'compaction_end',
        reason: compactionReason(event.reason),
        summary: stringOrNull(result?.summary),
        aborted: event.aborted === true,
        willRetry: event.willRetry === true,
        errorMessage: stringOrNull(event.errorMessage),
        tokensBefore: numberOrNull(result?.tokensBefore),
        estimatedTokensAfter: numberOrNull(result?.estimatedTokensAfter),
      });
      return;
    }

    if (event.type === 'auto_retry_start') {
      this.push({
        type: 'retry_start',
        kind: 'auto',
        attempt: numberOrNull(event.attempt),
        maxAttempts: numberOrNull(event.maxAttempts),
        delayMs: numberOrNull(event.delayMs),
        errorMessage: stringOrNull(event.errorMessage),
        source: null,
        reason: null,
      });
      return;
    }

    if (event.type === 'auto_retry_end') {
      this.push({
        type: 'retry_end',
        kind: 'auto',
        success: typeof event.success === 'boolean' ? event.success : null,
        attempt: numberOrNull(event.attempt),
        finalError: stringOrNull(event.finalError),
      });
      return;
    }

    if (event.type === 'summarization_retry_scheduled') {
      this.push({
        type: 'retry_start',
        kind: 'summarization',
        attempt: numberOrNull(event.attempt),
        maxAttempts: numberOrNull(event.maxAttempts),
        delayMs: numberOrNull(event.delayMs),
        errorMessage: stringOrNull(event.errorMessage),
        source: null,
        reason: null,
      });
      return;
    }

    if (event.type === 'summarization_retry_finished') {
      this.push({
        type: 'retry_end',
        kind: 'summarization',
        success: null,
        attempt: null,
        finalError: null,
      });
      return;
    }

    if (event.type === 'queue_update') {
      this.push({
        type: 'queue',
        steering: stringArray(event.steering),
        followUp: stringArray(event.followUp),
      });
      return;
    }

    if (event.type === 'thinking_level_changed') {
      this.push({
        type: 'thinking_level',
        level: typeof event.level === 'string' ? event.level : '',
      });
      return;
    }

    if (event.type === 'session_info_changed') {
      this.push({
        type: 'session_info',
        name: stringOrNull(event.name),
      });
      return;
    }

    if (event.type === 'extension_error') {
      this.push({ type: 'extension_error', message: String(event.error) });
      return;
    }

    if (event.type === 'error') {
      this.push({
        type: 'notice',
        level: 'error',
        message: errorEventMessage(event),
      });
      return;
    }

    if (event.type === 'bash_execution_update') {
      this.push({
        type: 'bash',
        delta: typeof event.delta === 'string' ? event.delta : '',
      });
    }
  }

  private captureModel(data: unknown): void {
    if (!data || typeof data !== 'object' || Array.isArray(data)) return;
    const model = (data as Record<string, unknown>).model;
    if (!model || typeof model !== 'object' || Array.isArray(model)) return;
    const obj = model as Record<string, unknown>;
    let label: string | null = null;
    if (typeof obj.name === 'string' && obj.name.trim().length > 0) {
      label = obj.name;
    } else if (typeof obj.id === 'string' && obj.id.trim().length > 0) {
      label = obj.id;
    }
    if (label !== null) this.modelValue = label;
  }

  flush(): void {
    for (const index of this.textOrder) {
      if (!this.emittedText.has(index)) {
        this.emitText(index);
      }
    }
    for (const index of this.thinkingOrder) {
      if (!this.emittedThinking.has(index)) {
        this.emitThinking(index);
      }
    }
  }

  private handleAssistantMessage(message?: RpcAssistantMessageEvent): void {
    if (!message) return;

    if (message.type === 'text_delta') {
      if (typeof message.delta !== 'string' || message.delta.length === 0) {
        return;
      }
      const index = this.index(message);
      if (!this.textByIndex.has(index)) {
        this.textByIndex.set(index, '');
        this.textOrder.push(index);
      }
      const partialText = `${this.textByIndex.get(index) ?? ''}${message.delta}`;
      this.textByIndex.set(index, partialText);
      this.handler.onEvent?.({
        type: 'text_update',
        contentIndex: index,
        partialText,
      });
      return;
    }

    if (message.type === 'text_end') {
      const index = this.index(message);
      if (typeof message.content === 'string') {
        if (!this.textByIndex.has(index)) this.textOrder.push(index);
        this.textByIndex.set(index, message.content);
      }
      this.emitText(index);
      return;
    }

    if (message.type === 'thinking_delta') {
      if (typeof message.delta !== 'string' || message.delta.length === 0) {
        return;
      }
      const index = this.index(message);
      if (!this.thinkingByIndex.has(index)) {
        this.thinkingByIndex.set(index, '');
        this.thinkingOrder.push(index);
      }
      const partialText = `${this.thinkingByIndex.get(index) ?? ''}${message.delta}`;
      this.thinkingByIndex.set(index, partialText);
      this.handler.onEvent?.({
        type: 'thinking_update',
        contentIndex: index,
        partialText,
      });
      return;
    }

    if (message.type === 'thinking_end') {
      const index = this.index(message);
      const text = this.thinkingText(message.content);
      if (text !== null) {
        if (!this.thinkingByIndex.has(index)) this.thinkingOrder.push(index);
        this.thinkingByIndex.set(index, text);
      }
      this.emitThinking(index);
    }
  }

  private markSessionStart(now: number = Date.now()): void {
    if (this.sessionStartMs === null) this.sessionStartMs = now;
  }

  private handleUsage(raw: unknown): void {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return;
    const obj = raw as Record<string, unknown>;
    const usage = normalizeUsage(obj);
    const now = Date.now();
    this.markSessionStart(now);
    if (this.lastUsageTotal === usage.total) return;
    this.lastUsageTotal = usage.total;
    const speed = this.computeSpeed(usage, now);
    this.push({
      type: 'usage',
      usage,
      cost: normalizeCost(obj.cost),
      ...(speed ? { speed } : {}),
    });
  }

  private computeSpeed(usage: SessionUsage, now: number): SessionSpeed | null {
    if (this.sessionStartMs === null) return null;

    const sample = this.speedSample;
    if (sample === null) {
      this.speedSample = { output: usage.output, tsMs: now };
    } else if (
      usage.output > sample.output &&
      now - sample.tsMs >= SPEED_MIN_INTERVAL_MS
    ) {
      const deltaSec = (now - sample.tsMs) / 1000;
      const tps = (usage.output - sample.output) / deltaSec;
      this.smoothedTps =
        this.smoothedTps === null
          ? tps
          : this.smoothedTps +
            SPEED_SMOOTHING_ALPHA * (tps - this.smoothedTps);
      this.speedSample = { output: usage.output, tsMs: now };
    }

    const elapsedMs = now - this.sessionStartMs;
    if (elapsedMs < SPEED_MIN_ELAPSED_MS || usage.output <= 0) return null;
    const avg = usage.output / (elapsedMs / 1000);
    return { tokensPerSecond: this.smoothedTps ?? avg, avgTokensPerSecond: avg };
  }

  private withStatsSpeed(stats: SessionStats, now: number): SessionStats {
    if (this.sessionStartMs === null) return stats;
    const elapsedMs = now - this.sessionStartMs;
    if (elapsedMs < SPEED_MIN_ELAPSED_MS || stats.tokens.output <= 0) {
      return stats;
    }
    return {
      ...stats,
      avgTokensPerSecond: stats.tokens.output / (elapsedMs / 1000),
    };
  }

  private thinkingText(content: unknown): string | null {
    if (typeof content === 'string') return content;
    if (content && typeof content === 'object') {
      const thinking = (content as { thinking?: unknown }).thinking;
      if (typeof thinking === 'string') return thinking;
    }
    return null;
  }

  private emitThinking(index: number): void {
    if (this.emittedThinking.has(index)) return;
    this.emittedThinking.add(index);
    const thinking = this.thinkingByIndex.get(index) ?? '';
    if (thinking.length === 0) return;
    this.push({ type: 'thinking', thinking });
  }

  private index(message: RpcAssistantMessageEvent): number {
    return typeof message.contentIndex === 'number' ? message.contentIndex : 0;
  }

  private emitText(index: number): void {
    if (this.emittedText.has(index)) return;
    this.emittedText.add(index);
    const text = this.textByIndex.get(index) ?? '';
    if (text.length === 0) return;
    this.push({ type: 'text', text });
  }

  private push(event: SessionEvent): void {
    this.collected.push(event);
    this.handler.onEvent?.(event);
  }
}

const PROMPT_COMMAND_ID = 'step-1';

function isTruthy(value: string | undefined): boolean {
  return ['1', 'true', 'yes'].includes(value?.trim().toLowerCase() ?? '');
}

function errorEventMessage(event: RpcEvent): string {
  const record = asRecord(event);
  const candidates = ['message', 'error', 'reason', 'detail'];
  for (const key of candidates) {
    const value = record?.[key];
    if (typeof value === 'string' && value.trim().length > 0) return value;
    if (value instanceof Error) return value.message;
  }
  return 'pi reported an error';
}

const STATS_TIMEOUT_MS = 2000;

const STATS_POLL_MS = 3000;

const LAUNCHER_ENV_KEYS = [
  'PI_SESSION_FILE',
  'PI_SESSION_ID',
  'PI_SESSION_NAME',
  'PI_MODEL',
  'PI_PROVIDER',
  'PI_AGENT_ROOM',
] as const;

export function stepAgentEnv(
  base: NodeJS.ProcessEnv,
  room?: string,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  for (const key of LAUNCHER_ENV_KEYS) delete env[key];
  if (room) env.PI_AGENT_ROOM = room;
  env.PI_OFFLINE = '1';
  env.PI_SKIP_VERSION_CHECK = '1';
  env.PI_TELEMETRY = '0';
  return env;
}

export interface RpcPiRunnerConfig {
  piCommand?: string;
  piArgs?: string[];
}

export class RpcPiRunner implements PiRunner {
  private readonly piCommand: string;
  private readonly piArgs: string[];

  constructor(
    private readonly step: PipelineStep = 'resolve',
    private readonly transport: 'docker' | 'local' = 'docker',
    config: RpcPiRunnerConfig = {},
  ) {
    this.piCommand = config.piCommand ?? process.env.PI_BIN ?? 'pi';
    this.piArgs = config.piArgs ?? [];
  }

  run(
    containerName: string,
    prompt: string,
    options: PiRunOptions = {},
  ): Promise<StepExecutionResult> {
    const modelArgs = options.model ? ['--model', options.model] : [];
    const thinkingArgs = options.thinkingLevel
      ? ['--thinking', options.thinkingLevel]
      : [];
    const sessionId = options.sessionId ?? options.stepRunId;
    if (sessionId !== undefined && !isValidPiSessionId(sessionId)) {
      throw new Error(`invalid Pi session id: ${JSON.stringify(sessionId)}`);
    }
    const sessionArgs = sessionId ? ['--session-id', sessionId] : [];
    const sessionDirArgs = options.sessionDir
      ? ['--session-dir', options.sessionDir]
      : [];
    const sessionNameArgs = options.sessionName
      ? ['--name', options.sessionName]
      : [];
    const systemAppendArgs = options.systemAppend
      ? ['--append-system-prompt', options.systemAppend]
      : [];
    const verboseFlags = isTruthy(process.env.ISSUE_RESOLVER_AGENT_VERBOSE)
      ? ['--verbose']
      : [];
    const toolFlags = [
      ...(options.tools?.length ? ['--tools', options.tools.join(',')] : []),
      ...(options.excludeTools?.length
        ? ['--exclude-tools', options.excludeTools.join(',')]
        : []),
    ];
    const sessionFlags = [
      ...sessionArgs,
      ...sessionDirArgs,
      ...sessionNameArgs,
      ...systemAppendArgs,
      ...toolFlags,
      ...verboseFlags,
    ];
    const room = options.issueId ? `issue-${options.issueId}` : undefined;

    return new Promise<StepExecutionResult>((resolve, reject) => {
      const child =
        this.transport === 'local'
          ? spawn(
              this.piCommand,
              [
                ...this.piArgs,
                '--mode',
                'rpc',
                ...sessionFlags,
                ...modelArgs,
                ...thinkingArgs,
              ],
              {
                cwd: options.cwd,
                stdio: ['pipe', 'pipe', 'pipe'],
                env: stepAgentEnv(process.env, room),
              },
            )
          : spawn(
              'docker',
              [
                'exec',
                '-i',
                ...(options.cwd ? ['-w', options.cwd] : []),
                ...(room ? ['-e', `PI_AGENT_ROOM=${room}`] : []),
                containerName,
                this.piCommand,
                ...this.piArgs,
                '--mode',
                'rpc',
                ...sessionFlags,
                ...modelArgs,
                ...thinkingArgs,
              ],
              { stdio: ['pipe', 'pipe', 'pipe'] },
            );

      const { registry, stepRunId, iterationId } = options;
      let statsHandler: (() => void) | undefined;
      const parser = new RpcSessionParser({
        onStdout: options.onStdout,
        onEvent: (event) => {
          options.onEvent?.(event);
          if (registry && stepRunId) registry.recordEvent(stepRunId, event);
        },
        onStats: () => statsHandler?.(),
      });
      let stderr = '';
      let buffer = '';
      let settled = false;
      let committedAbort = false;
      let timer: NodeJS.Timeout | undefined;
      let statsTimer: NodeJS.Timeout | undefined;
      let statsPollTimer: NodeJS.Timeout | undefined;
      let pendingResult: StepExecutionResult | null = null;
      let statsRequested = false;
      const pending = new Map<
        string,
        { resolve: (result: ControlResult) => void; timer: NodeJS.Timeout }
      >();
      let requestSeq = 0;

      const cleanup = (status: RoomAgentStatus = 'finished') => {
        if (timer) clearTimeout(timer);
        if (statsTimer) clearTimeout(statsTimer);
        if (statsPollTimer) clearInterval(statsPollTimer);
        for (const entry of pending.values()) {
          clearTimeout(entry.timer);
          entry.resolve({ ok: false, error: 'session closed' });
        }
        pending.clear();
        if (registry && stepRunId) registry.unregister(stepRunId, status);
      };

      const finish = (result: StepExecutionResult) => {
        if (settled) return;
        settled = true;
        parser.flush();
        const finalResult: StepExecutionResult = {
          ...result,
          stdout: parser.stdout(),
          events: parser.events(),
        };
        cleanup(agentStatusFor(result));
        try {
          if (child.stdin?.writable) {
            child.stdin.write(`${JSON.stringify({ type: 'exit' })}\n`);
          }
        } catch {
        }
        if (!child.killed) child.kill('SIGTERM');
        resolve(finalResult);
      };

      const writeCommand = (command: Record<string, unknown>): boolean => {
        if (!child.stdin?.writable) return false;
        try {
          child.stdin.write(`${JSON.stringify(command)}\n`);
          return true;
        } catch {
          return false;
        }
      };

      const sendCommand = (
        command: Record<string, unknown>,
        timeoutMs = 10000,
      ): Promise<ControlResult> => {
        const id = `ctl-${++requestSeq}`;
        return new Promise<ControlResult>((resolveCommand) => {
          if (!child.stdin?.writable) {
            resolveCommand({ ok: false, error: 'session closed' });
            return;
          }
          const entryTimer = setTimeout(() => {
            pending.delete(id);
            resolveCommand({ ok: false, error: 'timeout' });
          }, timeoutMs);
          pending.set(id, { resolve: resolveCommand, timer: entryTimer });
          try {
            child.stdin.write(`${JSON.stringify({ id, ...command })}\n`);
          } catch {
            clearTimeout(entryTimer);
            pending.delete(id);
            resolveCommand({ ok: false, error: 'write failed' });
          }
        });
      };

      const finalizeWithStats = () => {
        if (settled || pendingResult === null) return;
        const result = pendingResult;
        pendingResult = null;
        if (statsTimer) {
          clearTimeout(statsTimer);
          statsTimer = undefined;
        }
        finish({ ...result, stats: parser.stats() ?? null });
      };

      const requestStatsThenFinish = (result: StepExecutionResult) => {
        if (statsRequested || settled) return;
        statsRequested = true;
        pendingResult = result;
        statsHandler = finalizeWithStats;
        writeCommand({ type: 'get_state' });
        if (!writeCommand({ type: 'get_session_stats' })) {
          finalizeWithStats();
          return;
        }
        statsTimer = setTimeout(finalizeWithStats, STATS_TIMEOUT_MS);
      };

      if (registry && stepRunId) {
        registry.register(stepRunId, iterationId ?? stepRunId, {
          steer: (text) => writeCommand({ type: 'steer', message: text }),
          abort: () => {
            committedAbort = true;
            writeCommand({ type: 'abort' });
            child.kill('SIGKILL');
          },
          respond: (payload) => {
            parser.recordQuestionAnswered(
              payload.id,
              questionAnswerText(payload),
            );
            return writeCommand({ type: 'extension_ui_response', ...payload });
          },
          prompt: (message, mode) =>
            sendCommand({
              type: 'prompt',
              message,
              ...(mode ? { streamingBehavior: mode } : {}),
            }).then((result): PromptResult => {
              const disposition = asRecord(result.data)?.disposition;
              const normalized =
                disposition === 'started' ||
                disposition === 'queued' ||
                disposition === 'handled'
                  ? disposition
                  : 'started';
              return { ok: result.ok, disposition: normalized };
            }),
          send: (command) => sendCommand(command),
        }, options.agent);
      }

      statsPollTimer = setInterval(() => {
        if (settled) return;
        writeCommand({ type: 'get_session_stats' });
      }, STATS_POLL_MS);

      if (options.timeoutMs && options.timeoutMs > 0) {
        timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          cleanup('failed');
          child.kill('SIGKILL');
          reject(
            new Error(
              `pi run timed out after ${options.timeoutMs}ms in ${containerName}`,
            ),
          );
        }, options.timeoutMs);
      }

      const handleLine = (raw: string) => {
        const line = raw.replace(/\r$/, '');
        if (line.trim().length === 0) return;

        let event: RpcEvent;
        try {
          event = JSON.parse(line) as RpcEvent;
        } catch {
          return;
        }

        if (event.type === 'agent_settled') {
          requestStatsThenFinish(this.resultFor(event.aborted === true, stderr));
          return;
        }

        if (
          event.type === 'response' &&
          event.command === 'prompt' &&
          asRecord(event.data)?.disposition === 'handled'
        ) {
          requestStatsThenFinish(this.resultFor(false, stderr));
          return;
        }

        if (event.type === 'response' && typeof event.id === 'string') {
          const pendingEntry = pending.get(event.id);
          if (pendingEntry) {
            pending.delete(event.id);
            clearTimeout(pendingEntry.timer);
            const { data } = event;
            pendingEntry.resolve(
              event.success === false
                ? {
                    ok: false,
                    error:
                      typeof event.error === 'string'
                        ? event.error
                        : 'command failed',
                    ...(data !== undefined ? { data } : {}),
                  }
                : { ok: true, ...(data !== undefined ? { data } : {}) },
            );
            return;
          }
        }

        parser.handle(event);
      };

      child.stdout?.on('data', (chunk: Buffer) => {
        buffer += chunk.toString('utf8');
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) handleLine(line);
      });

      child.stderr?.on('data', (chunk: Buffer) => {
        const text = chunk.toString();
        stderr += text;
        options.onStderr?.(text);
      });

      child.on('error', (error) => {
        if (settled) return;
        settled = true;
        cleanup('failed');
        reject(error);
      });

      child.on('close', (code) => {
        if (settled) return;
        if (committedAbort) {
          requestStatsThenFinish(this.resultFor(true, stderr));
          return;
        }
        requestStatsThenFinish({
          step: this.step,
          exitCode: code ?? 1,
          report: null,
          stdout: '',
          stderr,
        });
      });

      child.on('end', () => {
        if (buffer.length > 0) {
          handleLine(buffer);
          buffer = '';
        }
      });

      writeCommand({
        id: PROMPT_COMMAND_ID,
        type: 'prompt',
        message: prompt,
      });
      writeCommand({ type: 'get_state' });
    });
  }

  private resultFor(aborted: boolean, stderr: string): StepExecutionResult {
    const report: StepReport | null = aborted
      ? { status: 'fail', summary: 'aborted' }
      : null;
    return {
      step: this.step,
      exitCode: aborted ? 1 : 0,
      report,
      stdout: '',
      stderr,
      ...(aborted ? { aborted: true } : {}),
    };
  }
}