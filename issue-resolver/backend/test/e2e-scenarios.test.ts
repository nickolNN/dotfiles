import type { SessionEvent } from '@issue-resolver/shared';
import { describe, expect, it } from 'vitest';
import { InMemoryStepSessionRegistry } from '../src/pi/session-registry';
import { ScenarioController, ScenarioPiRunner } from './e2e-scenarios';

const run = (
  runner: ScenarioPiRunner,
  step: string,
  iterationId = 'it',
  extra: { stepRunId?: string; registry?: InMemoryStepSessionRegistry } = {},
) =>
  runner.run('container', `Pipeline step: ${step}.`, {
    iterationId,
    stepRunId: extra.stepRunId ?? 'step-run',
    registry: extra.registry,
  });

describe('ScenarioPiRunner', () => {
  it('дефолт — all-success с шагом из промпта', async () => {
    const runner = new ScenarioPiRunner(new ScenarioController());
    const result = await run(runner, 'refine');
    expect(result.step).toBe('refine');
    expect(result.exitCode).toBe(0);
    expect(result.report?.status).toBe('pass');
  });

  it('failure отдаёт exit 1 и fail-отчёт', async () => {
    const controller = new ScenarioController();
    controller.set({ steps: [{ type: 'failure', reportData: { summary: 'boom' } }] });
    const result = await run(new ScenarioPiRunner(controller), 'resolve');
    expect(result.exitCode).toBe(1);
    expect(result.report).toMatchObject({ status: 'fail', summary: 'boom' });
  });

  it('timeout реджектит (движок пометит шаг failed)', async () => {
    const controller = new ScenarioController();
    controller.set({ steps: [{ type: 'timeout' }] });
    await expect(run(new ScenarioPiRunner(controller), 'resolve')).rejects.toThrow(
      /timed out/,
    );
  });

  it('question эмитит вопрос и ждёт ответ через реестр', async () => {
    const controller = new ScenarioController();
    controller.set({
      questionTimeoutMs: 1000,
      steps: [
        {
          type: 'question',
          questionEvent: { question: 'Нужен ответ', options: ['да', 'нет'] },
        },
      ],
    });
    const runner = new ScenarioPiRunner(controller);
    const registry = new InMemoryStepSessionRegistry();
    const events: SessionEvent[] = [];
    const promise = runner.run('container', 'Pipeline step: resolve.', {
      iterationId: 'it',
      stepRunId: 'step-run',
      registry,
      onEvent: (event) => events.push(event),
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(registry.respondByIteration('it', { id: 'q', value: 'да' })).toBe(true);
    await promise;
    expect(events.some((event) => event.type === 'question')).toBe(true);
    const answered = events.find((event) => event.type === 'question_answered');
    expect(answered && answered.type === 'question_answered' && answered.answer).toBe(
      'да',
    );
  });

  it('курсор шагов — на итерацию, параллельные задачи независимы', async () => {
    const controller = new ScenarioController();
    controller.set({ steps: [{ type: 'success' }, { type: 'failure' }] });
    const runner = new ScenarioPiRunner(controller);
    const [firstA, firstB] = await Promise.all([
      run(runner, 'resolve', 'it-a'),
      run(runner, 'resolve', 'it-b'),
    ]);
    expect(firstA.exitCode).toBe(0);
    expect(firstB.exitCode).toBe(0);
    const [secondA, secondB] = await Promise.all([
      run(runner, 'resolve', 'it-a'),
      run(runner, 'resolve', 'it-b'),
    ]);
    expect(secondA.exitCode).toBe(1);
    expect(secondB.exitCode).toBe(1);
  });

  it('clearCursors возвращает курсор к началу', async () => {
    const controller = new ScenarioController();
    controller.set({ steps: [{ type: 'success' }, { type: 'failure' }] });
    const runner = new ScenarioPiRunner(controller);
    await run(runner, 'resolve', 'it');
    runner.clearCursors();
    const afterReset = await run(runner, 'resolve', 'it');
    expect(afterReset.exitCode).toBe(0);
  });
});