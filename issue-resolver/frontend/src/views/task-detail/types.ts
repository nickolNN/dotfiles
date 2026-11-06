import type {
  Issue,
  Iteration,
  StepRunStatus,
  StepRunWithLog,
  WorkspaceProgressStatus,
} from "@issue-resolver/shared";
import type { SessionEvent } from "../../api/session-events";
import type { AsyncState } from "../../lib/async-state";

export type QuestionEvent = Extract<SessionEvent, { type: "question" }>;

export type SendMode = "prompt" | "steer" | "followUp";

const SEND_MODES: readonly SendMode[] = ["prompt", "steer", "followUp"];

export function isSendMode(value: string): value is SendMode {
  return SEND_MODES.some((mode) => mode === value);
}

export type WorkspaceProgressRow = {
  key: string;
  step: string;
  repo?: string;
  status: WorkspaceProgressStatus;
  message?: string;
  devPort?: number;
};

export type WorkspaceProgressBoard = {
  steps: WorkspaceProgressRow[];
  finished: boolean;
  fading: boolean;
  dismissed: boolean;
};

export type ArtifactMeta = {
  status: number;
  contentType: string;
  source: string | null;
  mtime: string | null;
};

export type IssuePage = { issue: Issue; iterations: Iteration[] };

export type LoadState = AsyncState<IssuePage>;

export type StepRunsState = AsyncState<StepRunWithLog[]>;

export interface TaskDetailProps {
  issueId?: string | null;
  autoOpenResult?: boolean;
}
export interface StepLogTarget {
  title: string;
  attempt: number;
  status: StepRunStatus;
  active: boolean;
  events: SessionEvent[];
  stats: StepRunWithLog["stats"];
  stdout: string;
  stderr: string;
  report: string | null;
  startedAt: string | undefined;
  sessionId: string;
}

export interface StepLogIteration {
  id: string | null;
  aborting: boolean;
  abortError: string | null;
  onAbort: (iterationId: string) => void;
}
