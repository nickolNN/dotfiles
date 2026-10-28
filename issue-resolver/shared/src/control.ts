
export type SteeringMode = 'all' | 'one-at-a-time';

export type PromptMode = 'steer' | 'followUp';

export interface SessionCommandInfo {
  name: string;
  description?: string;
  argumentHint?: string;
  source: 'builtin' | 'extension' | 'prompt' | 'skill';
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

export interface PromptResult {
  ok: boolean;
  disposition: 'started' | 'queued' | 'handled';
  error?: string;
}