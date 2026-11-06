import {
  StepAgentStatus,
  StepReportStatus,
  num,
  CompactionReason,
  type SessionCost,
  type SessionQuestion,
  type SessionUsage,
  type StepExecutionResult,
  type StepReport,
} from '@issue-resolver/shared';
import { asRecord } from '../util/records';
import type { UiResponsePayload } from './session-registry';
export interface RpcAssistantMessageEvent {
  type?: string;
  contentIndex?: number;
  delta?: unknown;
  content?: unknown;
  id?: unknown;
  toolName?: unknown;
  toolCall?: unknown;
}

export interface RpcEvent {
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

/** The RPC line is untrusted: only `type` is checked here; every other field
 * stays `unknown`-shaped until its consumer narrows it with `typeof`. */
export function isRpcEvent(value: unknown): value is RpcEvent {
  const record = asRecord(value);
  return record !== null && typeof record.type === 'string';
}

export const DIALOG_METHODS: ReadonlySet<string> = new Set<
  SessionQuestion['method']
>(['select', 'confirm', 'input', 'editor']);

export function isDialogMethod(
  value: unknown,
): value is SessionQuestion['method'] {
  return typeof value === 'string' && DIALOG_METHODS.has(value);
}

export const normalizeUsage = (raw: Record<string, unknown>): SessionUsage => {
  const input = num(raw.input);
  const output = num(raw.output);
  const cacheRead = num(raw.cacheRead);
  const cacheWrite = num(raw.cacheWrite);
  const total =
    num(raw.totalTokens) || input + output + cacheRead + cacheWrite;
  return { input, output, cacheRead, cacheWrite, total };
};

export const normalizeCost = (raw: unknown): SessionCost | null => {
  const obj = asRecord(raw);
  if (!obj) return null;
  return {
    input: num(obj.input),
    output: num(obj.output),
    cacheRead: num(obj.cacheRead),
    cacheWrite: num(obj.cacheWrite),
    total: num(obj.total),
  };
};

const COMPACTION_REASONS: ReadonlySet<string> = new Set(
  Object.values(CompactionReason),
);

function isCompactionReason(value: unknown): value is CompactionReason {
  return typeof value === 'string' && COMPACTION_REASONS.has(value);
}

export const compactionReason = (value: unknown): CompactionReason =>
  isCompactionReason(value) ? value : CompactionReason.manual;

export const questionAnswerText = (payload: UiResponsePayload): string => {
  if (payload.value !== undefined) return payload.value;
  if (payload.confirmed !== undefined) return payload.confirmed ? 'Да' : 'Нет';
  if (payload.cancelled === true) return 'Отменено';
  return '';
};

export const agentStatusFor = (result: StepExecutionResult): StepAgentStatus => {
  if (result.aborted) return StepAgentStatus.aborted;
  return result.exitCode !== 0 ? StepAgentStatus.failed : StepAgentStatus.finished;
};

export const toolResultText = (result: unknown): string => {
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

export function errorEventMessage(event: RpcEvent): string {
  const record = asRecord(event);
  const candidates = ['message', 'error', 'reason', 'detail'];
  for (const key of candidates) {
    const value = record?.[key];
    if (typeof value === 'string' && value.trim().length > 0) return value;
    if (value instanceof Error) return value.message;
  }
  return 'pi reported an error';
}

export function thinkingContentText(content: unknown): string | null {
  if (typeof content === 'string') return content;
  if (content && typeof content === 'object') {
    const thinking = (content as { thinking?: unknown }).thinking;
    if (typeof thinking === 'string') return thinking;
  }
  return null;
}

export function resultFor(
  step: StepExecutionResult['step'],
  aborted: boolean,
  stderr: string,
): StepExecutionResult {
  const report: StepReport | null = aborted
    ? { status: StepReportStatus.fail, summary: 'aborted' }
    : null;
  return {
    step,
    exitCode: aborted ? 1 : 0,
    report,
    stdout: '',
    stderr,
    ...(aborted ? { aborted: true } : {}),
  };
}