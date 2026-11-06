import type {
  RetroRunStatus,
  ThinkingLevel,
} from '@issue-resolver/shared';
import type { Db } from '../db/client';
import type { PiRunner } from '../pi/runner';
import type { StepSessionRegistry } from '../pi/session-registry';
import type { SseHub } from '../sse/hub';

export interface RetroRunDeps {
  db: Db;
  pi: PiRunner;
  sse?: SseHub;
  repoRoot?: string;
  promptPath?: string;
  memoryDir?: string;
  sessionsDir?: string;
  dbPath?: string;
  retroSkillPath?: string;
  writingSkillPath?: string;
  sessionLimit?: number;
  timeoutMs?: number;
  registry?: StepSessionRegistry;
  model?: string;
  thinkingLevel?: ThinkingLevel;
  extraInstructions?: string;
}

export interface RunRetroSessionResult {
  status: RetroRunStatus;
  report: string | null;
  error: string | null;
}