import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

import type { ModelDescriptor, ThinkingLevel } from '@issue-resolver/shared';

export interface ModelSource {
  list(): Promise<ModelDescriptor[]>;
}

/** Канонический порядок уровней размышления pi. */
const EXTENDED_THINKING_LEVELS: readonly ThinkingLevel[] = [
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
];

const THINKING_LEVELS: ReadonlySet<string> = new Set(EXTENDED_THINKING_LEVELS);

/** Строка → ThinkingLevel, если это валидный уровень; иначе null. */
function toThinkingLevel(value: unknown): ThinkingLevel | null {
  return typeof value === 'string' && THINKING_LEVELS.has(value)
    ? (value as ThinkingLevel)
    : null;
}

/** Объект-карта из unknown; массивы/примитивы → undefined. */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * Авторитетная формула pi `getSupportedThinkingLevels`:
 * не-думающая модель → ['off']; иначе EXTENDED-фильтр, где level с `null`
 * отсекается, `xhigh`/`max` поддержаны только при непустом маппинге, остальные
 * (не заданные/строковые) — поддержаны. Возвращает только валидные ThinkingLevel.
 */
function supportedThinkingLevels(
  record: Record<string, unknown>,
): ThinkingLevel[] {
  if (!record.reasoning) return ['off'];
  const map = asRecord(record.thinkingLevelMap);
  return EXTENDED_THINKING_LEVELS.filter((level) => {
    const mapped = map?.[level];
    if (mapped === null) return false;
    if (level === 'xhigh' || level === 'max') return mapped !== undefined;
    return true;
  });
}

export class ConfigModelSource implements ModelSource {
  constructor(private readonly models: ModelDescriptor[]) {}

  async list(): Promise<ModelDescriptor[]> {
    return this.models;
  }
}

/**
 * Пропускает только публичные поля ModelDescriptor. Любые ключи/токены из
 * входного JSON отбрасываются и никогда не покидают этот модуль.
 */
function sanitizeModels(input: unknown): ModelDescriptor[] {
  if (!Array.isArray(input)) return [];

  const models: ModelDescriptor[] = [];
  for (const item of input) {
    if (typeof item !== 'object' || item === null) continue;
    const record = item as Record<string, unknown>;
    if (typeof record.id !== 'string' || record.id.length === 0) continue;

    const model: ModelDescriptor = { id: record.id };
    if (typeof record.provider === 'string') model.provider = record.provider;
    if (typeof record.name === 'string') model.name = record.name;
    if (typeof record.contextWindow === 'number') {
      model.contextWindow = record.contextWindow;
    }
    // Плоская форма может быть уже-дескрипторной: прокидываем только валидные
    // ThinkingLevel, не раскрывая сырые reasoning/thinkingLevelMap.
    if (Array.isArray(record.thinkingLevels)) {
      model.thinkingLevels = record.thinkingLevels
        .map(toThinkingLevel)
        .filter((level): level is ThinkingLevel => level !== null);
    }
    models.push(model);
  }
  return models;
}

/** Расплющивает pi-формат `{ providers: { <name>: { models: [...] } } }`. */
function modelsFromPiConfig(input: unknown): ModelDescriptor[] {
  if (typeof input !== 'object' || input === null) return [];
  const providers = (input as Record<string, unknown>).providers;
  if (typeof providers !== 'object' || providers === null) return [];

  const out: ModelDescriptor[] = [];
  for (const [providerName, provider] of Object.entries(
    providers as Record<string, unknown>,
  )) {
    if (typeof provider !== 'object' || provider === null) continue;
    const providerModels = (provider as Record<string, unknown>).models;
    if (!Array.isArray(providerModels)) continue;

    for (const m of providerModels) {
      if (typeof m !== 'object' || m === null) continue;
      const record = m as Record<string, unknown>;
      if (typeof record.id !== 'string' || record.id.length === 0) continue;

      const model: ModelDescriptor = { id: record.id, provider: providerName };
      if (typeof record.name === 'string') model.name = record.name;
      if (typeof record.contextWindow === 'number') {
        model.contextWindow = record.contextWindow;
      }
      // reasoning/thinkingLevelMap остаются сырыми входными полями и наружу не
      // отдаются — только производный набор поддерживаемых уровней.
      model.thinkingLevels = supportedThinkingLevels(record);
      out.push(model);
    }
  }
  return out;
}

/**
 * Читает пи-конфиг моделей (тот же файл, что читает `pi --list-models`).
 * Порядок: явный `PI_MODELS_PATH`, затем `~/.pi/agent/models.json`,
 * затем `~/.config/pi/models.json`. Не получилось — пустой список.
 */
function readPiModelsFile(env: NodeJS.ProcessEnv): ModelDescriptor[] {
  const candidates = env.PI_MODELS_PATH
    ? [env.PI_MODELS_PATH]
    : [
        path.join(homedir(), '.pi', 'agent', 'models.json'),
        path.join(homedir(), '.config', 'pi', 'models.json'),
      ];

  for (const file of candidates) {
    if (!file) continue;
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8'));
      const models = modelsFromPiConfig(parsed);
      if (models.length > 0) return models;
    } catch {
      // нечитаемо/невалидно → пробуем следующий
    }
  }
  return [];
}

/**
 * Источник моделей:
 * 1. `MODELS_JSON` (плоский массив ModelDescriptor[]) — для тестов/оверрайдов.
 * 2. Файл пи-конфига моделей (`PI_MODELS_PATH` или дефолтные пути).
 * 3. Пустой список (НЕ выдуманный `user-default`, который pi не знает и
 *    который ломал прогон: `--model user-default` → «model not found»).
 */
export function modelSourceFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): ModelSource {
  const raw = env.MODELS_JSON;
  if (typeof raw === 'string' && raw.trim().length > 0) {
    try {
      const models = sanitizeModels(JSON.parse(raw));
      if (models.length > 0) return new ConfigModelSource(models);
    } catch {
      // невалидный JSON → ниже
    }
  }

  const fromFile = readPiModelsFile(env);
  if (fromFile.length > 0) return new ConfigModelSource(fromFile);
  return new ConfigModelSource([]);
}