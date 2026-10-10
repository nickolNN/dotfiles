import type { FastifyInstance } from 'fastify';
import type {
  ControlResult,
  SessionCommandInfo,
  SessionControlSnapshot,
  SessionControlState,
  SessionModelInfo,
  SteeringMode,
} from '@issue-resolver/shared';
import {
  BUILTIN_SLASH_COMMANDS,
  handleBuiltinSlash,
  parseSlash,
} from '../pi/slash-commands';
import type { StepSessionRegistry } from '../pi/session-registry';

const CONTROL_PATH = '/issue-resolver/api/v1/iterations';

const STEERING_MODES: ReadonlySet<string> = new Set(['all', 'one-at-a-time']);
const COMMAND_SOURCES: ReadonlySet<string> = new Set([
  'extension',
  'prompt',
  'skill',
]);

/** Объект-запись из unknown; массивы/примитивы → null. */
const asRecord = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

/** Строка из необязательного поля; не-строка → null. */
const stringOrNull = (value: unknown): string | null =>
  typeof value === 'string' ? value : null;

/** Boolean из необязательного поля; иное → null. */
const boolOrNull = (value: unknown): boolean | null =>
  typeof value === 'boolean' ? value : null;

/** Режим очереди из ответа pi; неизвестный → null. */
const steeringModeOf = (value: unknown): SteeringMode | null =>
  typeof value === 'string' && STEERING_MODES.has(value)
    ? (value as SteeringMode)
    : null;

/**
 * Отображаемая модель из `get_state.data.model`: непустой `name`, иначе `id`.
 */
function modelLabel(model: Record<string, unknown> | null): string | null {
  const name = stringOrNull(model?.name);
  if (name !== null && name.length > 0) return name;
  const id = stringOrNull(model?.id);
  return id !== null && id.length > 0 ? id : null;
}

/** Собирает `SessionControlSnapshot` из четырёх ответов pi (каждый может быть null). */
function buildSnapshot(
  stateResult: ControlResult | null,
  modelsResult: ControlResult | null,
  levelsResult: ControlResult | null,
  commandsResult: ControlResult | null,
): SessionControlSnapshot {
  const stateData = asRecord(stateResult?.data);
  const model = asRecord(stateData?.model);

  const state: SessionControlState = {
    model: modelLabel(model),
    provider: stringOrNull(model?.provider),
    modelId: stringOrNull(model?.id),
    thinkingLevel: stringOrNull(stateData?.thinkingLevel),
    steeringMode: steeringModeOf(stateData?.steeringMode),
    followUpMode: steeringModeOf(stateData?.followUpMode),
    autoCompactionEnabled: boolOrNull(stateData?.autoCompactionEnabled),
    // pi не отдаёт флаг auto-retry в get_state — управляется вслепую.
    autoRetryEnabled: null,
    isStreaming: stateData?.isStreaming === true,
    sessionName: stringOrNull(stateData?.sessionName),
  };

  const rawModels = asRecord(modelsResult?.data)?.models;
  const models: SessionModelInfo[] = (Array.isArray(rawModels) ? rawModels : [])
    .map(asRecord)
    .filter((entry): entry is Record<string, unknown> => entry !== null)
    .map((entry) => ({
      provider: stringOrNull(entry.provider) ?? '',
      id: stringOrNull(entry.id) ?? '',
      ...(typeof entry.name === 'string' ? { name: entry.name } : {}),
    }))
    .filter((entry) => entry.id.length > 0);

  const rawLevels = asRecord(levelsResult?.data)?.levels;
  const thinkingLevels = (Array.isArray(rawLevels) ? rawLevels : []).filter(
    (level): level is string => typeof level === 'string',
  );

  // Встроенные команды pi идут первыми (source:'builtin') — они перехватываются
  // сервером на prompt; `get_commands` их не отдаёт. Имена builtin'ов
  // приоритетнее: коллизию из get_commands пропускаем (дедуп).
  const commands: SessionCommandInfo[] = BUILTIN_SLASH_COMMANDS.map(
    (command) => ({
      name: command.name,
      description: command.description,
      ...(command.argumentHint ? { argumentHint: command.argumentHint } : {}),
      source: 'builtin' as const,
    }),
  );
  const seen = new Set(commands.map((command) => command.name));

  const rawCommands = asRecord(commandsResult?.data)?.commands;
  for (const entry of Array.isArray(rawCommands) ? rawCommands : []) {
    const record = asRecord(entry);
    if (!record) continue;
    const name = stringOrNull(record.name) ?? '';
    if (name.length === 0 || seen.has(name)) continue;
    seen.add(name);
    commands.push({
      name,
      ...(typeof record.description === 'string'
        ? { description: record.description }
        : {}),
      ...(typeof record.argumentHint === 'string' &&
      record.argumentHint.length > 0
        ? { argumentHint: record.argumentHint }
        : {}),
      source: COMMAND_SOURCES.has(record.source as string)
        ? (record.source as SessionCommandInfo['source'])
        : 'extension',
    });
  }

  return { state, models, thinkingLevels, commands };
}

/**
 * `SessionCommand` → RPC-команда pi. Неизвестный тип или невалидные поля →
 * null (роут отвечает 400).
 */
function mapCommand(
  raw: Record<string, unknown>,
): Record<string, unknown> | null {
  switch (raw.type) {
    case 'set_model':
      if (typeof raw.provider !== 'string' || typeof raw.modelId !== 'string') {
        return null;
      }
      return { type: 'set_model', provider: raw.provider, modelId: raw.modelId };
    case 'cycle_model':
      return { type: 'cycle_model' };
    case 'set_thinking_level':
      if (typeof raw.level !== 'string') return null;
      return { type: 'set_thinking_level', level: raw.level };
    case 'cycle_thinking_level':
      return { type: 'cycle_thinking_level' };
    case 'compact':
      return {
        type: 'compact',
        ...(typeof raw.instructions === 'string'
          ? { customInstructions: raw.instructions }
          : {}),
      };
    case 'clear_queue':
      return { type: 'clear_queue' };
    case 'set_auto_compaction':
      if (typeof raw.enabled !== 'boolean') return null;
      return { type: 'set_auto_compaction', enabled: raw.enabled };
    case 'set_auto_retry':
      if (typeof raw.enabled !== 'boolean') return null;
      return { type: 'set_auto_retry', enabled: raw.enabled };
    case 'abort_retry':
      return { type: 'abort_retry' };
    case 'set_steering_mode':
      if (steeringModeOf(raw.mode) === null) return null;
      return { type: 'set_steering_mode', mode: raw.mode };
    case 'set_follow_up_mode':
      if (steeringModeOf(raw.mode) === null) return null;
      return { type: 'set_follow_up_mode', mode: raw.mode };
    case 'bash':
      if (typeof raw.command !== 'string' || raw.command.trim().length === 0) {
        return null;
      }
      return { type: 'bash', command: raw.command };
    case 'abort_bash':
      return { type: 'abort_bash' };
    default:
      return null;
  }
}

/**
 * Резолв модели по подстроке (id/name/provider) через `get_available_models`
 * живой сессии — для встроенной `/model <query>`.
 */
async function resolveModelByQuery(
  control: StepSessionRegistry,
  iterationId: string,
  query: string,
): Promise<{ provider: string; id: string } | null> {
  const result = await control.sendByIteration(iterationId, {
    type: 'get_available_models',
  });
  const models = asRecord(result?.data)?.models;
  if (!Array.isArray(models)) return null;

  const needle = query.toLowerCase();
  for (const raw of models) {
    const entry = asRecord(raw);
    const id = stringOrNull(entry?.id);
    const provider = stringOrNull(entry?.provider);
    if (!id || !provider) continue;
    const name = stringOrNull(entry?.name) ?? '';
    if (
      id.toLowerCase().includes(needle) ||
      name.toLowerCase().includes(needle) ||
      provider.toLowerCase().includes(needle)
    ) {
      return { provider, id };
    }
  }
  return null;
}

/**
 * Управление живой pi-сессией итерации: отправка промпта, снимок состояния
 * (модели/уровни/команды) и произвольные RPC-команды. Back-compat steer
 * остаётся в `POST /iterations/:id/message`.
 */
export async function controlRoutes(
  app: FastifyInstance,
  control: StepSessionRegistry,
): Promise<void> {
  // Промпт в живую сессию: `steer`/`followUp` задаёт streamingBehavior.
  app.post<{
    Params: { id: string };
    Body: { message?: unknown; mode?: unknown };
  }>(`${CONTROL_PATH}/:id/prompt`, async (request, reply) => {
    const message = request.body?.message;
    if (typeof message !== 'string' || message.trim().length === 0) {
      return reply.status(400).send({ error: 'message is required' });
    }

    const modeRaw = request.body?.mode;
    if (modeRaw !== undefined && modeRaw !== 'steer' && modeRaw !== 'followUp') {
      return reply.status(400).send({ error: 'invalid mode' });
    }
    const mode = modeRaw === 'steer' || modeRaw === 'followUp' ? modeRaw : undefined;
    const { id } = request.params;

    if (!control.hasByIteration(id)) {
      return reply.status(409).send({ error: 'no active step session' });
    }

    // Встроенные интерактивные команды pi (`/model`, `/compact`, ...) RPC-prompt
    // не исполняет — перехватываем и шлём явную команду, иначе уйдут модели
    // как обычный текст. Всё остальное (extension/prompt/skill) pi раскрывает сам.
    const slash = parseSlash(message);
    if (slash) {
      const outcome = await handleBuiltinSlash(slash.name, slash.args, {
        resolveModel: (query) => resolveModelByQuery(control, id, query),
      });
      if (outcome.kind === 'handled') {
        if (outcome.command === null) {
          return {
            ok: outcome.ok,
            disposition: 'handled',
            ...(outcome.error ? { error: outcome.error } : {}),
          };
        }
        const sent = await control.sendByIteration(id, outcome.command);
        if (sent === null) {
          return reply.status(409).send({ error: 'no active step session' });
        }
        if (!sent.ok) {
          return {
            ok: false,
            disposition: 'handled',
            ...(sent.error ? { error: sent.error } : {}),
          };
        }
        return { ok: true, disposition: 'handled' };
      }
    }

    const result = control.promptByIteration(id, message, mode);
    if (result === null) {
      return reply.status(409).send({ error: 'no active step session' });
    }
    return await result;
  });

  // Снимок управления: состояние + доступные модели/уровни/команды.
  app.get<{ Params: { id: string } }>(
    `${CONTROL_PATH}/:id/control`,
    async (request, reply) => {
      const { id } = request.params;
      const statePromise = control.sendByIteration(id, { type: 'get_state' });
      if (statePromise === null) {
        return reply.status(409).send({ error: 'no active step session' });
      }

      const [stateResult, modelsResult, levelsResult, commandsResult] =
        await Promise.all([
          statePromise,
          control.sendByIteration(id, { type: 'get_available_models' }),
          control.sendByIteration(id, { type: 'get_available_thinking_levels' }),
          control.sendByIteration(id, { type: 'get_commands' }),
        ]);

      return buildSnapshot(
        stateResult,
        modelsResult,
        levelsResult,
        commandsResult,
      );
    },
  );

  // Произвольная команда: смена модели, компакция, режимы, bash и т.п.
  app.post<{ Params: { id: string }; Body: { command?: unknown } }>(
    `${CONTROL_PATH}/:id/control`,
    async (request, reply) => {
      const rawCommand = asRecord(request.body?.command);
      if (!rawCommand) {
        return reply.status(400).send({ error: 'command is required' });
      }

      const piCommand = mapCommand(rawCommand);
      if (!piCommand) {
        return reply.status(400).send({ error: 'unknown command type' });
      }

      const result = await control.sendByIteration(
        request.params.id,
        piCommand,
      );
      if (result === null) {
        return reply.status(409).send({ error: 'no active step session' });
      }
      if (!result.ok && result.error === 'timeout') {
        return reply.status(504).send(result);
      }
      return result;
    },
  );
}