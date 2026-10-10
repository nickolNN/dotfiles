import type {
  ExecutionPlan,
  RoomWorkItem,
  SessionEvent,
  StepExecutionResult,
} from '@issue-resolver/shared';
import {
  clampExecutors,
  DEFAULT_MAX_ROOM_EXECUTORS,
  planRoomWorkItems,
} from '@issue-resolver/shared';
import type { PiRunner } from '../pi/runner';
import type { RoomAgentInfo, StepSessionRegistry } from '../pi/session-registry';
import {
  buildRoomCoordinatorPrompt,
  buildRoomWorkerPrompt,
  type RoomPromptInput,
  type WorkerSummary,
} from './prompts';

/** Вход комнаты resolve: общий prompt-контекст + план и адрес контейнера. */
export interface RoomResolveInput extends RoomPromptInput {
  containerName: string;
  execution: ExecutionPlan;
  /** Потолок числа исполнителей; по умолчанию DEFAULT_MAX_ROOM_EXECUTORS. */
  maxExecutors?: number;
}

/** Опции прогона комнаты: модель/cwd, адрес шага и живые колбэки. */
export interface RoomResolveOptions {
  model?: string;
  /** Уровень размышления pi, общий для работников и координатора. */
  thinkingLevel?: string;
  cwd?: string;
  /** stepRunId ШАГА resolve; работники получают `${stepRunId}/worker/<i>`. */
  stepRunId: string;
  iterationId: string;
  issueId?: string;
  registry?: StepSessionRegistry;
  onStdout?: (chunk: string, agent: RoomAgentInfo) => void;
  onStderr?: (chunk: string, agent: RoomAgentInfo) => void;
  onEvent?: (event: SessionEvent, agent: RoomAgentInfo) => void;
  /** Хук логирования старта работника (индекс/подзадача/дескриптор агента). */
  onWorkerStart?: (
    item: RoomWorkItem,
    total: number,
    agent: RoomAgentInfo,
  ) => void;
}

/** Дескриптор воркера: `index` в RoomAgent — 1-based, id — per-agent stepRunId. */
const workerAgent = (baseStepRunId: string, index: number): RoomAgentInfo => ({
  id: `${baseStepRunId}/worker/${index}`,
  role: 'worker',
  index: index + 1,
  label: `Воркер ${index + 1}`,
});

const coordinatorAgent = (stepRunId: string): RoomAgentInfo => ({
  id: stepRunId,
  role: 'coordinator',
  index: null,
  label: 'Координатор',
});

/**
 * Прогон resolve в режиме комнаты: N работников параллельно решают свои
 * подзадачи, затем ОДИН координатор (старший) интегрирует их и принимает
 * финальное решение шага. Движок вызывает это только при детерминированном
 * planExecutionMode === 'room'; координатор пишет `.issue-step-result.json`,
 * а работники — `.issue-worker-result-<i>.json`.
 */
export async function runRoomResolve(
  pi: PiRunner,
  input: RoomResolveInput,
  options: RoomResolveOptions,
): Promise<StepExecutionResult> {
  const count = clampExecutors(
    input.execution,
    input.maxExecutors ?? DEFAULT_MAX_ROOM_EXECUTORS,
  );
  const workItems = planRoomWorkItems(input.execution, count);

  const workers = await Promise.all(
    workItems.map((item) => {
      const stepRunId = `${options.stepRunId}/worker/${item.index}`;
      const agent = workerAgent(options.stepRunId, item.index);
      options.onWorkerStart?.(item, count, agent);
      return pi.run(
        input.containerName,
        buildRoomWorkerPrompt(input, item, count),
        {
          model: options.model,
          thinkingLevel: options.thinkingLevel,
          cwd: options.cwd,
          stepRunId,
          iterationId: options.iterationId,
          issueId: options.issueId,
          registry: options.registry,
          agent,
          onStdout: (chunk) => options.onStdout?.(chunk, agent),
          onStderr: (chunk) => options.onStderr?.(chunk, agent),
          onEvent: (event) => options.onEvent?.(event, agent),
        },
      );
    }),
  );

  // Пользователь прервал итерацию (abort идёт broadcast во все сессии):
  // координатора НЕ запускаем — иначе он допишет отчёт и итерация
  // завершится `completed` вместо `cancelled`.
  if (workers.some((worker) => worker.aborted === true)) {
    return {
      step: 'resolve',
      exitCode: 1,
      report: { status: 'fail', summary: 'aborted' },
      stdout: '',
      stderr: '',
      events: [],
      stats: null,
      aborted: true,
    };
  }

  const summaries: WorkerSummary[] = workers.map((worker, index) => ({
    index,
    summary:
      worker.report?.summary ?? `(see .issue-worker-result-${index}.json)`,
  }));

  return pi.run(
    input.containerName,
    buildRoomCoordinatorPrompt(input, summaries),
    {
      model: options.model,
      thinkingLevel: options.thinkingLevel,
      cwd: options.cwd,
      stepRunId: options.stepRunId,
      iterationId: options.iterationId,
      issueId: options.issueId,
      registry: options.registry,
      agent: coordinatorAgent(options.stepRunId),
      onStdout: (chunk) =>
        options.onStdout?.(chunk, coordinatorAgent(options.stepRunId)),
      onStderr: (chunk) =>
        options.onStderr?.(chunk, coordinatorAgent(options.stepRunId)),
      onEvent: (event) =>
        options.onEvent?.(event, coordinatorAgent(options.stepRunId)),
    },
  );
}