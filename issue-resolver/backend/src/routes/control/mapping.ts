import { SteeringMode } from '@issue-resolver/shared';
import type {
  ControlResult,
  SessionCommandInfo,
  SessionControlSnapshot,
  SessionControlState,
  SessionModelInfo,
} from '@issue-resolver/shared';
import {
  BUILTIN_SLASH_COMMANDS,
} from '../../pi/slash-commands';
import {
  iterationTarget,
  type StepSessionRegistry,
} from '../../pi/session-registry';
import { SessionCommandSource } from '@issue-resolver/shared';
import { asRecord } from '../../util/records';
import { boolOrNull, stringOrNull } from '../../util/scalars';

const STEERING_MODES: ReadonlySet<string> = new Set([
  SteeringMode.all,
  SteeringMode['one-at-a-time'],
]);
const COMMAND_SOURCES: ReadonlySet<string> = new Set(
  Object.values(SessionCommandSource),
);

function isCommandSource(
  value: unknown,
): value is SessionCommandInfo['source'] {
  return typeof value === 'string' && COMMAND_SOURCES.has(value);
}

export const steeringModeOf = (value: unknown): SteeringMode | null =>
  isSteeringMode(value) ? value : null;

function isSteeringMode(value: unknown): value is SteeringMode {
  return typeof value === 'string' && STEERING_MODES.has(value);
}

function modelLabel(model: Record<string, unknown> | null): string | null {
  const name = stringOrNull(model?.name);
  if (name !== null && name.length > 0) return name;
  const id = stringOrNull(model?.id);
  return id !== null && id.length > 0 ? id : null;
}

export function buildSnapshot(
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

  const commands: SessionCommandInfo[] = BUILTIN_SLASH_COMMANDS.map(
    (command) => ({
      name: command.name,
      description: command.description,
      ...(command.argumentHint ? { argumentHint: command.argumentHint } : {}),
      source: SessionCommandSource.builtin,
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
      source: isCommandSource(record.source)
        ? record.source
        : SessionCommandSource.extension,
    });
  }

  return { state, models, thinkingLevels, commands };
}

export function mapCommand(
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

export async function resolveModelByQuery(
  control: StepSessionRegistry,
  iterationId: string,
  query: string,
): Promise<{ provider: string; id: string } | null> {
  const result = await control.send(iterationTarget(iterationId), {
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