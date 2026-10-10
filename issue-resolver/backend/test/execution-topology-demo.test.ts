/**
 * Демо 4 топологий исполнения resolve: single, room (параллельно),
 * stages (последовательно) и stages-сложный (параллель × последовательность).
 *
 * Тест документирует ФАКТИЧЕСКОЕ поведение `runRoomResolve`/`runStagedResolve`
 * (backend/src/workflow/room.ts) точным порядком pi-вызовов и печатает
 * человекочитаемый трейс (∥ — воркеры одной параллельной фазы, `---` — смена
 * этапа/секции). Трейс нужен для отчёта, ассерты на него не опираются.
 */
import { describe, expect, it } from 'vitest';
import type {
  ExecutionPlan,
  PipelineStep,
  StepExecutionResult,
} from '@issue-resolver/shared';
import { planExecutionMode } from '@issue-resolver/shared';
import { FakePiRunner, type PiRunCall } from '../src/pi/runner';
import { InMemoryStepSessionRegistry } from '../src/pi/session-registry';
import {
  runRoomResolve,
  runStagedResolve,
  type RoomResolveInput,
  type RoomResolveOptions,
} from '../src/workflow/room';
import {
  COMPLEX_STAGES_PLAN,
  ROOM_PLAN,
  SEQUENTIAL_STAGES_PLAN,
  SINGLE_PLAN,
} from './execution-plans.example';

const STEP: PipelineStep = 'resolve';

const input = (execution: ExecutionPlan): RoomResolveInput => ({
  containerName: 'issue-resolver-issue-1',
  execution,
  issueTitle: 'Fix bug',
  description: 'desc',
  jiraText: null,
  context: 'ctx',
  feedback: null,
  refinedPlan: 'plan',
  repoPaths: ['/workspaces/issue-1/app'],
  desiredResult: 'md',
  previousOutcome: null,
  attachmentPaths: [],
});

const options = (): RoomResolveOptions => ({
  stepRunId: 'run-1',
  iterationId: 'iter-1',
  issueId: 'issue-1',
});

const pass = (summary: string): StepExecutionResult => ({
  step: STEP,
  exitCode: 0,
  report: { status: 'pass', summary },
  stdout: '',
  stderr: '',
});

/** Секция трейса: этап staged-плана, «комната» (room) или финальный lead. */
function sectionOf(id: string, finalId: string): string {
  const stage = /\/stage\/(\d+)\//.exec(id);
  if (stage) return `этап ${stage[1]}`;
  if (id === finalId) return 'финал';
  return 'комната';
}

/**
 * Печатает и возвращает читаемый трейс порядка запуска агентов:
 * воркеры одной параллельной фазы помечаются `∥`, смена секции — `---`.
 */
function traceTopology(
  title: string,
  pi: FakePiRunner,
  finalId: string,
): string {
  const entries = pi.calls.map((call: PiRunCall) => {
    const id = call.options?.agent?.id ?? call.options?.stepRunId ?? '?';
    const label = call.options?.agent?.label ?? '(без метки)';
    return {
      id,
      label,
      section: sectionOf(id, finalId),
      worker: /\/worker\/\d+$/.test(id),
    };
  });

  // Воркер параллелен, если рядом с ним в той же секции есть другой воркер.
  const parallel = entries.map((entry, i) => {
    if (!entry.worker) return false;
    const sameWorkerRun = (other?: (typeof entries)[number]): boolean =>
      !!other && other.worker && other.section === entry.section;
    return sameWorkerRun(entries[i - 1]) || sameWorkerRun(entries[i + 1]);
  });

  const lines: string[] = [`=== Топология: ${title} ===`];
  let prevSection: string | null = null;
  entries.forEach((entry, i) => {
    if (prevSection !== null && entry.section !== prevSection) {
      lines.push('---');
    }
    prevSection = entry.section;
    const marker = parallel[i] ? '∥' : ' ';
    lines.push(
      `[${String(i + 1).padStart(2, '0')}] ${marker} ${entry.id} — ${entry.label}`,
    );
  });
  const text = lines.join('\n');
  console.log(`\n${text}\n`);
  return text;
}

describe('топологии исполнения resolve — демо-примеры', () => {
  it('single: движок решает «один агент» (без комнаты/этапов)', () => {
    // single движок исполняет прямым `pi.run`, а не room.ts — поэтому здесь
    // фиксируем детерминированное решение `planExecutionMode` (развилка
    // engine.ts). Остальные три топологии прогоняются по-настоящему ниже.
    expect(planExecutionMode(SINGLE_PLAN)).toBe('single');
    expect(planExecutionMode(ROOM_PLAN)).toBe('room');
    expect(planExecutionMode(SEQUENTIAL_STAGES_PLAN)).toBe('stages');
    expect(planExecutionMode(COMPLEX_STAGES_PLAN)).toBe('stages');
  });

  it('room: 3 воркера ∥, затем один координатор (id = stepRunId)', async () => {
    const pi = new FakePiRunner();
    const control = new InMemoryStepSessionRegistry();
    pi.enqueue(pass('w-backend'));
    pi.enqueue(pass('w-frontend'));
    pi.enqueue(pass('w-tests'));
    pi.enqueue(pass('room-coord'));

    const result = await runRoomResolve(
      pi,
      input(ROOM_PLAN),
      { ...options(), registry: control },
    );

    traceTopology('room — параллельно', pi, 'run-1');

    // 3 воркера (0-based id в room-режиме) → 1 координатор.
    expect(pi.calls.map((c) => c.options?.stepRunId)).toEqual([
      'run-1/worker/0',
      'run-1/worker/1',
      'run-1/worker/2',
      'run-1',
    ]);
    expect(pi.calls.slice(0, 3).map((c) => c.options?.agent?.label)).toEqual([
      'Воркер 1',
      'Воркер 2',
      'Воркер 3',
    ]);
    expect(pi.calls[3].options?.agent).toMatchObject({
      id: 'run-1',
      role: 'coordinator',
      index: null,
      label: 'Координатор',
    });
    // Итог шага — отчёт координатора.
    expect(result.report?.summary).toBe('room-coord');
  });

  it('stages 3×1: три агента-этапа строго последовательно + финальный lead', async () => {
    const pi = new FakePiRunner();
    pi.enqueue(pass('design'));
    pi.enqueue(pass('impl'));
    pi.enqueue(pass('check'));
    pi.enqueue(pass('seq-final'));

    const result = await runStagedResolve(
      pi,
      input(SEQUENTIAL_STAGES_PLAN),
      options(),
    );

    traceTopology('stages 3×1 — последовательно', pi, 'run-1');

    // executors=1 → один агент-этап на этап (никаких /worker/), затем финал.
    expect(pi.calls.map((c) => c.options?.stepRunId)).toEqual([
      'run-1/stage/1/coordinator',
      'run-1/stage/2/coordinator',
      'run-1/stage/3/coordinator',
      'run-1',
    ]);
    expect(pi.calls.map((c) => c.options?.agent?.label)).toEqual([
      'Этап 1 · Координатор',
      'Этап 2 · Координатор',
      'Этап 3 · Координатор',
      'Координатор',
    ]);
    expect(result.report?.summary).toBe('seq-final');
  });

  it('stages-сложный 2→1→3: параллель, последовательность, параллель, финал', async () => {
    const pi = new FakePiRunner();
    // этап 1: 2 воркера ∥ + координатор
    pi.enqueue(pass('s1-be'));
    pi.enqueue(pass('s1-fe'));
    pi.enqueue(pass('s1-coord'));
    // этап 2: 1 агент
    pi.enqueue(pass('s2'));
    // этап 3: 3 воркера ∥ + координатор
    pi.enqueue(pass('s3-tests'));
    pi.enqueue(pass('s3-docs'));
    pi.enqueue(pass('s3-review'));
    pi.enqueue(pass('s3-coord'));
    // финальный lead
    pi.enqueue(pass('complex-final'));

    const result = await runStagedResolve(
      pi,
      input(COMPLEX_STAGES_PLAN),
      options(),
    );

    traceTopology('stages-сложный 2→1→3', pi, 'run-1');

    // Строгий порядок: этап1 (воркеры ∥ → координатор) → этап2 (1 агент) →
    // этап3 (воркеры ∥ → координатор) → финальный lead.
    expect(pi.calls.map((c) => c.options?.stepRunId)).toEqual([
      'run-1/stage/1/worker/1',
      'run-1/stage/1/worker/2',
      'run-1/stage/1/coordinator',
      'run-1/stage/2/coordinator',
      'run-1/stage/3/worker/1',
      'run-1/stage/3/worker/2',
      'run-1/stage/3/worker/3',
      'run-1/stage/3/coordinator',
      'run-1',
    ]);
    // Финальный lead регистрируется со stage=null (фолбек координатора шага).
    expect(pi.calls[8].options?.agent?.stage).toBeUndefined();
    expect(pi.calls[8].options?.agent?.label).toBe('Координатор');
    expect(result.report?.summary).toBe('complex-final');
  });
});