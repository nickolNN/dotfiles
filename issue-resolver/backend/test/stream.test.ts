import { randomUUID } from 'node:crypto';
import type { SSEEvent, StepRunStatus } from '@issue-resolver/shared';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import type { Db } from '../src/db/client';
import { createDb } from '../src/db/client';
import { issues, iterations, stepRuns } from '../src/db/schema';
import { InMemorySseHub } from '../src/sse/hub';

const ISSUES_PATH = '/issue-resolver/api/v1/issues';
const NOW = '2026-06-01T00:00:00.000Z';

function insertIssue(db: Db): string {
  const id = randomUUID();
  db.insert(issues)
    .values({
      id,
      title: 'Стрим-задача',
      jira_issue_url: null,
      pipeline_steps: ['resolve'],
      container_name: null,
      status: 'pending',
      created_at: NOW,
      updated_at: NOW,
    })
    .run();
  return id;
}

function insertIteration(
  db: Db,
  issueId: string,
  status: 'running' | 'completed',
): string {
  const id = randomUUID();
  db.insert(iterations)
    .values({
      id,
      issue_id: issueId,
      number: 1,
      context: '',
      steps: ['resolve'],
      status,
      created_at: NOW,
      updated_at: NOW,
    })
    .run();
  return id;
}

function insertStepRun(
  db: Db,
  iterationId: string,
  status: StepRunStatus,
): string {
  const id = randomUUID();
  db.insert(stepRuns)
    .values({
      id,
      iteration_id: iterationId,
      step: 'resolve',
      attempt: 1,
      status,
      context: 'ctx',
      created_at: NOW,
      updated_at: NOW,
    })
    .run();
  return id;
}

const openApps: Array<{ close: () => Promise<void> }> = [];
afterEach(async () => {
  await Promise.all(openApps.splice(0).map((app) => app.close()));
});

describe('InMemorySseHub.subscribeByIssue', () => {
  it('доставляет по issueId, не доставляет чужим issue, unsubscribe останавливает', () => {
    const hub = new InMemorySseHub();
    const forX: SSEEvent[] = [];
    const forOther: SSEEvent[] = [];

    const unsubscribeX = hub.subscribeByIssue('issue-X', (event) =>
      forX.push(event),
    );
    hub.subscribeByIssue('issue-other', (event) => forOther.push(event));

    const event: SSEEvent = {
      type: 'log',
      issueId: 'issue-X',
      iterationId: 'iter-Y',
      data: 'привет',
      ts: NOW,
    };
    hub.publish(event);

    expect(forX).toEqual([event]);
    expect(forOther).toEqual([]);

    unsubscribeX();
    hub.publish(event);
    expect(forX).toHaveLength(1);
  });

  it('точная доставка: iterationId-подписка и issueId-подписка без дублей', () => {
    const hub = new InMemorySseHub();
    const received: SSEEvent[] = [];
    const listener = (event: SSEEvent) => received.push(event);

    hub.subscribe('iter-1', listener);
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

describe('GET /issues/:id/stream', () => {
  it('несуществующая задача → 404 { error }', async () => {
    const app = buildApp(createDb(':memory:'));
    openApps.push(app);

    const response = await app.inject({
      method: 'GET',
      url: `${ISSUES_PATH}/${randomUUID()}/stream`,
    });

    expect(response.statusCode).toBe(404);
    expect(typeof response.json().error).toBe('string');
  });

  it('200 + text/event-stream и живое событие через реальный HTTP', async () => {
    const db = createDb(':memory:');
    const issueId = insertIssue(db);
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
        `http://127.0.0.1:${address.port}${ISSUES_PATH}/${issueId}/stream`,
        { signal: controller.signal },
      );

      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toContain('text/event-stream');

      const event: SSEEvent = {
        type: 'log',
        issueId,
        iterationId: 'iter-1',
        data: 'живое событие',
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

describe('POST /iterations/:id/abort', () => {
  it('нет активной сессии, итерация running → 200 и всё переходит в cancelled/aborted', async () => {
    const db = createDb(':memory:');
    const issueId = insertIssue(db);
    const iterationId = insertIteration(db, issueId, 'running');
    const stepRunId = insertStepRun(db, iterationId, 'running');
    const hub = new InMemorySseHub();
    const events: SSEEvent[] = [];
    hub.subscribe(iterationId, (event) => events.push(event));
    const app = buildApp(db, { sse: hub });
    openApps.push(app);

    const response = await app.inject({
      method: 'POST',
      url: `/issue-resolver/api/v1/iterations/${iterationId}/abort`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true });

    expect(
      db.select().from(iterations).where(eq(iterations.id, iterationId)).get()
        ?.status,
    ).toBe('cancelled');
    expect(
      db.select().from(issues).where(eq(issues.id, issueId)).get()?.status,
    ).toBe('cancelled');
    expect(
      db.select().from(stepRuns).where(eq(stepRuns.id, stepRunId)).get()
        ?.status,
    ).toBe('aborted');

    const statusEvent = events.find((e) => e.type === 'iteration_status');
    expect(statusEvent).toBeDefined();
    expect(JSON.parse(statusEvent?.data ?? '')).toEqual({
      iterationId,
      status: 'cancelled',
      needsInput: false,
    });
  });

  it('итерация уже completed → no-op, статусы не меняются', async () => {
    const db = createDb(':memory:');
    const issueId = insertIssue(db);
    const iterationId = insertIteration(db, issueId, 'completed');
    const stepRunId = insertStepRun(db, iterationId, 'success');
    const hub = new InMemorySseHub();
    const events: SSEEvent[] = [];
    hub.subscribe(iterationId, (event) => events.push(event));
    const app = buildApp(db, { sse: hub });
    openApps.push(app);

    const response = await app.inject({
      method: 'POST',
      url: `/issue-resolver/api/v1/iterations/${iterationId}/abort`,
    });

    expect(response.statusCode).toBe(200);
    expect(
      db.select().from(iterations).where(eq(iterations.id, iterationId)).get()
        ?.status,
    ).toBe('completed');
    expect(
      db.select().from(stepRuns).where(eq(stepRuns.id, stepRunId)).get()
        ?.status,
    ).toBe('success');
    expect(events).toEqual([]);
  });
});