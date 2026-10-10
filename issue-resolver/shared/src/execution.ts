import type { ExecutionPlan } from './types';

/** Дефолтный потолок числа исполнителей комнаты (защита от «20 агентов»). */
export const DEFAULT_MAX_ROOM_EXECUTORS = 4;

/**
 * Разбор/нормализация `execution` из ненадёжного JSON поля отчёта refine.
 * Любая невалидность → null (движок деградирует в `single`).
 */
export function parseExecutionPlan(value: unknown): ExecutionPlan | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }
  const obj = value as Record<string, unknown>;
  if (obj.mode !== 'single' && obj.mode !== 'room') {
    return null;
  }

  const executors =
    typeof obj.executors === 'number' && Number.isInteger(obj.executors)
      ? obj.executors
      : undefined;
  const decomposition = Array.isArray(obj.decomposition)
    ? obj.decomposition.filter(
        (item): item is string =>
          typeof item === 'string' && item.trim().length > 0,
      )
    : undefined;
  const rationale =
    typeof obj.rationale === 'string' ? obj.rationale : undefined;

  return {
    mode: obj.mode,
    ...(executors !== undefined ? { executors } : {}),
    ...(decomposition !== undefined && decomposition.length > 0
      ? { decomposition }
      : {}),
    ...(rationale !== undefined ? { rationale } : {}),
  };
}

/** Целое число исполнителей, если оно валидно (>= 2); иначе 0. */
function executorCount(executors: number | undefined): number {
  return typeof executors === 'number' &&
    Number.isInteger(executors) &&
    executors >= 2
    ? executors
    : 0;
}

/**
 * Детерминированное решение о топологии исполнения resolve.
 * Комната — ТОЛЬКО при явном `mode: room` и валидном числе исполнителей >= 2;
 * во всех остальных случаях (нет рекомендации, битая, `single`) — один агент.
 * Это точка, где «модель предлагает, движок распоряжается».
 */
export function planExecutionMode(
  execution: ExecutionPlan | null | undefined,
): 'single' | 'room' {
  if (execution?.mode !== 'room') {
    return 'single';
  }
  return executorCount(execution.executors) >= 2 ? 'room' : 'single';
}

/** Число исполнителей, зажатое в [2..max]. Вызывать только для room. */
export function clampExecutors(
  execution: ExecutionPlan,
  max: number = DEFAULT_MAX_ROOM_EXECUTORS,
): number {
  return Math.min(Math.max(2, executorCount(execution.executors)), max);
}

export interface RoomWorkItem {
  index: number;
  task: string;
}

/**
 * Детерминированная декомпозиция комнаты: ровно `count` пунктов.
 * Фолбек без `decomposition` — нумерованные generic-подзадачи.
 */
export function planRoomWorkItems(
  execution: ExecutionPlan,
  count: number,
): RoomWorkItem[] {
  const decomposition = execution.decomposition ?? [];
  return Array.from({ length: count }, (_, index) => {
    const task = decomposition[index]?.trim();
    return {
      index,
      task: task ?? `Sub-task ${index + 1}`,
    };
  });
}