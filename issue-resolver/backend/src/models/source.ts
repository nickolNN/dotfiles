import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

import type { ModelDescriptor } from '@issue-resolver/shared';

export interface ModelSource {
  list(): Promise<ModelDescriptor[]>;
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