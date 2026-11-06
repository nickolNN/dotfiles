import type {
  ControlResult,
  PromptMode,
  PromptResult,
  StepAgent,
  SessionEvent,
} from '@issue-resolver/shared';
import { StepAgentStatus } from '@issue-resolver/shared';

export { StepAgentStatus };

export interface StepSessionControl {
  steer(text: string): void;
  abort(): void;
  respond(payload: UiResponsePayload): void;
  prompt(message: string, mode?: PromptMode): Promise<PromptResult>;
  send(command: Record<string, unknown>): Promise<ControlResult>;
}

export interface UiResponsePayload {
  id: string;
  value?: string;
  confirmed?: boolean;
  cancelled?: boolean;
}

export interface StepAgentInfo {
  id: string;
  role: StepAgent['role'];
  index: number | null;
  label: string;
  stage?: number | null;
  stageName?: string | null;
}

export type SessionTarget =
  | { by: 'iteration'; id: string }
  | { by: 'run'; id: string };

export const iterationTarget = (id: string): SessionTarget => ({
  by: 'iteration',
  id,
});

export const runTarget = (id: string): SessionTarget => ({ by: 'run', id });

export interface StepSessionRegistry {
  register(
    stepRunId: string,
    iterationId: string,
    control: StepSessionControl,
    agent?: StepAgentInfo,
  ): void;
  unregister(stepRunId: string, status?: StepAgentStatus): void;
  steer(stepRunId: string, text: string): boolean;
  abort(stepRunId: string): boolean;
  steerByIteration(iterationId: string, text: string): boolean;
  abortByIteration(iterationId: string): boolean;
  hasByIteration(iterationId: string): boolean;
  respond(stepRunId: string, payload: UiResponsePayload): boolean;
  respondByIteration(
    iterationId: string,
    payload: UiResponsePayload,
  ): boolean;
  prompt(
    target: SessionTarget,
    message: string,
    mode?: PromptMode,
  ): Promise<PromptResult> | null;
  send(
    target: SessionTarget,
    command: Record<string, unknown>,
  ): Promise<ControlResult> | null;
  listAgents(iterationId: string): StepAgent[];
  recordEvent(stepRunId: string, event: SessionEvent): void;
}