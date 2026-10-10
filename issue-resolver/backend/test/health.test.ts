import { afterAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { createDb } from '../src/db/client';

const app = buildApp(createDb(':memory:'));

afterAll(async () => {
  await app.close();
});

describe('GET /ping', () => {
  it('отвечает 200 и { ok: true }', async () => {
    const response = await app.inject({ method: 'GET', url: '/ping' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true });
  });
});

describe('error handler', () => {
  it('неизвестный роут → 404 и { error: string }', async () => {
    const response = await app.inject({ method: 'GET', url: '/nope' });

    expect(response.statusCode).toBe(404);
    expect(typeof response.json().error).toBe('string');
  });

  it('необработанная ошибка → 500 и { error: string }', async () => {
    const boomApp = buildApp(createDb(':memory:'));
    boomApp.get('/boom', async () => {
      throw new Error('boom');
    });

    const response = await boomApp.inject({ method: 'GET', url: '/boom' });

    expect(response.statusCode).toBe(500);
    expect(typeof response.json().error).toBe('string');

    await boomApp.close();
  });
});