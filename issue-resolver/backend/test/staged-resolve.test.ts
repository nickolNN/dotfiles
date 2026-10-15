import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';import type {
  ExecutionPlan,
  PipelineStep,
  StepExecutionResult,
} from '@issue-resolver/shared';
import { FakePiRunner } from '../src/pi/runner';
import { InMemoryStepSessionRegistry } from '../src/pi/session-registry';
import {
  runStagedResolve,
  type RoomResolveInput,
  type RoomResolveOptions,
} from '../src/workflow/room';

const STEP: PipelineStep = 'resolve';

/** Временные папки тестов (чистятся в afterEach). */
const dirs: string[] = [];

afterEach(() => {
  while (dirs.length > 0) {
    rmSync(dirs.pop() as string, { recursive: true, force: true });
  }
});

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

const options = (
  control?: InMemoryStepSessionRegistry,
): RoomResolveOptions => ({
  stepRunId: 'run-1',
  iterationId: 'iter-1',
  issueId: 'issue-1',
  ...(control ? { registry: control } : {}),
});

const pass = (summary: string): StepExecutionResult => ({
  step: STEP,
  exitCode: 0,
  report: { status: 'pass', summary },
  stdout: '',
  stderr: '',
});

const aborted = (summary: string): StepExecutionResult => ({
  step: STEP,
  exitCode: 1,
  report: { status: 'fail', summary },
  stdout: '',
  stderr: '',
  aborted: true,
});

/** Реальный раннер заполняет `report` только при abort — обычный исход null. */
const noReport = (): StepExecutionResult => ({
  step: STEP,
  exitCode: 0,
  report: null,
  stdout: '',
  stderr: '',
});

const twoStages: ExecutionPlan = {
  mode: 'stages',
  stages: [
    {
      index: 1,
      name: 'Сбор',
      task: 'собрать',
      executors: 2,
      decomposition: ['a', 'b'],
    },
    { index: 2, name: 'Починка', task: 'починить', executors: 1 },
  ],
};

/** Три одиночных этапа — для проверки resume по файлам исходов. */
const threeStages: ExecutionPlan = {
  mode: 'stages',
  stages: [
    { index: 1, name: 'One', task: 't1', executors: 1 },
    { index: 2, name: 'Two', task: 't2', executors: 1 },
    { index: 3, name: 'Three', task: 't3', executors: 1 },
  ],
};

describe('runStagedResolve — последовательные этапы', () => {
  it('этап1 воркеры → координатор этапа1 → этап2 → финальный lead; id со /stage/', async () => {
    const pi = new FakePiRunner();
    const control = new InMemoryStepSessionRegistry();
    pi.enqueue(pass('s1w1'));
    pi.enqueue(pass('s1w2'));
    pi.enqueue(pass('s1coord'));
    pi.enqueue(pass('s2'));
    pi.enqueue(pass('final'));

    const result = await runStagedResolve(pi, input(twoStages), options(control));

    // Итог шага — результат финального lead.
    expect(result.report?.summary).toBe('final');

    // Строгий порядок: воркеры этапа 1 → координатор этапа 1 → этап 2 (1 агент)
    // → финальный координатор.
    expect(pi.calls.map((call) => call.options?.stepRunId)).toEqual([
      'run-1/stage/1/worker/1',
      'run-1/stage/1/worker/2',
      'run-1/stage/1/coordinator',
      'run-1/stage/2/coordinator',
      'run-1',
    ]);

    // Промпты воркеров: свой файл этапа, peer не lead, имя этапа.
    expect(pi.calls[0].prompt).toContain('NOT the lead');
    expect(pi.calls[0].prompt).toContain('Сбор');
    expect(pi.calls[0].prompt).toContain('.issue-stage-1-worker-1.json');
    expect(pi.calls[1].prompt).toContain('.issue-stage-1-worker-2.json');

    // Координатор этапа 1: интегрирует воркеров, пишет файл этапа (не финал),
    // читает/пишет общую память.
    expect(pi.calls[2].prompt).toContain('Stage 1');
    expect(pi.calls[2].prompt).toContain('s1w1');
    expect(pi.calls[2].prompt).toContain('s1w2');
    expect(pi.calls[2].prompt).toContain('.issue-stage-1.json');
    expect(pi.calls[2].prompt).toContain('memory_read');
    expect(pi.calls[2].prompt).toContain('memory_search');
    expect(pi.calls[2].prompt).toContain('memory_write');
    expect(pi.calls[2].prompt).not.toContain('.issue-worker-result-');

    // Этап 2 (executors=1) — один агент-этап, без воркеров.
    expect(pi.calls[3].prompt).toContain('Починка');
    expect(pi.calls[3].prompt).toContain('.issue-stage-2.json');

    // Финальный lead: исходы обоих этапов, deliverable и финальный отчёт, память.
    expect(pi.calls[4].prompt).toContain('LEAD');
    expect(pi.calls[4].prompt).toContain('s1coord');
    expect(pi.calls[4].prompt).toContain('s2');
    expect(pi.calls[4].prompt).toContain('report.md');
    expect(pi.calls[4].prompt).toContain('.issue-step-result.json');
    expect(pi.calls[4].prompt).toContain('memory_write');

    // Агенты этапов регистрируются с stage/stageName.
    expect(control.listAgents('iter-1').map((agent) => agent.stage)).toEqual([
      1, 1, 1, 2, null,
    ]);
    expect(control.listAgents('iter-1')[0]).toMatchObject({
      id: 'run-1/stage/1/worker/1',
      role: 'worker',
      index: 1,
      label: 'Этап 1 · Воркер 1',
      stage: 1,
      stageName: 'Сбор',
    });
    expect(control.listAgents('iter-1')[2]).toMatchObject({
      id: 'run-1/stage/1/coordinator',
      role: 'coordinator',
      index: null,
      label: 'Этап 1 · Координатор',
      stage: 1,
      stageName: 'Сбор',
    });
  });

  it('abort воркера этапа → сразу aborted; координатор и следующие этапы не стартуют', async () => {
    const pi = new FakePiRunner();
    pi.enqueue(aborted('boom'));
    pi.enqueue(pass('s1w2'));

    const result = await runStagedResolve(pi, input(twoStages), options());

    expect(result.aborted).toBe(true);
    expect(result.report).toEqual({ status: 'fail', summary: 'aborted' });
    // Только два воркера этапа 1 (Promise.all ждёт оба), без координатора.
    expect(pi.calls).toHaveLength(2);
    expect(pi.calls.map((call) => call.options?.stepRunId)).toEqual([
      'run-1/stage/1/worker/1',
      'run-1/stage/1/worker/2',
    ]);
  });

  it('abort координатора этапа → финальный lead и следующие этапы не стартуют', async () => {
    const pi = new FakePiRunner();
    pi.enqueue(pass('s1w1'));
    pi.enqueue(pass('s1w2'));
    pi.enqueue(aborted('coord boom'));

    const result = await runStagedResolve(pi, input(twoStages), options());

    expect(result.aborted).toBe(true);
    expect(pi.calls).toHaveLength(3);
    expect(pi.calls[2].options?.stepRunId).toBe('run-1/stage/1/coordinator');
  });

  it('executors=1 этап = один вызов, отдельного воркера нет', async () => {
    const pi = new FakePiRunner();
    const execution: ExecutionPlan = {
      mode: 'stages',
      stages: [
        { index: 1, name: 'One', task: 't1', executors: 1 },
        { index: 2, name: 'Two', task: 't2' },
      ],
    };
    pi.enqueue(pass('stage1'));
    pi.enqueue(pass('stage2'));
    pi.enqueue(pass('final'));

    await runStagedResolve(pi, input(execution), options());

    expect(pi.calls.map((call) => call.options?.stepRunId)).toEqual([
      'run-1/stage/1/coordinator',
      'run-1/stage/2/coordinator',
      'run-1',
    ]);
  });

  it('саммари для координатора читаются из файлов отчётов, когда раннер не вернул report', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ir-room-files-'));
    dirs.push(dir);
    const write = (name: string, summary: string): void =>
      writeFileSync(
        join(dir, name),
        JSON.stringify({ status: 'pass', summary }),
        'utf8',
      );
    // Файлов этапов нет — resume не срабатывает, все этапы исполняются;
    // воркер-отчёты читаются с диска.
    write('.issue-stage-1-worker-1.json', 'w1 из файла');
    write('.issue-stage-1-worker-2.json', 'w2 из файла');

    const pi = new FakePiRunner();
    pi.enqueue(noReport());
    pi.enqueue(noReport());
    pi.enqueue(noReport());
    pi.enqueue(noReport());
    pi.enqueue(noReport());

    await runStagedResolve(pi, input(twoStages), {
      ...options(),
      hostWorkspaceDir: dir,
    });

    // Координатор этапа видит содержимое файлов воркеров, а не «(see …)».
    expect(pi.calls[2].prompt).toContain('`.issue-stage-1-worker-1.json`: w1 из файла');
    expect(pi.calls[2].prompt).toContain('`.issue-stage-1-worker-2.json`: w2 из файла');
    expect(pi.calls[2].prompt).not.toContain('(see ');
    // Файлов этапов нет — финальный lead падает в фолбек «(see …)».
    expect(pi.calls[4].prompt).toContain('`.issue-stage-1.json`: (see .issue-stage-1.json)');
  });
});

describe('runStagedResolve — resume по файлам исходов этапов', () => {
  const writeOutcome = (dir: string, index: number, summary: string): void =>
    writeFileSync(
      join(dir, `.issue-stage-${index}.json`),
      JSON.stringify({ status: 'pass', summary }),
      'utf8',
    );

  it('этапы 1–2 готовы → исполняется только этап 3 и финальный lead; исходы 1–2 переданы', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ir-room-resume-'));
    dirs.push(dir);
    writeOutcome(dir, 1, 'этап1 готов');
    writeOutcome(dir, 2, 'этап2 готов');

    const pi = new FakePiRunner();
    pi.enqueue(noReport()); // этап 3
    pi.enqueue(noReport()); // финальный lead

    await runStagedResolve(pi, input(threeStages), {
      ...options(),
      hostWorkspaceDir: dir,
    });

    // Этапы 1–2 не перезапускаются: сразу этап 3 + финал.
    expect(pi.calls.map((call) => call.options?.stepRunId)).toEqual([
      'run-1/stage/3/coordinator',
      'run-1',
    ]);
    // Финальный lead видит исходы уже готовых этапов из их файлов.
    expect(pi.calls[1].prompt).toContain('`.issue-stage-1.json`: этап1 готов');
    expect(pi.calls[1].prompt).toContain('`.issue-stage-2.json`: этап2 готов');
    // Исход этапа 3 (только что прогнанного) тоже доходит до финального lead.
    expect(pi.calls[1].prompt).toContain('`.issue-stage-3.json`: (see .issue-stage-3.json)');
  });

  it('все этапы готовы → запускается только финальный lead (ни одного этапа)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ir-room-resume-all-'));
    dirs.push(dir);
    writeOutcome(dir, 1, 'готов1');
    writeOutcome(dir, 2, 'готов2');
    writeOutcome(dir, 3, 'готов3');

    const pi = new FakePiRunner();
    pi.enqueue(noReport()); // только финальный lead

    await runStagedResolve(pi, input(threeStages), {
      ...options(),
      hostWorkspaceDir: dir,
    });

    expect(pi.calls.map((call) => call.options?.stepRunId)).toEqual(['run-1']);
    expect(pi.calls[0].prompt).toContain('`.issue-stage-1.json`: готов1');
    expect(pi.calls[0].prompt).toContain('`.issue-stage-3.json`: готов3');
  });

  it('нет файлов исходов → все этапы с 1 (поведение не изменилось)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ir-room-resume-empty-'));
    dirs.push(dir);

    const pi = new FakePiRunner();
    pi.enqueue(noReport()); // этап 1
    pi.enqueue(noReport()); // этап 2
    pi.enqueue(noReport()); // этап 3
    pi.enqueue(noReport()); // финальный lead

    await runStagedResolve(pi, input(threeStages), {
      ...options(),
      hostWorkspaceDir: dir,
    });

    expect(pi.calls.map((call) => call.options?.stepRunId)).toEqual([
      'run-1/stage/1/coordinator',
      'run-1/stage/2/coordinator',
      'run-1/stage/3/coordinator',
      'run-1',
    ]);
  });

  it('испорченный файл этапа → этап считается незавершённым и перезапускается', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ir-room-resume-bad-'));
    dirs.push(dir);
    writeFileSync(join(dir, '.issue-stage-1.json'), '{ not json', 'utf8');

    const pi = new FakePiRunner();
    pi.enqueue(noReport()); // этап 1 (перезапуск)
    pi.enqueue(noReport()); // этап 2
    pi.enqueue(noReport()); // этап 3
    pi.enqueue(noReport()); // финальный lead

    await runStagedResolve(pi, input(threeStages), {
      ...options(),
      hostWorkspaceDir: dir,
    });

    expect(pi.calls.map((call) => call.options?.stepRunId)).toEqual([
      'run-1/stage/1/coordinator',
      'run-1/stage/2/coordinator',
      'run-1/stage/3/coordinator',
      'run-1',
    ]);
  });

  it('без hostWorkspaceDir → все этапы с 1 (in-memory фейки не ломаются)', async () => {
    const pi = new FakePiRunner();
    pi.enqueue(noReport());
    pi.enqueue(noReport());
    pi.enqueue(noReport());
    pi.enqueue(noReport());

    await runStagedResolve(pi, input(threeStages), options());

    expect(pi.calls.map((call) => call.options?.stepRunId)).toEqual([
      'run-1/stage/1/coordinator',
      'run-1/stage/2/coordinator',
      'run-1/stage/3/coordinator',
      'run-1',
    ]);
  });
});