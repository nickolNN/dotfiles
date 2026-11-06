import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  MAX_SELF_RETRIES,
  PipelineStep,
  StepReportStatus,
  StepRunStatus,
  parseStepReport,
  type SSEEvent,
  type StepReport,
} from '@issue-resolver/shared';
import { applyRefineGate } from '../src/workflow/iteration/refine-gate';
import type { WorkflowDeps } from '../src/workflow/iteration/contracts';
import { InMemorySseHub } from '../src/sse/hub';

interface StepRunPatch {
  id: string;
  status?: StepRunStatus;
  feedback?: string | null;
}

interface GateHarness {
  deps: WorkflowDeps;
  events: SSEEvent[];
  updated: StepRunPatch[];
  dir: string;
}

function makeHarness(): GateHarness {
  const sse = new InMemorySseHub();
  const events: SSEEvent[] = [];
  sse.subscribeGlobal((event) => events.push(event));
  const updated: StepRunPatch[] = [];
  const deps = {
    sse,
    store: {
      updateStepRun: async (id: string, patch: StepRunPatch) => {
        updated.push({ ...patch, id });
        return { id };
      },
    },
  } as unknown as WorkflowDeps;
  return { deps, events, updated, dir: mkdtempSync(join(tmpdir(), 'refine-gate-')) };
}

async function gateWith(
  report: StepReport,
  stepRetries = 0,
): Promise<{ harness: GateHarness; gate: Awaited<ReturnType<typeof applyRefineGate>> }> {
  const harness = makeHarness();
  const gate = await applyRefineGate({
    deps: harness.deps,
    issueId: 'issue-1',
    iterationId: 'iteration-1',
    stepRunId: 'run-1',
    agentWorkingDir: harness.dir,
    workspaceHostDir: harness.dir,
    steps: [PipelineStep.refine, PipelineStep.resolve],
    maxExecutors: 2,
    report,
    stepRetries,
  });
  return { harness, gate };
}

const notices = (harness: GateHarness): string =>
  harness.events.map((event) => event.data).join('\n');

describe('applyRefineGate — unreadable execution plan', () => {
  it('retries the planner instead of silently running a single agent', async () => {
    const { harness, gate } = await gateWith({
      status: StepReportStatus.pass,
      summary: 'ok',
      executionMalformed: true,
    });

    expect(gate.kind).toBe('retry');
    expect(gate).toMatchObject({
      feedback: expect.stringContaining(
        'execution is present but unreadable — mode must be single or stages',
      ),
    });
    expect(notices(harness)).toContain('Перепланирование 1/');
    expect(notices(harness)).not.toContain('не вернул execution-план');
    expect(harness.updated).toEqual([
      {
        id: 'run-1',
        status: StepRunStatus.failed,
        feedback:
          'refine: execution-план отклонён — execution is present but unreadable — mode must be single or stages.',
      },
    ]);
  });

  it('retries a report whose execution is the retired room mode', async () => {
    const report = parseStepReport(
      JSON.stringify({
        status: 'pass',
        summary: 'ok',
        execution: { mode: 'room', executors: 2, decomposition: ['a', 'b'] },
      }),
    );
    if (report === null) throw new Error('the report must parse');

    expect(report.executionMalformed).toBe(true);

    const { harness, gate } = await gateWith(report);

    expect(gate.kind).toBe('retry');
    expect(harness.updated).toEqual([
      {
        id: 'run-1',
        status: StepRunStatus.failed,
        feedback: expect.stringContaining('execution-план отклонён'),
      },
    ]);
  });

  it('fails the refine step when the replan budget is spent', async () => {
    const { harness, gate } = await gateWith(
      {
        status: StepReportStatus.pass,
        summary: 'ok',
        executionMalformed: true,
      },
      MAX_SELF_RETRIES.refine ?? 0,
    );

    expect(gate.kind).toBe('failed');
    expect(harness.updated).toEqual([
      {
        id: 'run-1',
        status: StepRunStatus.failed,
        feedback: expect.stringContaining('execution-план отклонён'),
      },
    ]);
    expect(notices(harness)).toContain('бюджет перепланирования исчерпан');
  });

  it('keeps a readable plan planned, with no retry', async () => {
    const { harness, gate } = await gateWith({
      status: StepReportStatus.pass,
      summary: 'ok',
      execution: { mode: 'single' },
    });

    expect(gate).toMatchObject({ kind: 'planned', refinedExecution: { mode: 'single' } });
    expect(harness.updated).toEqual([]);
    expect(notices(harness)).not.toContain('Перепланирование');
  });
});