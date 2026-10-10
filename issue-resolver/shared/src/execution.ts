import type { ExecutionPlan, ExecutionStage } from './types';

/** Дефолтный потолок числа исполнителей комнаты (защита от «20 агентов»). */
export const DEFAULT_MAX_ROOM_EXECUTORS = 4;

/** Валидный ли этап staged-плана: объект с целым `index` и `executors` (>=1). */
function isExecutionStage(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const stage = value as Record<string, unknown>;
  if (typeof stage.index !== 'number' || !Number.isInteger(stage.index)) {
    return false;
  }
  if (
    stage.executors !== undefined &&
    stage.executors !== null &&
    (typeof stage.executors !== 'number' ||
      !Number.isInteger(stage.executors) ||
      stage.executors < 1)
  ) {
    return false;
  }
  return true;
}

/** Разбор `stages` из ненадёжного JSON: валидные объекты, поля — по типу. */
function parseStages(value: unknown): ExecutionStage[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const stages: ExecutionStage[] = [];
  for (const raw of value) {
    if (!isExecutionStage(raw)) continue;
    const name =
      typeof raw.name === 'string' && raw.name.trim().length > 0
        ? raw.name
        : undefined;
    const task =
      typeof raw.task === 'string' && raw.task.trim().length > 0
        ? raw.task
        : undefined;
    const executors =
      typeof raw.executors === 'number' ? raw.executors : undefined;
    const decomposition = Array.isArray(raw.decomposition)
      ? raw.decomposition.filter(
          (item): item is string =>
            typeof item === 'string' && item.trim().length > 0,
        )
      : undefined;
    stages.push({
      index: raw.index as number,
      ...(name !== undefined ? { name } : {}),
      ...(task !== undefined ? { task } : {}),
      ...(executors !== undefined ? { executors } : {}),
      ...(decomposition !== undefined && decomposition.length > 0
        ? { decomposition }
        : {}),
    });
  }
  return stages;
}

/**
 * Разбор/нормализация `execution` из ненадёжного JSON поля отчёта refine.
 * Любая невалидность → null (движок деградирует в `single`).
 */
export function parseExecutionPlan(value: unknown): ExecutionPlan | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }
  const obj = value as Record<string, unknown>;
  if (obj.mode !== 'single' && obj.mode !== 'room' && obj.mode !== 'stages') {
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
  const stages = parseStages(obj.stages);

  return {
    mode: obj.mode,
    ...(executors !== undefined ? { executors } : {}),
    ...(decomposition !== undefined && decomposition.length > 0
      ? { decomposition }
      : {}),
    ...(stages !== undefined && stages.length > 0 ? { stages } : {}),
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
 * Детерминированное решение о топологии исполнения resolve:
 * - `room` — только при явном `mode: room` и валидном числе исполнителей >= 2;
 * - `stages` — только при `mode: stages` и 2+ валидных этапах (после
 *   нормализации, см. planExecutionStages);
 * - во всех остальных случаях (нет рекомендации, битая, `single`) — один агент.
 * Это точка, где «модель предлагает, движок распоряжается».
 */
export function planExecutionMode(
  execution: ExecutionPlan | null | undefined,
): 'single' | 'room' | 'stages' {
  if (execution?.mode === 'room') {
    return executorCount(execution.executors) >= 2 ? 'room' : 'single';
  }
  if (execution?.mode === 'stages') {
    return planExecutionStages(execution).length >= 2 ? 'stages' : 'single';
  }
  return 'single';
}

/** Число исполнителей, зажатое в [2..max]. Вызывать только для room. */
export function clampExecutors(
  execution: ExecutionPlan,
  max: number = DEFAULT_MAX_ROOM_EXECUTORS,
): number {
  return Math.min(Math.max(2, executorCount(execution.executors)), max);
}

/** Нормализованный этап staged-плана: готов к запуску воркеров/координатора. */
export interface NormalizedStage {
  /** 1-based порядок исполнения (перенумерован подряд 1..N). */
  index: number;
  /** Имя этапа; фолбек — `Этап ${index}`. */
  name: string;
  /** Задача этапа; фолбек — `Stage ${index}`. */
  task: string;
  /** Число параллельных воркеров этапа, зажатое в [1..max]. */
  executors: number;
  /** Ровно `executors` подзадач; добор — `Sub-task N`. */
  decomposition: string[];
}

/** Число исполнителей этапа, зажатое в [1..max] (дефолт 1). */
function clampStageExecutors(
  executors: number | undefined,
  max: number,
): number {
  const raw =
    typeof executors === 'number' && Number.isInteger(executors)
      ? executors
      : 1;
  return Math.min(Math.max(1, raw), Math.max(1, max));
}

/**
 * Нормализация staged-плана: валидные этапы (целый `index`, `executors` >= 1
 * при наличии) перенумеровываются подряд 1..N, исполнители зажимаются в
 * [1..max], а `decomposition` добивается до ровно `executors` пунктов.
 * Возвращает [] вне `mode: 'stages'` либо при менее чем 2 валидных этапах.
 */
export function planExecutionStages(
  execution: ExecutionPlan | null | undefined,
  max: number = DEFAULT_MAX_ROOM_EXECUTORS,
): NormalizedStage[] {
  if (execution?.mode !== 'stages') return [];
  const raw = execution.stages;
  if (!Array.isArray(raw)) return [];

  const stages: NormalizedStage[] = [];
  for (const value of raw) {
    if (!isExecutionStage(value)) continue;
    const index = stages.length + 1;
    const name =
      typeof value.name === 'string' && value.name.trim().length > 0
        ? value.name
        : `Этап ${index}`;
    const task =
      typeof value.task === 'string' && value.task.trim().length > 0
        ? value.task
        : `Stage ${index}`;
    const executors = clampStageExecutors(
      typeof value.executors === 'number' ? value.executors : undefined,
      max,
    );
    const decomposition = Array.from({ length: executors }, (_, i) => {
      const item = Array.isArray(value.decomposition)
        ? value.decomposition[i]
        : undefined;
      const trimmed = typeof item === 'string' ? item.trim() : '';
      return trimmed || `Sub-task ${i + 1}`;
    });
    stages.push({ index, name, task, executors, decomposition });
  }
  return stages.length >= 2 ? stages : [];
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