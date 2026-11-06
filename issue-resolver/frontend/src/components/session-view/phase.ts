import type { SessionEvent } from '../../api/session-events';
import { WorkingPhaseKind, type ToolResultInfo, type WorkingPhase } from './types';

export function workingPhase(
  visible: SessionEvent[],
  resultByCallId: Map<string, ToolResultInfo>,
  liveThinking = false,
  liveText = false,
): WorkingPhase {
  if (liveThinking) return { kind: WorkingPhaseKind.thinking };
  if (liveText) return { kind: WorkingPhaseKind.text };
  const last = visible[visible.length - 1];
  if (!last) return { kind: WorkingPhaseKind.idle };
  if (last.type === 'tool_use' && !resultByCallId.has(last.toolCallId)) {
    return { kind: WorkingPhaseKind.tool, toolName: last.toolName };
  }
  if (last.type === 'thinking') return { kind: WorkingPhaseKind.thinking };
  if (last.type === 'text') return { kind: WorkingPhaseKind.text };
  return { kind: WorkingPhaseKind.idle };
}

export function phaseLabel(phase: WorkingPhase): string {
  switch (phase.kind) {
    case WorkingPhaseKind.tool:
      return `выполняет ${phase.toolName}`;
    case WorkingPhaseKind.thinking:
      return 'думает';
    case WorkingPhaseKind.text:
      return 'печатает';
    case WorkingPhaseKind.idle:
      return 'работает';
  }
}

export function workingElapsedMs(
  now: number,
  startedAt: string | null,
): number | null {
  if (!startedAt) return null;
  const start = Date.parse(startedAt);
  if (!Number.isFinite(start)) return null;
  return Math.max(0, now - start);
}