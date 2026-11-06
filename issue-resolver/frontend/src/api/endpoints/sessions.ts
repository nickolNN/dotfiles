import type {
  ControlResult,
  PromptMode,
  PromptResult,
  SessionCommand,
  SessionControlSnapshot,
  StepAgent,
} from '@issue-resolver/shared';
import { StepAgentRole, StepAgentStatus } from '@issue-resolver/shared';
import { PromptDisposition, SessionCommandSource, SteeringMode } from '@issue-resolver/shared';
import { messageOf } from '../../lib/errors';
import {
  isArrayWhere,
  isBoolean,
  isNullableBoolean,
  isNullableString,
  isOneOf,
  isOptionalOf,
  isRecord,
  isString,
} from '../guards';
import {
  API_BASE,
  readErrorMessage,
  requestJson,
  requestJsonOrNull,
  send,
} from './http';

interface UiResponsePayload {
  id: string;
  value?: string;
  confirmed?: boolean;
  cancelled?: boolean;
}

function isStepAgent(value: unknown): value is StepAgent {
  return (
    isRecord(value) &&
    isString(value.id) &&
    isOneOf(STEP_AGENT_ROLES, value.role) &&
    isString(value.label) &&
    isOneOf(STEP_AGENT_STATUSES, value.status)
  );
}

export async function getStepAgents(iterationId: string): Promise<StepAgent[]> {
  const data = await requestJsonOrNull<unknown>(
    `${API_BASE}/iterations/${iterationId}/agents`,
  );
  return Array.isArray(data) ? data.filter(isStepAgent) : [];
}

export async function getQuestionAnswers(
  iterationId: string,
): Promise<string[]> {
  const data = await requestJsonOrNull<unknown>(
    `${API_BASE}/iterations/${iterationId}/question-answers`,
  );
  const raw =
    data && typeof data === 'object' && !Array.isArray(data)
      ? (data as { answered_ids?: unknown }).answered_ids
      : data;
  return Array.isArray(raw)
    ? raw.filter((id): id is string => typeof id === 'string')
    : [];
}

export async function promptIteration(
  iterationId: string,
  message: string,
  mode?: PromptMode,
): Promise<PromptResult> {
  try {
    const response = await send(
      `${API_BASE}/iterations/${encodeURIComponent(iterationId)}/prompt`,
      { method: 'POST', json: mode ? { message, mode } : { message } },
    );
    if (!response.ok) {
      return {
        ok: false,
        disposition: 'started',
        error: await readErrorMessage(response),
      };
    }

    const data = (await response.json()) as {
      ok?: unknown;
      disposition?: unknown;
      error?: unknown;
    };
    const disposition =
      data?.disposition === PromptDisposition.queued ||
      data?.disposition === PromptDisposition.handled
        ? data.disposition
        : 'started';
    const ok = data?.ok === false ? false : true;
    const error =
      typeof data?.error === 'string' && data.error.length > 0
        ? data.error
        : undefined;
    return error !== undefined
      ? { ok, disposition, error }
      : { ok, disposition };
  } catch {
    return { ok: false, disposition: 'started' };
  }
}

const STEERING_MODES = Object.values(SteeringMode);
const COMMAND_SOURCES = Object.values(SessionCommandSource);
const STEP_AGENT_ROLES = Object.values(StepAgentRole);
const STEP_AGENT_STATUSES = Object.values(StepAgentStatus);

function isControlState(value: unknown): boolean {
  return (
    isRecord(value) &&
    isNullableString(value.model) &&
    isNullableString(value.provider) &&
    isNullableString(value.modelId) &&
    isNullableString(value.thinkingLevel) &&
    (value.steeringMode === null ||
      isOneOf(STEERING_MODES, value.steeringMode)) &&
    (value.followUpMode === null ||
      isOneOf(STEERING_MODES, value.followUpMode)) &&
    isNullableBoolean(value.autoCompactionEnabled) &&
    isNullableBoolean(value.autoRetryEnabled) &&
    isBoolean(value.isStreaming) &&
    isNullableString(value.sessionName)
  );
}

function isModelInfo(value: unknown): boolean {
  return (
    isRecord(value) &&
    isString(value.provider) &&
    isString(value.id) &&
    isOptionalOf(value.name, isString)
  );
}

function isCommandInfo(value: unknown): boolean {
  return (
    isRecord(value) &&
    isString(value.name) &&
    isOneOf(COMMAND_SOURCES, value.source) &&
    isOptionalOf(value.description, isString) &&
    isOptionalOf(value.argumentHint, isString)
  );
}

function isControlSnapshot(value: unknown): value is SessionControlSnapshot {
  return (
    isRecord(value) &&
    isControlState(value.state) &&
    isArrayWhere(value.models, isModelInfo) &&
    isArrayWhere(value.thinkingLevels, isString) &&
    isArrayWhere(value.commands, isCommandInfo)
  );
}

export async function getIterationControl(
  iterationId: string,
): Promise<SessionControlSnapshot | null> {
  const data = await requestJsonOrNull<unknown>(
    `${API_BASE}/iterations/${encodeURIComponent(iterationId)}/control`,
  );
  return isControlSnapshot(data) ? data : null;
}

export async function sendIterationCommand(
  iterationId: string,
  command: SessionCommand,
): Promise<ControlResult> {
  try {
    const response = await send(
      `${API_BASE}/iterations/${encodeURIComponent(iterationId)}/control`,
      { method: 'POST', json: { command } },
    );
    if (!response.ok) {
      return { ok: false, error: await readErrorMessage(response) };
    }

    const data = (await response.json()) as unknown;
    if (data && typeof data === 'object') {
      const record = data as { ok?: unknown; data?: unknown; error?: unknown };
      return {
        ok: record.ok === undefined ? true : record.ok === true,
        data: record.data,
        error: typeof record.error === 'string' ? record.error : undefined,
      };
    }
    return { ok: true, data };
  } catch (error) {
    return {
      ok: false,
      error: messageOf(error),
    };
  }
}

export function sendIterationMessage(
  iterationId: string,
  message: string,
): Promise<{ ok: boolean }> {
  return requestJson<{ ok: boolean }>(
    `${API_BASE}/iterations/${encodeURIComponent(iterationId)}/message`,
    { method: 'POST', json: { message } },
  );
}

export function sendUiResponse(
  iterationId: string,
  payload: UiResponsePayload,
): Promise<{ ok: boolean }> {
  return requestJson<{ ok: boolean }>(
    `${API_BASE}/iterations/${encodeURIComponent(iterationId)}/ui-response`,
    { method: 'POST', json: payload },
  );
}