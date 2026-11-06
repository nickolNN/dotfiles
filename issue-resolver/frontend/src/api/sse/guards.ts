import { CompactionReason, SessionNoticeLevel } from '@issue-resolver/shared';
import type { SessionStats } from '@issue-resolver/shared';
import type { SessionEvent } from '../session-events';
import {
  isArrayWhere,
  isBoolean,
  isNullableBoolean,
  isNullableNumber,
  isNullableString,
  isNumber,
  isOneOf,
  isOptionalOf,
  isRecord,
  isString,
} from '../guards';

export type SessionEventType = SessionEvent['type'];

type EventGuard = (event: Record<string, unknown>) => boolean;

const USAGE_KEYS = ['input', 'output', 'cacheRead', 'cacheWrite', 'total'] as const;
const STATS_COUNT_KEYS = [
  'userMessages',
  'assistantMessages',
  'toolCalls',
  'toolResults',
  'totalMessages',
] as const;
const QUESTION_METHODS = ['select', 'confirm', 'input', 'editor'] as const;
const RETRY_KINDS = ['auto', 'summarization'] as const;
const WIDGET_PLACEMENTS = ['aboveEditor', 'belowEditor'] as const;

function isNumberMap(value: unknown, keys: readonly string[]): boolean {
  return isRecord(value) && keys.every((key) => isNumber(value[key]));
}

function isUsage(value: unknown): boolean {
  return isNumberMap(value, USAGE_KEYS);
}

function isSpeed(value: unknown): boolean {
  return isNumberMap(value, ['tokensPerSecond', 'avgTokensPerSecond']);
}

function isContextUsage(value: unknown): boolean {
  return (
    isRecord(value) &&
    isNullableNumber(value.tokens) &&
    isNumber(value.contextWindow) &&
    isNullableNumber(value.percent)
  );
}

function isStats(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (!STATS_COUNT_KEYS.every((key) => isNumber(value[key]))) return false;
  if (!isUsage(value.tokens)) return false;
  if (!isNullableNumber(value.cost)) return false;
  if (!isOptionalOf(value.sessionId, isString)) return false;
  if (!isOptionalOf(value.model, isString)) return false;
  if (!isOptionalOf(value.avgTokensPerSecond, isNumber)) return false;
  if (!isOptionalOf(value.costFromProvider, isBoolean)) return false;
  return value.contextUsage === null || isContextUsage(value.contextUsage);
}

export function isSessionStats(value: unknown): value is SessionStats {
  return isStats(value);
}

// Every union arm of SessionEvent is listed here. The Record key type makes a
// new arm a tsc error until its required fields are checked.
export const SESSION_EVENT_GUARDS: Record<SessionEventType, EventGuard> = {
  text: (event) => isString(event.text),
  text_update: (event) =>
    isNumber(event.contentIndex) && isString(event.partialText),
  thinking: (event) => isString(event.thinking),
  thinking_update: (event) =>
    isNumber(event.contentIndex) && isString(event.partialText),
  usage: (event) =>
    isUsage(event.usage) &&
    (event.cost === null || isNumberMap(event.cost, USAGE_KEYS)) &&
    isOptionalOf(event.speed, isSpeed),
  stats: (event) => isStats(event.stats),
  question: (event) =>
    isString(event.id) &&
    isOneOf(QUESTION_METHODS, event.method) &&
    isString(event.title) &&
    isOptionalOf(event.message, isString) &&
    isOptionalOf(event.options, (value) => isArrayWhere(value, isString)) &&
    isOptionalOf(event.placeholder, isString) &&
    isOptionalOf(event.prefill, isString),
  question_answered: (event) =>
    isString(event.questionId) && isString(event.answer),
  tool_use: (event) =>
    isString(event.toolCallId) &&
    isString(event.toolName) &&
    Object.hasOwn(event, 'args'),
  tool_result: (event) =>
    isString(event.toolCallId) &&
    isString(event.toolName) &&
    isBoolean(event.isError) &&
    isNullableNumber(event.durationMs) &&
    isString(event.resultText),
  tool_update: (event) =>
    isString(event.toolCallId) &&
    isString(event.toolName) &&
    isString(event.partialText),
  compaction_start: (event) =>
    isOneOf(Object.values(CompactionReason), event.reason),
  compaction_end: (event) =>
    isOneOf(Object.values(CompactionReason), event.reason) &&
    isNullableString(event.summary) &&
    isBoolean(event.aborted) &&
    isBoolean(event.willRetry) &&
    isNullableString(event.errorMessage) &&
    isNullableNumber(event.tokensBefore) &&
    isNullableNumber(event.estimatedTokensAfter),
  retry_start: (event) =>
    isOneOf(RETRY_KINDS, event.kind) &&
    isNullableNumber(event.attempt) &&
    isNullableNumber(event.maxAttempts) &&
    isNullableNumber(event.delayMs) &&
    isNullableString(event.errorMessage) &&
    isNullableString(event.source) &&
    isNullableString(event.reason),
  retry_end: (event) =>
    isOneOf(RETRY_KINDS, event.kind) &&
    isNullableBoolean(event.success) &&
    isNullableNumber(event.attempt) &&
    isNullableString(event.finalError),
  queue: (event) =>
    isArrayWhere(event.steering, isString) &&
    isArrayWhere(event.followUp, isString),
  thinking_level: (event) => isString(event.level),
  session_info: (event) => isNullableString(event.name),
  notice: (event) =>
    isOneOf(Object.values(SessionNoticeLevel), event.level) &&
    isString(event.message),
  status: (event) => isString(event.key) && isNullableString(event.text),
  widget: (event) =>
    isString(event.key) &&
    (event.lines === null || isArrayWhere(event.lines, isString)) &&
    isOneOf(WIDGET_PLACEMENTS, event.placement),
  title: (event) => isString(event.title),
  extension_error: (event) => isString(event.message),
  bash: (event) => isString(event.delta),
  editor_text: (event) => isString(event.text),
  answer_model: (event) =>
    isNullableString(event.model) &&
    isNullableString(event.responseModel) &&
    isNullableString(event.thinkingLevel) &&
    isNullableString(event.providerThinkingLevel),
};

function isSessionEventType(value: string): value is SessionEventType {
  return Object.hasOwn(SESSION_EVENT_GUARDS, value);
}

export function isSessionEvent(value: unknown): value is SessionEvent {
  if (!isRecord(value) || !isString(value.type)) return false;
  if (!isSessionEventType(value.type)) return false;
  return SESSION_EVENT_GUARDS[value.type](value);
}

export function parseSessionEvent(value: unknown): SessionEvent | null {
  return isSessionEvent(value) ? value : null;
}