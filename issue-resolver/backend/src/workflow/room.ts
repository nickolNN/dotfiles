import type {
  ExecutionPlan,
  NormalizedStage,
  RoomWorkItem,
  SessionEvent,
  SessionStats,
  StepExecutionResult,
} from '@issue-resolver/shared';
import {
  clampExecutors,
  DEFAULT_MAX_ROOM_EXECUTORS,
  parseStepReport,
  planExecutionStages,
  planRoomWorkItems,
  sumSessionStats,
} from '@issue-resolver/shared';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PiRunner } from '../pi/runner';
import type { RoomAgentInfo, StepSessionRegistry } from '../pi/session-registry';
import {
  buildRoomCoordinatorPrompt,
  buildRoomWorkerPrompt,
  buildStageCoordinatorPrompt,
  buildStageSoloPrompt,
  buildStageWorkerPrompt,
  buildStagedFinalCoordinatorPrompt,
  type RoomPromptInput,
  type WorkerSummary,
} from './prompts';
import { readStageOutcomes } from './stage-outcomes';
import { resolveAgentTimeoutMs, withAgentTimeout } from './timeout';

/** Вход комнаты resolve: общий prompt-контекст + план и адрес контейнера. */
export interface RoomResolveInput extends RoomPromptInput {
  containerName: string;
  execution: ExecutionPlan;
  /** Потолок числа исполнителей; по умолчанию DEFAULT_MAX_ROOM_EXECUTORS. */
  maxExecutors?: number;
}

/** Опции прогона комнаты: модель/cwd, адрес шага и живые колбэки. */
export interface RoomResolveOptions {
  /**
   * Host-путь рабочей папки задачи. Отсюда движок дочитывает отчёты агентов
   * (`.issue-worker-result-<n>.json`, `.issue-stage-<i>*.json`) в саммари для
   * координатора: в docker-режиме `cwd` — путь внутри контейнера и бэкенду
   * недоступен.
   */
  hostWorkspaceDir?: string;
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
  /**
   * Таймаут одного pi-агента (мс). По умолчанию — env/30 мин (см.
   * `resolveAgentTimeoutMs`). Явное значение используется как есть и служит
   * override'ом для коротких прогонов/тестов.
   */
  timeoutMs?: number;
}

/**
 * Дескриптор исполнителя: `index` в RoomAgent — 1-based, id — per-agent stepRunId.
 * Со `stage` (staged-режим) id/подпись включают номер этапа, а исполнитель
 * нумеруется 1-based внутри этапа. Единственный исполнитель одиночного этапа
 * (`executors: 1`) — это `index = 0`, т.е. «Этап N · Исполнитель 1».
 */
const workerAgent = (
  baseStepRunId: string,
  index: number,
  stage?: NormalizedStage,
): RoomAgentInfo =>
  stage
    ? {
        id: `${baseStepRunId}/stage/${stage.index}/worker/${index + 1}`,
        role: 'worker',
        index: index + 1,
        label: `Этап ${stage.index} · Исполнитель ${index + 1}`,
        stage: stage.index,
        stageName: stage.name,
      }
    : {
        id: `${baseStepRunId}/worker/${index}`,
        role: 'worker',
        index: index + 1,
        label: `Исполнитель ${index + 1}`,
      };

/**
 * Дескриптор координатора: без `stage` — финальный lead шага (id = stepRunId);
 * со `stage` — координатор этапа staged-режима (`<stepRunId>/stage/<i>/coordinator`),
 * у которого есть исполнители (у одиночного этапа координатора нет — там исполнитель).
 */
const coordinatorAgent = (
  stepRunId: string,
  stage?: NormalizedStage,
): RoomAgentInfo =>
  stage
    ? {
        id: `${stepRunId}/stage/${stage.index}/coordinator`,
        role: 'coordinator',
        index: null,
        label: `Этап ${stage.index} · Координатор`,
        stage: stage.index,
        stageName: stage.name,
      }
    : {
        id: stepRunId,
        role: 'coordinator',
        index: null,
        label: 'Координатор',
      };

/** Терминальный abort-результат resolve (общий для room и staged). */
const abortedResolveResult = (): StepExecutionResult => ({
  step: 'resolve',
  exitCode: 1,
  report: { status: 'fail', summary: 'aborted' },
  stdout: '',
  stderr: '',
  events: [],
  stats: null,
  aborted: true,
});

/** Описывает один запуск pi-агента комнаты (исполнитель или координатор). */
interface AgentRun {
  stepRunId: string;
  agent: RoomAgentInfo;
  prompt: string;
}

/**
 * Запускает pi-агента с прокидкой per-agent стрима/событий в общие колбэки.
 * Если агент не завершился за `timeoutMs`, promise reject'ится (даже когда
 * раннер игнорирует `options.timeoutMs`) — resolve-шаг не висит вечно.
 */
function runAgent(
  pi: PiRunner,
  input: RoomResolveInput,
  options: RoomResolveOptions,
  run: AgentRun,
): Promise<StepExecutionResult> {
  const timeoutMs = options.timeoutMs ?? resolveAgentTimeoutMs();
  const agentPromise = pi.run(input.containerName, run.prompt, {
    model: options.model,
    thinkingLevel: options.thinkingLevel,
    cwd: options.cwd,
    stepRunId: run.stepRunId,
    iterationId: options.iterationId,
    issueId: options.issueId,
    registry: options.registry,
    agent: run.agent,
    timeoutMs,
    onStdout: (chunk) => options.onStdout?.(chunk, run.agent),
    onStderr: (chunk) => options.onStderr?.(chunk, run.agent),
    onEvent: (event) => options.onEvent?.(event, run.agent),
  });
  return withAgentTimeout(
    agentPromise,
    timeoutMs,
    `resolve agent ${run.agent.id}`,
  );
}

/** Дескриптор одного исполнителя: дескриптор агента, его id, подзадача и промпт. */
interface WorkerJob extends AgentRun {
  item: RoomWorkItem;
}

/**
 * Саммари агента комнаты для промпта координатора: сначала in-memory отчёт
 * раннера, затем файл отчёта в рабочей папке. В реальном прогоне раннер
 * заполняет `report` только при abort, поэтому файл — основной источник;
 * без него координатор получал список «(see …)» вместо содержимого.
 */
function agentSummary(
  result: StepExecutionResult,
  hostWorkspaceDir: string | undefined,
  fileName: string,
): string | null {
  const inline = result.report?.summary?.trim();
  if (inline) return inline;
  if (!hostWorkspaceDir) return null;
  try {
    const report = parseStepReport(
      readFileSync(join(hostWorkspaceDir, fileName), 'utf-8'),
    );
    const summary = report?.summary?.trim();
    return summary ? summary : null;
  } catch {
    return null;
  }
}

/** Запускает N исполнителей параллельно, переиспользуется комнатой и этапами. */
async function runWorkersParallel(
  pi: PiRunner,
  input: RoomResolveInput,
  options: RoomResolveOptions,
  jobs: WorkerJob[],
  total: number,
): Promise<StepExecutionResult[]> {
  return Promise.all(
    jobs.map((job) => {
      options.onWorkerStart?.(job.item, total, job.agent);
      return runAgent(pi, input, options, job);
    }),
  );
}

/**
 * Прогон resolve в режиме комнаты: N работников параллельно решают свои
 * подзадачи, затем ОДИН координатор (старший) интегрирует их и принимает
 * финальное решение шага. Движок вызывает это только при детерминированном
 * planExecutionMode === 'room'; координатор пишет `.issue-step-result.json`,
 * а работники — `.issue-worker-result-<n>.json` (n — 1-based номер подзадачи).
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

  const jobs: WorkerJob[] = workItems.map((item) => {
    const agent = workerAgent(options.stepRunId, item.index);
    return {
      stepRunId: agent.id,
      agent,
      item,
      prompt: buildRoomWorkerPrompt(input, item, count),
    };
  });

  const workers = await runWorkersParallel(pi, input, options, jobs, count);

  // Пользователь прервал итерацию (abort идёт broadcast во все сессии):
  // координатора НЕ запускаем — иначе он допишет отчёт и итерация
  // завершится `completed` вместо `cancelled`.
  if (workers.some((worker) => worker.aborted === true)) {
    return abortedResolveResult();
  }

  const summaries: WorkerSummary[] = workers.map((worker, index) => {
    const fileName = `.issue-worker-result-${index + 1}.json`;
    return {
      index: index + 1,
      summary:
        agentSummary(worker, options.hostWorkspaceDir, fileName) ??
        `(see ${fileName})`,
    };
  });

  const agent = coordinatorAgent(options.stepRunId);
  const result = await runAgent(pi, input, options, {
    stepRunId: agent.id,
    agent,
    prompt: buildRoomCoordinatorPrompt(input, summaries),
  });
  // `run.stats` шага — тотал всех агентов (исполнители + координатор), а не
  // телеметрия только последнего координатора.
  const total = sumSessionStats([
    ...workers.map((worker) => worker.stats),
    result.stats,
  ]);
  return { ...result, stats: total };
}

/**
 * Прогон resolve в режиме последовательных этапов (`mode: 'stages'`). Этапы
 * исполняются СТРОГО по порядку: исполнители этапа (параллельно, если executors
 * >= 2) → координатор этапа, пишущий `.issue-stage-<i>.json`; для executors = 1
 * этап целиком выполняет один исполнитель (`/stage/<i>/worker/1`), пишущий тот же
 * файл этапа. После всех этапов финальный lead интегрирует их
 * исходы и пишет итоговый `.issue-step-result.json`. Abort на любом этапе
 * немедленно завершает шаг без следующих этапов и финального координатора.
 */
export async function runStagedResolve(
  pi: PiRunner,
  input: RoomResolveInput,
  options: RoomResolveOptions,
): Promise<StepExecutionResult> {
  const stages = planExecutionStages(
    input.execution,
    input.maxExecutors ?? DEFAULT_MAX_ROOM_EXECUTORS,
  );
  // Самовосстановление после падения этапа: этапы с уже записанным
  // `.issue-stage-<i>.json` считаются завершёнными и не перезапускаются, а их
  // исходы уходят финальному координатору. Без hostWorkspaceDir — все этапы.
  const resume = readStageOutcomes(options.hostWorkspaceDir, stages);
  const outcomes: { stage: NormalizedStage; outcome: string }[] = [
    ...resume.completed,
  ];
  // Копилка телеметрии всех агентов шага (исполнители + координаторы этапов) —
  // в конце суммируется вместе с финальным координатором.
  const allStats: SessionStats[] = [];

  for (const stage of stages) {
    // Этапы до resumeIndex уже имеют персистентный исход — не повторяем их.
    if (stage.index < resume.resumeIndex) continue;
    if (stage.executors >= 2) {
      const workItems: RoomWorkItem[] = stage.decomposition.map(
        (task, index) => ({ index, task }),
      );
      const jobs: WorkerJob[] = workItems.map((item) => {
        const agent = workerAgent(options.stepRunId, item.index, stage);
        return {
          stepRunId: agent.id,
          agent,
          item,
          prompt: buildStageWorkerPrompt(input, stage, item, stage.executors),
        };
      });

      const workers = await runWorkersParallel(
        pi,
        input,
        options,
        jobs,
        stage.executors,
      );
      workers.forEach((worker) => {
        if (worker.stats) allStats.push(worker.stats);
      });
      if (workers.some((worker) => worker.aborted === true)) {
        return abortedResolveResult();
      }

      const summaries: WorkerSummary[] = workers.map((worker, index) => {
        const fileName = `.issue-stage-${stage.index}-worker-${index + 1}.json`;
        return {
          index: index + 1,
          summary:
            agentSummary(worker, options.hostWorkspaceDir, fileName) ??
            `(see ${fileName})`,
        };
      });

      const agent = coordinatorAgent(options.stepRunId, stage);
      const result = await runAgent(pi, input, options, {
        stepRunId: agent.id,
        agent,
        prompt: buildStageCoordinatorPrompt(input, stage, summaries),
      });
      if (result.stats) allStats.push(result.stats);
      if (result.aborted === true) return abortedResolveResult();
      outcomes.push({
        stage,
        outcome:
          agentSummary(
            result,
            options.hostWorkspaceDir,
            `.issue-stage-${stage.index}.json`,
          ) ?? `(see .issue-stage-${stage.index}.json)`,
      });
      continue;
    }

    // executors === 1: весь этап делает один исполнитель (`/stage/<i>/worker/1`).
    // Промпт — соло-вариант: координатора этапа нет, интегрировать некому,
    // файл этапа пишет сам исполнитель.
    const agent = workerAgent(options.stepRunId, 0, stage);
    const result = await runAgent(pi, input, options, {
      stepRunId: agent.id,
      agent,
      prompt: buildStageSoloPrompt(input, stage),
    });
    if (result.stats) allStats.push(result.stats);
    if (result.aborted === true) return abortedResolveResult();
    outcomes.push({
      stage,
      outcome:
        agentSummary(
          result,
          options.hostWorkspaceDir,
          `.issue-stage-${stage.index}.json`,
        ) ?? `(see .issue-stage-${stage.index}.json)`,
    });
  }

  const agent = coordinatorAgent(options.stepRunId);
  const result = await runAgent(pi, input, options, {
    stepRunId: agent.id,
    agent,
    prompt: buildStagedFinalCoordinatorPrompt(input, outcomes),
  });
  // `run.stats` шага — тотал всех агентов этапов + финального координатора.
  const total = sumSessionStats([...allStats, result.stats]);
  return { ...result, stats: total };
}