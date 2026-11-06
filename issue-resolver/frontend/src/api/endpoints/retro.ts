import type { RetroRun, RetroRunWithLog, ThinkingLevel } from '@issue-resolver/shared';
import { API_BASE, requestJson, requestVoid } from './http';

interface StartRetroRunInput {
  model?: string;
  thinking_level?: ThinkingLevel;
  session_limit?: number;
  instructions?: string;
}

const RETRO_PATH = `${API_BASE}/settings/retro`;

export function startRetroRun(
  input: StartRetroRunInput = {},
): Promise<RetroRun> {
  return requestJson<RetroRun>(RETRO_PATH, { method: 'POST', json: input });
}

export async function getRetroRuns(): Promise<RetroRun[]> {
  const payload = await requestJson<{ runs?: RetroRun[] } | null>(RETRO_PATH);
  return Array.isArray(payload?.runs) ? payload.runs : [];
}

export function getRetroRun(id: string): Promise<RetroRunWithLog> {
  return requestJson<RetroRunWithLog>(
    `${RETRO_PATH}/${encodeURIComponent(id)}`,
  );
}

export function abortRetroRun(id: string): Promise<void> {
  return requestVoid(`${RETRO_PATH}/${encodeURIComponent(id)}/abort`, {
    method: 'POST',
  });
}