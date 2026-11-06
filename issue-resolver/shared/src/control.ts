export const SteeringMode = Object.freeze({
  all: 'all',
  'one-at-a-time': 'one-at-a-time',
} as const);
export type SteeringMode = (typeof SteeringMode)[keyof typeof SteeringMode];

export const PromptMode = Object.freeze({
  steer: 'steer',
  followUp: 'followUp',
} as const);
export type PromptMode = (typeof PromptMode)[keyof typeof PromptMode];

export const SessionCommandSource = Object.freeze({
  builtin: 'builtin',
  extension: 'extension',
  prompt: 'prompt',
  skill: 'skill',
} as const);
export type SessionCommandSource =
  (typeof SessionCommandSource)[keyof typeof SessionCommandSource];

export interface SessionCommandInfo {
  name: string;
  description?: string;
  argumentHint?: string;
  source: SessionCommandSource;
}

export interface SessionModelInfo {
  provider: string;
  id: string;
  name?: string;
}

export interface SessionControlState {
  model: string | null;
  provider: string | null;
  modelId: string | null;
  thinkingLevel: string | null;
  steeringMode: SteeringMode | null;
  followUpMode: SteeringMode | null;
  autoCompactionEnabled: boolean | null;
  autoRetryEnabled: boolean | null;
  isStreaming: boolean;
  sessionName: string | null;
}

export interface SessionControlSnapshot {
  state: SessionControlState;
  models: SessionModelInfo[];
  thinkingLevels: string[];
  commands: SessionCommandInfo[];
}

export type SessionCommand =
  | { type: 'set_model'; provider: string; modelId: string }
  | { type: 'cycle_model' }
  | { type: 'set_thinking_level'; level: string }
  | { type: 'cycle_thinking_level' }
  | { type: 'compact'; instructions?: string }
  | { type: 'clear_queue' }
  | { type: 'set_auto_compaction'; enabled: boolean }
  | { type: 'set_auto_retry'; enabled: boolean }
  | { type: 'abort_retry' }
  | { type: 'set_steering_mode'; mode: SteeringMode }
  | { type: 'set_follow_up_mode'; mode: SteeringMode }
  | { type: 'bash'; command: string }
  | { type: 'abort_bash' };

export interface ControlResult {
  ok: boolean;
  data?: unknown;
  error?: string;
}

export const PromptDisposition = Object.freeze({
  started: 'started',
  queued: 'queued',
  handled: 'handled',
} as const);
export type PromptDisposition =
  (typeof PromptDisposition)[keyof typeof PromptDisposition];

const PROMPT_DISPOSITIONS: ReadonlySet<string> = new Set(
  Object.values(PromptDisposition),
);

/** Unknown protocol values fall back to `started`: a prompt that reached pi is
 * assumed to be running rather than silently reported as queued. */
export function promptDisposition(value: unknown): PromptDisposition {
  return typeof value === 'string' && PROMPT_DISPOSITIONS.has(value)
    ? (value as PromptDisposition)
    : PromptDisposition.started;
}

export interface PromptResult {
  ok: boolean;
  disposition: PromptDisposition;
  error?: string;
}