/**
 * Регрессия на ЛОЖНЫЙ abort resolve-шага.
 *
 * Живой кейс: refine выбрал `{mode:'single'}`, а шаг остался `aborted` с пустым
 * step_output (report null, событий нет). Аудит `workflow/room.ts` и
 * `workflow/engine.ts` показал, что нормальный прогон пометить aborted НЕ может:
 *
 *  - `runRoomResolve`/`runStagedResolve` возвращают `abortedResolveResult()`
 *    ровно тогда, когда хотя бы один результат агента несёт
 *    `aborted === true` (строгое сравнение), иначе отдают отчёт последнего
 *    координатора как есть;
 *  - `engine.ts` переводит шаг в `aborted` только при `result.aborted`, а
 *    `stepRunStatusFromResult(exitCode, report)` для pass-результата даёт
 *    `success`.
 *
 * `aborted: true` в StepExecutionResult выставляет только rpc-runner — при
 * явном abort-подписчике (`committedAbort`) или `agent_settled{aborted:true}`.
 * Нормальный `exitCode 0` + pass-отчёт туда не попадает.
 *
 * Этот тест фиксирует инвариант: если ВСЕ агенты комнаты/этапов вернули pass,
 * resolve-результат не aborted, а его step-статус — `success`.
 */
import { describe, expect, it } from 'vitest';
import type {
  ExecutionPlan,
  PipelineStep,
  StepExecutionResult,
} from '@issue-resolver/shared';
import { stepRunStatusFromResult } from '@issue-resolver/shared';
import { FakePiRunner } from '../src/pi/runner';
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

/**
 * Общие проверки нормального (не-abort) resolve-результата:
 * флага abort нет, exit 0, отчёт pass, движковая свёртка → success.
 */
function expectSuccessfulResolve(result: StepExecutionResult): void {
  expect(result.aborted).toBeUndefined();
  expect(Object.prototype.hasOwnProperty.call(result, 'aborted')).toBe(false);
  expect(result.exitCode).toBe(0);
  expect(result.report?.status).toBe('pass');
  expect(stepRunStatusFromResult(result.exitCode, result.report)).toBe(
    'success',
  );
}

describe('resolve не становится aborted, когда все агенты вернули pass', () => {
  it('room: все исполнители и координатор pass → результат pass/success, не aborted', async () => {
    const pi = new FakePiRunner();
    // ROOM_PLAN: executors=3 → 3 исполнителя ∥ + 1 координатор.
    for (const summary of ['w1', 'w2', 'w3', 'coord']) {
      pi.enqueue(pass(summary));
    }

    const result = await runRoomResolve(pi, input(ROOM_PLAN), options());

    expectSuccessfulResolve(result);
    // Итог шага — отчёт финального координатора (не исполнителя).
    expect(result.report?.summary).toBe('coord');
    // Координатор действительно запускался последним.
    expect(pi.calls.map((call) => call.options?.stepRunId)).toEqual([
      'run.run-1.w0',
      'run.run-1.w1',
      'run.run-1.w2',
      'run-1',
    ]);
  });

  it('stages 3×1: каждый этап pass → финальный lead pass/success, не aborted', async () => {
    const pi = new FakePiRunner();
    for (const summary of ['design', 'impl', 'check', 'final']) {
      pi.enqueue(pass(summary));
    }

    const result = await runStagedResolve(
      pi,
      input(SEQUENTIAL_STAGES_PLAN),
      options(),
    );

    expectSuccessfulResolve(result);
    expect(result.report?.summary).toBe('final');
  });

  it('stages-сложный 2→1→3: все исполнители и координаторы pass → финал pass/success, не aborted', async () => {
    const pi = new FakePiRunner();
    for (const summary of [
      's1-be',
      's1-fe',
      's1-coord',
      's2',
      's3-tests',
      's3-docs',
      's3-review',
      's3-coord',
      'complex-final',
    ]) {
      pi.enqueue(pass(summary));
    }

    const result = await runStagedResolve(
      pi,
      input(COMPLEX_STAGES_PLAN),
      options(),
    );

    expectSuccessfulResolve(result);
    expect(result.report?.summary).toBe('complex-final');
    // Ни один вызванный агент не получил abort-команду.
    expect(pi.controlCalls).toEqual([]);
  });

  it('контроль: aborted появляется ТОЛЬКО когда раннер сам отдал aborted:true', async () => {
    // Негативный контроль к трём сценариям выше: единственный источник флага —
    // явный aborted-результат агента, а не нормальный pass.
    const pi = new FakePiRunner();
    pi.enqueue({
      step: STEP,
      exitCode: 1,
      report: { status: 'fail', summary: 'aborted' },
      stdout: '',
      stderr: '',
      aborted: true,
    });

    const result = await runRoomResolve(pi, input(ROOM_PLAN), options());

    expect(result.aborted).toBe(true);
    expect(stepRunStatusFromResult(result.exitCode, result.report)).toBe(
      'failed',
    );
  });
});