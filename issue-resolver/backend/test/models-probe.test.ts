import { describe, expect, it, vi } from 'vitest';

import type { ModelDescriptor } from '@issue-resolver/shared';

import { createModelsProbe, modelsFromProbeResponse } from '../src/pi/models-probe';

const MODELS: ModelDescriptor[] = [
  { id: 'deepseek-v4-pro', provider: 'bailian', thinkingLevels: ['off', 'high'] },
];

describe('models probe — кэш и деградация', () => {
  it('первый вызов идёт в Pi, второй берётся из кэша', async () => {
    const run = vi.fn().mockResolvedValue(MODELS);
    const probe = createModelsProbe({ run, ttlMs: 1_000, now: () => 0 });

    expect(await probe.list()).toEqual(MODELS);
    expect(await probe.list()).toEqual(MODELS);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('после TTL спрашивает Pi снова', async () => {
    let clock = 0;
    const run = vi.fn().mockResolvedValue(MODELS);
    const probe = createModelsProbe({ run, ttlMs: 1_000, now: () => clock });

    await probe.list();
    clock = 1_001;
    await probe.list();
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('параллельные вызовы не запускают второй пробник', async () => {
    let release: (value: ModelDescriptor[]) => void = () => {};
    const run = vi.fn(
      () => new Promise<ModelDescriptor[]>((resolve) => (release = resolve)),
    );
    const probe = createModelsProbe({ run, ttlMs: 1_000, now: () => 0 });

    const [a, b] = [probe.list(), probe.list()];
    release(MODELS);
    expect(await a).toEqual(MODELS);
    expect(await b).toEqual(MODELS);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('сбой Pi → пустой список (роут уйдёт в models.json), без кэша', async () => {
    const run = vi
      .fn()
      .mockRejectedValueOnce(new Error('pi not found'))
      .mockResolvedValueOnce(MODELS);
    const probe = createModelsProbe({ run, ttlMs: 1_000, now: () => 0 });

    expect(await probe.list()).toEqual([]);
    expect(await probe.list()).toEqual(MODELS);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('пустой ответ не кэшируется как «моделей нет»', async () => {
    const run = vi.fn().mockResolvedValueOnce([]).mockResolvedValueOnce(MODELS);
    const probe = createModelsProbe({ run, ttlMs: 1_000, now: () => 0 });

    expect(await probe.list()).toEqual([]);
    expect(await probe.list()).toEqual(MODELS);
  });
});

describe('models probe — разбор ответа Pi', () => {
  it('отдаёт только публичные поля и считает уровни по правилу Pi', () => {
    const models = modelsFromProbeResponse({
      command: 'get_available_models',
      success: true,
      data: {
        models: [
          {
            id: 'm-1',
            name: 'Model One',
            provider: 'prov',
            contextWindow: 1_000_000,
            reasoning: true,
            thinkingLevelMap: { minimal: null, high: 'high', xhigh: 'xhigh' },
            baseUrl: 'https://secret',
            apiKey: 'sk-secret',
          },
          { id: 'm-2' },
          { name: 'no id' },
        ],
      },
    });

    expect(models).toHaveLength(2);
    expect(models[0]).toMatchObject({
      id: 'm-1',
      name: 'Model One',
      provider: 'prov',
      contextWindow: 1_000_000,
      thinkingLevels: ['off', 'low', 'medium', 'high', 'xhigh'],
    });
    expect(JSON.stringify(models)).not.toContain('sk-secret');
    expect(models[1].thinkingLevels).toEqual(['off']);
  });

  it('success:false → пустой список', () => {
    expect(
      modelsFromProbeResponse({ command: 'get_available_models', success: false }),
    ).toEqual([]);
  });
});
