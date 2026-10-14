import { randomUUID } from 'node:crypto';
import type { SSEEvent } from '@issue-resolver/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { createDb } from '../src/db/client';
import { InMemorySseHub } from '../src/sse/hub';

const NOW = '2026-06-01T00:00:00.000Z';

const openApps: Array<{ close: () => Promise<void> }> = [];
afterEach(async () => {
  await Promise.all(openApps.splice(0).map((app) => app.close()));
});

describe('InMemorySseHub.subscribeGlobal', () => {
  it('получает все события независимо от iterationId/issueId', () => {
    const hub = new InMemorySseHub();
    const received: SSEEvent[] = [];
    hub.subscribeGlobal((event) => received.push(event));

    const withIteration: SSEEvent = {
      type: 'log',
      issueId: 'issue-A',
      iterationId: 'iter-1',
      data: 'раз',
      ts: NOW,
    };
    const issueLevel: SSEEvent = {
      type: 'workspace_progress',
      issueId: 'issue-B',
      data: 'два',
      ts: NOW,
    };
    hub.publish(withIteration);
    hub.publish(issueLevel);

    expect(received).toEqual([withIteration, issueLevel]);
  });

  it('unsubscribe отписывает глобального слушателя', () => {
    const hub = new InMemorySseHub();
    const received: SSEEvent[] = [];
    const unsubscribe = hub.subscribeGlobal((event) => received.push(event));

    const event: SSEEvent = {
      type: 'iteration_status',
      issueId: 'issue-A',
      iterationId: 'iter-1',
      data: JSON.stringify({ status: 'question' }),
      ts: NOW,
    };
    hub.publish(event);
    expect(received).toEqual([event]);

    unsubscribe();
    hub.publish(event);
    expect(received).toHaveLength(1);
  });

  it('событие доставляется ровно один раз, даже если слушатель подписан ещё и на issue', () => {
    const hub = new InMemorySseHub();
    const received: SSEEvent[] = [];
    const listener = (event: SSEEvent) => received.push(event);

    hub.subscribeGlobal(listener);
    hub.subscribeByIssue('issue-1', listener);

    const event: SSEEvent = {
      type: 'step_status',
      issueId: 'issue-1',
      iterationId: 'iter-1',
      data: 'running',
      ts: NOW,
    };
    hub.publish(event);

    expect(received).toEqual([event]);
  });
});

describe('GET /stream (глобальный SSE)', () => {
  it('200 + text/event-stream и все события без фильтра', async () => {
    const db = createDb(':memory:');
    const hub = new InMemorySseHub();
    const app = buildApp(db, { sse: hub });
    openApps.push(app);

    await app.listen({ port: 0, host: '127.0.0.1' });
    const address = app.server.address();
    if (address === null || typeof address === 'string') {
      throw new Error('server has no TCP address');
    }

    const controller = new AbortController();
    try {
      const response = await fetch(
        `http://127.0.0.1:${address.port}/issue-resolver/api/v1/stream`,
        { signal: controller.signal },
      );

      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toContain('text/event-stream');

      const event: SSEEvent = {
        type: 'iteration_status',
        issueId: randomUUID(),
        iterationId: randomUUID(),
        data: JSON.stringify({ status: 'question' }),
        ts: NOW,
      };
      hub.publish(event);

      const reader = response.body?.getReader();
      if (!reader) throw new Error('no response body');
      const { value } = await reader.read();
      expect(new TextDecoder().decode(value)).toBe(
        `data: ${JSON.stringify(event)}\n\n`,
      );

      controller.abort();
      await reader.cancel().catch(() => undefined);
    } finally {
      controller.abort();
    }
  });
});