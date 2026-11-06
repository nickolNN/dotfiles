import type { SessionStats } from '@issue-resolver/shared';
import type { SessionEvent } from '../../api/session-events';

export type QuestionEvent = Extract<SessionEvent, { type: 'question' }>;
export type CompactionEvent = Extract<
  SessionEvent,
  { type: 'compaction_start' | 'compaction_end' }
>;
export type RetryEvent = Extract<
  SessionEvent,
  { type: 'retry_start' | 'retry_end' }
>;
export type NoticeEvent = Extract<SessionEvent, { type: 'notice' }>;
export type AnswerModelEvent = Extract<SessionEvent, { type: 'answer_model' }>;

export const ToolStatus = Object.freeze({
  running: 'running',
  done: 'done',
  waiting: 'waiting',
} as const);
export type ToolStatus = (typeof ToolStatus)[keyof typeof ToolStatus];

export const WorkingPhaseKind = Object.freeze({
  tool: 'tool',
  thinking: 'thinking',
  text: 'text',
  idle: 'idle',
} as const);
export type WorkingPhaseKind =
  (typeof WorkingPhaseKind)[keyof typeof WorkingPhaseKind];

export type WorkingPhase =
  | { kind: typeof WorkingPhaseKind.tool; toolName: string }
  | { kind: typeof WorkingPhaseKind.thinking }
  | { kind: typeof WorkingPhaseKind.text }
  | { kind: typeof WorkingPhaseKind.idle };

export interface SessionViewProps {
  events: SessionEvent[];
  stats?: SessionStats | null;
  emptyMessage?: string;
  running?: boolean;
  startedAt?: string | null;
  showFooter?: boolean;
  hideInfo?: boolean;
  infoOnly?: boolean;
  onRecallQueued?: (text: string) => void;
}

export interface SessionWidget {
  key: string;
  lines: string[];
}

export interface SessionInfo {
  sessionName: string | null;
  thinkingLevel: string | null;
  queue: SessionQueue | null;
  statuses: Array<{ key: string; text: string }>;
  widgetsAbove: SessionWidget[];
  widgetsBelow: SessionWidget[];
  title: string | null;
  editorText: string | null;
}

export interface SessionQueue {
  steering: string[];
  followUp: string[];
}

export interface ToolResultInfo {
  isError: boolean;
  durationMs: number | null;
}

export interface AnalyzedEvents {
  visible: SessionEvent[];
  partialByCallId: Map<string, string>;
  resultByCallId: Map<string, ToolResultInfo>;
  answersByQuestionId: Map<string, string>;
  bashText: string | null;
  liveThinking: string | null;
  liveText: string | null;
  info: SessionInfo;
}

export interface EventMaps {
  partialByCallId: Map<string, string>;
  resultByCallId: Map<string, ToolResultInfo>;
  answersByQuestionId: Map<string, string>;
}