import type { CompactionReason, SessionNoticeLevel } from '../status';

export interface SessionUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
}

export interface SessionCost {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
}

export interface SessionSpeed {
  tokensPerSecond: number;
  avgTokensPerSecond: number;
}

export interface SessionQuestion {
  id: string;
  method: 'select' | 'confirm' | 'input' | 'editor';
  title: string;
  message?: string;
  options?: string[];
  placeholder?: string;
  prefill?: string;
}


export interface SessionStats {
  sessionId?: string;
  model?: string;
  userMessages: number;
  assistantMessages: number;
  toolCalls: number;
  toolResults: number;
  totalMessages: number;
  tokens: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
  cost: number | null;
  contextUsage: {
    tokens: number | null;
    contextWindow: number;
    percent: number | null;
  } | null;
  avgTokensPerSecond?: number;
}

export type SessionEvent =
  | { type: 'text'; text: string }
  | { type: 'text_update'; contentIndex: number; partialText: string }
  | { type: 'thinking'; thinking: string }
  | { type: 'thinking_update'; contentIndex: number; partialText: string }
  | {
      type: 'usage';
      usage: SessionUsage;
      cost: SessionCost | null;
      speed?: SessionSpeed;
    }
  | { type: 'stats'; stats: SessionStats }
  | ({ type: 'question' } & SessionQuestion)
  | { type: 'question_answered'; questionId: string; answer: string }
  | { type: 'tool_use'; toolCallId: string; toolName: string; args: unknown }
  | {
      type: 'tool_result';
      toolCallId: string;
      toolName: string;
      isError: boolean;
      durationMs: number | null;
      resultText: string;
    }
  | { type: 'tool_update'; toolCallId: string; toolName: string; partialText: string }
  | { type: 'compaction_start'; reason: CompactionReason }
  | {
      type: 'compaction_end';
      reason: CompactionReason;
      summary: string | null;
      aborted: boolean;
      willRetry: boolean;
      errorMessage: string | null;
      tokensBefore: number | null;
      estimatedTokensAfter: number | null;
    }
  | {
      type: 'retry_start';
      kind: 'auto' | 'summarization';
      attempt: number | null;
      maxAttempts: number | null;
      delayMs: number | null;
      errorMessage: string | null;
      source: string | null;
      reason: string | null;
    }
  | {
      type: 'retry_end';
      kind: 'auto' | 'summarization';
      success: boolean | null;
      attempt: number | null;
      finalError: string | null;
    }
  | { type: 'queue'; steering: string[]; followUp: string[] }
  | { type: 'thinking_level'; level: string }
  | { type: 'session_info'; name: string | null }
  | { type: 'notice'; level: SessionNoticeLevel; message: string }
  | { type: 'status'; key: string; text: string | null }
  | {
      type: 'widget';
      key: string;
      lines: string[] | null;
      placement: 'aboveEditor' | 'belowEditor';
    }
  | { type: 'title'; title: string }
  | { type: 'extension_error'; message: string }
  | { type: 'bash'; delta: string }
  | { type: 'editor_text'; text: string };