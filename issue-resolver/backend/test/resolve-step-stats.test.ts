/**
 * `runRoomResolve`/`runStagedResolve` должны возвращать в результате шага
 * (`result.stats` → step_outputs.stats) СУММУ телеметрии всех агентов шага:
 * воркеров, координаторов этапов и финального координатора, а не stats
 * последнего агента. `cost` суммируется только по не-null значениям.
 */
import { describe, expect, it } from 'vitest';
import type {
  ExecutionPlan,
  PipelineStep,
  SessionStats,
  StepExecutionResult,
} from '@issue-resolver/shared';
import { FakePiRunner } from '../src/pi/runner';
import {
  runRoomResolve,
  runStagedResolve,
  type RoomResolveInput,
  type RoomResolveOptions,
} from '../src/workflow/room';
import { COMPLEX_STAGES_PLAN, ROOM_PLAN } from './execution-plans.example';

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

/** Статистика агента с уникальным `n`, чтобы сумма отличалась от любого одного. */
const statsWith = (n: number): SessionStats => ({
  userMessages: n,
  assistantMessages: n * 2,
  toolCalls: n * 3,
  toolResults: n * 4,
  totalMessages: n * 5,
  tokens: {
    input: n * 100,
    output: n * 10,
    cacheRead: n,
    cacheWrite: n * 2,
    total: n * 113,
  },
  cost: n / 1000,
  contextUsage: null,
});

const pass = (summary: string, stats: SessionStats | null): StepExecutionResult => ({
  step: STEP,
  exitCode: 0,
  report: { status: 'pass', summary },
  stdout: '',
  stderr: '',
  stats,
});

/** Сумма статистики n=1..count — ожидаемый агрегат набора агентов. */
const sumOf = (count: number): SessionStats => {
  let acc = statsWith(0);
  for (let n = 1; n <= count; n += 1) {
    const next = statsWith(n);
    acc = {
      ...acc,
      userMessages: acc.userMessages + next.userMessages,
      assistantMessages: acc.assistantMessages + next.assistantMessages,
      toolCalls: acc.toolCalls + next.toolCalls,
      toolResults: acc.toolResults + next.toolResults,
      totalMessages: acc.totalMessages + next.totalMessages,
      tokens: {
        input: acc.tokens.input + next.tokens.input,
        output: acc.tokens.output + next.tokens.output,
        cacheRead: acc.tokens.cacheRead + next.tokens.cacheRead,
        cacheWrite: acc.tokens.cacheWrite + next.tokens.cacheWrite,
        total: acc.tokens.total + next.tokens.total,
      },
      cost: (acc.cost ?? 0) + (next.cost ?? 0),
    };
  }
  return acc;
};

describe('runRoomResolve — stats шага = сумма всех агентов', () => {
  it('room: 3 воркера + координатор, cost и токены суммируются', async () => {
    const pi = new FakePiRunner();
    for (let n = 1; n <= 4; n += 1) {
      pi.enqueue(pass(`agent-${n}`, statsWith(n)));
    }

    const result = await runRoomResolve(pi, input(ROOM_PLAN), options());

    expect(result.report?.summary).toBe('agent-4');
    expect(result.stats).toEqual(sumOf(4));
    // Не телеметрия одного координатора (n=4).
    expect(result.stats?.tokens.input).not.toBe(400);
  });

  it('room: все агенты без stats → result.stats null', async () => {
    const pi = new FakePiRunner();
    for (let n = 1; n <= 4; n += 1) pi.enqueue(pass(`agent-${n}`, null));

    const result = await runRoomResolve(pi, input(ROOM_PLAN), options());

    expect(result.stats).toBeNull();
  });
});

describe('runStagedResolve — stats шага = сумма всех агентов этапов и финала', () => {
  it('сложный stages 2→1→3: суммируются воркеры, координаторы этапов и финал', async () => {
    const pi = new FakePiRunner();
    // 2 воркера + координатор этапа 1, 1 агент этапа 2, 3 воркера +
    // координатор этапа 3, финальный lead → 9 агентов.
    for (let n = 1; n <= 9; n += 1) {
      pi.enqueue(pass(`agent-${n}`, statsWith(n)));
    }

    const result = await runStagedResolve(
      pi,
      input(COMPLEX_STAGES_PLAN),
      options(),
    );

    expect(pi.calls).toHaveLength(9);
    expect(result.report?.summary).toBe('agent-9');
    expect(result.stats).toEqual(sumOf(9));
    // Не телеметрия финального координатора (n=9).
    expect(result.stats?.tokens.input).not.toBe(900);
  });

  it('все агенты без stats → result.stats null', async () => {
    const pi = new FakePiRunner();
    for (let n = 1; n <= 9; n += 1) pi.enqueue(pass(`agent-${n}`, null));

    const result = await runStagedResolve(
      pi,
      input(COMPLEX_STAGES_PLAN),
      options(),
    );

    expect(result.stats).toBeNull();
  });
});