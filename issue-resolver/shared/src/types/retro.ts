import type { RetroRunStatus } from '../status';
import type { ThinkingLevel } from '../status';
import type { SessionEvent, SessionStats } from './session';

export interface RetroRun {
  id: string;
  status: RetroRunStatus;
  model: string | null;
  instructions: string | null;
  session_limit: number | null;
  thinking_level: ThinkingLevel | null;
  report: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
}

export interface RetroRunWithLog extends RetroRun {
  stdout: string;
  stderr: string;
  events: SessionEvent[];
  stats: SessionStats | null;
}