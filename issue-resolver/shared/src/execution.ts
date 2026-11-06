import { ExecutionMode } from './status';
import type { ExecutionPlan, ExecutionStage } from './types/step';

export const DEFAULT_MAX_EXECUTORS = 4;

function isExecutionStage(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const stage = value as Record<string, unknown>;
  if (
    typeof stage.index !== 'number' ||
    !Number.isInteger(stage.index) ||
    stage.index < 1
  ) {
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
  if (
    stage.decomposition !== undefined &&
    stage.decomposition !== null &&
    (!Array.isArray(stage.decomposition) ||
      !stage.decomposition.every(isSubTask))
  ) {
    return false;
  }
  if (stage.decompositionMalformed === true) return false;
  return true;
}

function isSubTask(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

type DecompositionField =
  | { state: 'absent' }
  | { state: 'items'; items: string[] }
  | { state: 'malformed' };

function parseDecomposition(value: unknown): DecompositionField {
  if (value === undefined || value === null) return { state: 'absent' };
  if (!Array.isArray(value) || !value.every(isSubTask)) {
    return { state: 'malformed' };
  }
  return { state: 'items', items: value };
}

function executorCount(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  return typeof value === 'number' ? value : Number.NaN;
}

function parseStage(value: unknown): ExecutionStage {
  const raw =
    typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  const name =
    typeof raw.name === 'string' && raw.name.trim().length > 0
      ? raw.name
      : undefined;
  const task =
    typeof raw.task === 'string' && raw.task.trim().length > 0
      ? raw.task
      : undefined;
  const executors = executorCount(raw.executors);
  const decomposition = parseDecomposition(raw.decomposition);
  return {
    index: typeof raw.index === 'number' ? raw.index : 0,
    ...(name !== undefined ? { name } : {}),
    ...(task !== undefined ? { task } : {}),
    ...(executors !== undefined ? { executors } : {}),
    ...(decomposition.state === 'items' && decomposition.items.length > 0
      ? { decomposition: decomposition.items }
      : {}),
    ...(decomposition.state === 'malformed'
      ? { decompositionMalformed: true }
      : {}),
  };
}

function parseStages(value: unknown): ExecutionStage[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.map(parseStage);
}

export function parseExecutionPlan(value: unknown): ExecutionPlan | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }
  const obj = value as Record<string, unknown>;
  if (obj.mode !== ExecutionMode.single && obj.mode !== ExecutionMode.stages) {
    return null;
  }

  const executors = executorCount(obj.executors);
  const decomposition = parseDecomposition(obj.decomposition);
  const rationale =
    typeof obj.rationale === 'string' ? obj.rationale : undefined;
  const stages = parseStages(obj.stages);

  const declared = {
    ...(executors !== undefined ? { executors } : {}),
    ...(stages !== undefined && stages.length > 0 ? { stages } : {}),
    ...(rationale !== undefined ? { rationale } : {}),
    ...(decomposition.state === 'items' && decomposition.items.length > 0
      ? { decomposition: decomposition.items }
      : {}),
    ...(decomposition.state === 'malformed'
      ? { decompositionMalformed: true }
      : {}),
  };

  if (obj.mode === ExecutionMode.stages) {
    return { mode: ExecutionMode.stages, ...declared };
  }

  return { mode: ExecutionMode.single, ...declared };
}

export function maxExecutorsFor(
  workerCount: number | null | undefined,
): number {
  if (
    typeof workerCount !== 'number' ||
    !Number.isInteger(workerCount) ||
    workerCount <= 0
  ) {
    return DEFAULT_MAX_EXECUTORS;
  }
  return workerCount;
}

function hasValidStage(execution: ExecutionPlan): boolean {
  const raw = execution.stages;
  if (!Array.isArray(raw)) return false;
  return raw.some((value) => isExecutionStage(value));
}

export function planExecutionMode(
  execution: ExecutionPlan | null | undefined,
): ExecutionMode {
  if (execution?.mode !== ExecutionMode.stages) return ExecutionMode.single;
  return hasValidStage(execution)
    ? ExecutionMode.stages
    : ExecutionMode.single;
}

export function executionPlanProblem(
  execution: ExecutionPlan | null | undefined,
  concurrency: number,
): string | null {
  if (!execution) return null;
  const limit = Math.max(1, concurrency);
  if (execution.mode === ExecutionMode.stages) {
    const topLevel = [
      execution.executors !== undefined ? 'executors' : null,
      execution.decomposition !== undefined ||
      execution.decompositionMalformed === true
        ? 'decomposition'
        : null,
    ].filter((field): field is string => field !== null);
    if (topLevel.length > 0) {
      return `mode stages declares top-level ${topLevel.join(' and ')} — a staged plan declares them per stage`;
    }
    const declared = Array.isArray(execution.stages) ? execution.stages : [];
    if (declared.length === 0) {
      return 'stages declares no valid stages — a staged plan needs at least one';
    }
    const malformed = declared.findIndex((stage) => !isExecutionStage(stage));
    if (malformed !== -1) {
      const position = `stage at position ${malformed + 1} of ${declared.length}`;
      return `${position} is malformed (index, executors and decomposition must be well-formed)`;
    }
    for (const [offset, stage] of declared.entries()) {
      const position = `stage at position ${offset + 1} of ${declared.length}`;
      const executors =
        typeof stage.executors === 'number' ? stage.executors : 1;
      if (executors > limit) {
        return `${position} declares ${executors} parallel executors, but at most ${limit} may run at the same time`;
      }
      const parts = stage.decomposition?.length ?? 0;
      const declaresParts = stage.decomposition !== undefined;
      if (parts > executors || (declaresParts && parts < executors)) {
        const entry = parts === 1 ? 'entry' : 'entries';
        const noun = executors === 1 ? 'executor' : 'executors';
        return `${position} declares ${parts} decomposition ${entry} for ${executors} ${noun} — a wave has one sub-task per executor`;
      }
    }
    const only = declared[0];
    if (
      declared.length === 1 &&
      (typeof only.executors !== 'number' || only.executors < 2)
    ) {
      return 'a plan with one stage and one executor is `single` — a wave needs at least two executors';
    }
    return null;
  }

  if (
    execution.executors !== undefined &&
    (!Number.isInteger(execution.executors) || execution.executors < 1)
  ) {
    return `mode ${execution.mode} declares malformed executors — a whole number of at least 1 is required`;
  }
  const executors = execution.executors ?? 1;
  if (executors > 1) {
    return `mode ${execution.mode} declares ${executors} executors — single means one executor, use mode stages for a wave`;
  }
  if (execution.decompositionMalformed === true) {
    return `mode ${execution.mode} declares malformed decomposition — a list of sub-tasks is required`;
  }
  const parts = execution.decomposition?.length ?? 0;
  if (parts > 1) {
    return `mode ${execution.mode} declares ${parts} decomposition entries — single means one executor, use mode stages for a wave`;
  }
  return null;
}


export interface NormalizedStage {
  index: number;
  name: string;
  task: string;
  executors: number;
  decomposition: string[];
}

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

export function stageLabel(
  name: string | null | undefined,
  index: number,
): string {
  const trimmed = typeof name === 'string' ? name.trim() : '';
  return trimmed.length > 0 ? trimmed : `Этап ${index}`;
}

export function planExecutionStages(
  execution: ExecutionPlan | null | undefined,
  max: number,
): NormalizedStage[] {
  if (execution?.mode !== ExecutionMode.stages) return [];
  const raw = execution.stages;
  if (!Array.isArray(raw)) return [];

  const stages: NormalizedStage[] = [];
  for (const value of raw) {
    if (!isExecutionStage(value)) continue;
    const index = stages.length + 1;
    const name = stageLabel(
      typeof value.name === 'string' ? value.name : null,
      index,
    );
    const task =
      typeof value.task === 'string' && value.task.trim().length > 0
        ? value.task
        : `Stage ${index}`;
    const executors = clampStageExecutors(
      typeof value.executors === 'number' ? value.executors : undefined,
      max,
    );
    const decomposition = Array.isArray(value.decomposition)
      ? value.decomposition
          .map((item) => item.trim())
          .filter((item) => item.length > 0)
      : [];
    stages.push({ index, name, task, executors, decomposition });
  }
  return stages;
}

export interface WorkerTask {
  index: number;
  task: string;
}
