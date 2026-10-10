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
import type { StepSessionRegistry } from '../pi/session-registry';
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
  cwd?: string;
  /** stepRunId ШАГА resolve; работники получают `${stepRunId}/worker/<i>`. */
  stepRunId: string;
  iterationId: string;
  registry?: StepSessionRegistry;
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
  onEvent?: (event: SessionEvent) => void;
  /** Хук логирования старта работника (индекс/подзадача). */
  onWorkerStart?: (item: RoomWorkItem, total: number) => void;
}

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
      options.onWorkerStart?.(item, count);
      return pi.run(
        input.containerName,
        buildRoomWorkerPrompt(input, item, count),
        {
          model: options.model,
          cwd: options.cwd,
          stepRunId: `${options.stepRunId}/worker/${item.index}`,
          iterationId: options.iterationId,
          registry: options.registry,
          onStdout: options.onStdout,
          onStderr: options.onStderr,
          onEvent: options.onEvent,
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
      cwd: options.cwd,
      stepRunId: options.stepRunId,
      iterationId: options.iterationId,
      registry: options.registry,
      onStdout: options.onStdout,
      onStderr: options.onStderr,
      onEvent: options.onEvent,
    },
  );
}