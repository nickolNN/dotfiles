import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { modelSourceFromEnv } from '../src/models/source';

describe('modelSourceFromEnv', () => {
  it('расплющивает pi-конфиг моделей из PI_MODELS_PATH (providers → models)', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'ir-models-'));
    const file = path.join(dir, 'models.json');
    writeFileSync(
      file,
      JSON.stringify({
        providers: {
          p1: { models: [{ id: 'm1', name: 'M1', contextWindow: 100 }] },
          p2: { models: [{ id: 'm2', name: 'M2' }] },
        },
      }),
    );

    const list = await modelSourceFromEnv({ PI_MODELS_PATH: file }).list();
    expect(list.map((m) => m.id).sort()).toEqual(['m1', 'm2']);
    expect(list.find((m) => m.id === 'm1')).toMatchObject({
      provider: 'p1',
      name: 'M1',
      contextWindow: 100,
    });
  });

  it('плоский MODELS_JSON имеет приоритет над файлом', async () => {
    const source = modelSourceFromEnv({
      MODELS_JSON: JSON.stringify([{ id: 'a', name: 'A' }]),
    });
    expect((await source.list()).map((m) => m.id)).toEqual(['a']);
  });

  it('не выдумывает user-default: без источника — пустой список', async () => {
    const source = modelSourceFromEnv({
      PI_MODELS_PATH: '/nonexistent/models.json',
    });
    expect(await source.list()).toEqual([]);
  });
});