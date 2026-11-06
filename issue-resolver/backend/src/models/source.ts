import { homedir } from 'node:os';
import path from 'node:path';

import { ThinkingLevel, isThinkingLevel } from '@issue-resolver/shared';
import type { ModelDescriptor } from '@issue-resolver/shared';

import { readJsonFile } from '../util/json-file';
import { asRecord } from '../util/records';

export interface ModelSource {
  list(): Promise<ModelDescriptor[]>;
}

const EXTENDED_THINKING_LEVELS: readonly ThinkingLevel[] =
  Object.values(ThinkingLevel);

function toThinkingLevel(value: unknown): ThinkingLevel | null {
  return isThinkingLevel(value) ? value : null;
}

function supportedThinkingLevels(
  record: Record<string, unknown>,
): ThinkingLevel[] {
  if (!record.reasoning) return [ThinkingLevel.off];
  const map = asRecord(record.thinkingLevelMap);
  return EXTENDED_THINKING_LEVELS.filter((level) => {
    const mapped = map?.[level];
    if (mapped === null) return false;
    if (level === ThinkingLevel.xhigh || level === ThinkingLevel.max) {
      return mapped !== undefined;
    }
    return true;
  });
}

export class ConfigModelSource implements ModelSource {
  constructor(private readonly models: ModelDescriptor[]) {}

  async list(): Promise<ModelDescriptor[]> {
    return this.models;
  }
}

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
    if (Array.isArray(record.thinkingLevels)) {
      model.thinkingLevels = record.thinkingLevels
        .map(toThinkingLevel)
        .filter((level): level is ThinkingLevel => level !== null);
    }
    models.push(model);
  }
  return models;
}

export function modelDescriptorFromPiModel(
  record: Record<string, unknown>,
  provider?: string,
): ModelDescriptor | null {
  if (typeof record.id !== 'string' || record.id.length === 0) return null;
  const model: ModelDescriptor = { id: record.id };
  const providerName =
    provider ?? (typeof record.provider === 'string' ? record.provider : undefined);
  if (providerName) model.provider = providerName;
  if (typeof record.name === 'string') model.name = record.name;
  if (typeof record.contextWindow === 'number') {
    model.contextWindow = record.contextWindow;
  }
  model.thinkingLevels = supportedThinkingLevels(record);
  return model;
}

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
      model.thinkingLevels = supportedThinkingLevels(record);
      out.push(model);
    }
  }
  return out;
}

function readPiModelsFile(env: NodeJS.ProcessEnv): ModelDescriptor[] {
  const candidates = env.PI_MODELS_PATH
    ? [env.PI_MODELS_PATH]
    : [
        path.join(homedir(), '.pi', 'agent', 'models.json'),
        path.join(homedir(), '.config', 'pi', 'models.json'),
      ];

  for (const file of candidates) {
    if (!file) continue;
    const parsed = readJsonFile(file, asRecord);
    if (!parsed) continue;
    try {
      const models = modelsFromPiConfig(parsed);
      if (models.length > 0) return models;
    } catch {
    }
  }
  return [];
}

export function modelSourceFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): ModelSource {
  const raw = env.MODELS_JSON;
  if (typeof raw === 'string' && raw.trim().length > 0) {
    try {
      const models = sanitizeModels(JSON.parse(raw));
      if (models.length > 0) return new ConfigModelSource(models);
    } catch {
    }
  }

  const fromFile = readPiModelsFile(env);
  if (fromFile.length > 0) return new ConfigModelSource(fromFile);
  return new ConfigModelSource([]);
}