import {
  SessionNoticeLevel,
  parseSessionStats,
  type SessionEvent,
  type SessionSpeed,
  type SessionStats,
  type SessionUsage,
} from '@issue-resolver/shared';
import { ContentStream } from './rpc-content-stream';
import { noticeEvent } from './agent-session';
import { mapStatelessEvent, mapUiRequest } from './rpc-event-map';
import {
  answerModelOf,
  normalizeCost,
  normalizeUsage,
  thinkingContentText,
  type RpcAssistantMessageEvent,
  type RpcEvent,
} from './rpc-events';
import { asRecord } from '../util/records';

export interface RpcParseHandlers {
  onStdout?: (chunk: string) => void;
  onEvent?: (event: SessionEvent) => void;
  onStats?: (stats: SessionStats) => void;
}

const SPEED_MIN_ELAPSED_MS = 1000;
const SPEED_MIN_INTERVAL_MS = 250;
const SPEED_SMOOTHING_ALPHA = 0.3;

export class RpcSessionParser {
  private readonly handler: RpcParseHandlers;
  private readonly text: ContentStream;
  private readonly thinking: ContentStream;
  private readonly collected: SessionEvent[] = [];
  private statsValue: SessionStats | null = null;
  private modelValue: string | null = null;
  private assistantReplySeen = false;
  private lastAnswerModel: string | null = null;
  private lastUsageTotal: number | null = null;
  private sessionStartMs: number | null = null;
  private speedSample: { output: number; tsMs: number } | null = null;
  private smoothedTps: number | null = null;

  constructor(handler: RpcParseHandlers = {}) {
    this.handler = handler;
    this.text = new ContentStream({
      onUpdate: (contentIndex, partialText) =>
        this.handler.onEvent?.({ type: 'text_update', contentIndex, partialText }),
      onEmit: (text) => this.push({ type: 'text', text }),
      extract: (content) => (typeof content === 'string' ? content : null),
    });
    this.thinking = new ContentStream({
      onUpdate: (contentIndex, partialText) =>
        this.handler.onEvent?.({ type: 'thinking_update', contentIndex, partialText }),
      onEmit: (thinking) => this.push({ type: 'thinking', thinking }),
      extract: thinkingContentText,
    });
  }

  stdout(): string {
    return this.text.text();
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

  sawAssistantReply(): boolean {
    return this.assistantReplySeen;
  }

  handle(event: RpcEvent): void {
    const uiEvent = mapUiRequest(event);
    if (uiEvent) {
      this.push(uiEvent);
      return;
    }

    if (event.command !== undefined) {
      this.handleCommand(event);
      return;
    }

    if (event.type === 'message_start') {
      const role = asRecord(event.message)?.role;
      if (typeof role === 'string' && role !== 'assistant') return;
      this.assistantReplySeen = true;
      this.markSessionStart();
      this.flush();
      this.text.reset();
      this.thinking.reset();
      return;
    }

    if (event.type === 'message_update') {
      this.assistantReplySeen = true;
      this.handleUsage(event.usage);
      this.handleAssistantMessage(event.assistantMessageEvent);
      return;
    }

    if (event.type === 'message_end') {
      const message = asRecord(event.message);
      if (message?.role === 'assistant') {
        this.assistantReplySeen = true;
      }
      if (message?.role === 'assistant' && message.stopReason === 'length') {
        this.flush();
        this.push(
          noticeEvent(
            SessionNoticeLevel.warning,
            'ответ оборван лимитом вывода модели (maxTokens) — ход закончился без tool-call',
          ),
        );
      }
      this.recordAnswerModel(message);
      return;
    }

    const stateless = mapStatelessEvent(event);
    if (stateless) this.push(stateless);
  }

  flush(): void {
    this.text.flush();
    this.thinking.flush();
  }

  private handleCommand(event: RpcEvent): void {
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

  private handleAssistantMessage(message?: RpcAssistantMessageEvent): void {
    if (!message) return;

    if (message.type === 'text_delta') {
      if (typeof message.delta !== 'string') return;
      this.text.append(this.index(message), message.delta);
      return;
    }

    if (message.type === 'text_end') {
      this.text.finalize(this.index(message), message.content);
      return;
    }

    if (message.type === 'thinking_delta') {
      if (typeof message.delta !== 'string') return;
      this.thinking.append(this.index(message), message.delta);
      return;
    }

    if (message.type === 'thinking_end') {
      this.thinking.finalize(this.index(message), message.content);
    }
  }

  private recordAnswerModel(message: Record<string, unknown> | null): void {
    const answer = answerModelOf(message);
    if (!answer) return;
    const fingerprint = [
      answer.model,
      answer.responseModel,
      answer.thinkingLevel,
      answer.providerThinkingLevel,
    ].join('\u0000');
    if (fingerprint === this.lastAnswerModel) return;
    this.lastAnswerModel = fingerprint;
    this.push({ type: 'answer_model', ...answer });
  }

  private markSessionStart(now: number = Date.now()): void {
    if (this.sessionStartMs === null) this.sessionStartMs = now;
  }

  private handleUsage(raw: unknown): void {
    const obj = asRecord(raw);
    if (!obj) return;
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

  private index(message: RpcAssistantMessageEvent): number {
    return typeof message.contentIndex === 'number' ? message.contentIndex : 0;
  }

  private push(event: SessionEvent): void {
    this.collected.push(event);
    this.handler.onEvent?.(event);
  }
}