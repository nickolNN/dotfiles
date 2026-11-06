import { randomUUID } from 'node:crypto';
import type { FastifyReply } from 'fastify';
import { beforeEach, describe, expect, it } from 'vitest';
import { TaskStatus } from '@issue-resolver/shared';
import { createDb, type Db } from '../src/db/client';
import { issues, iterations } from '../src/db/schema';
import {
  badRequest,
  conflict,
  getIterationRow,
  notFound,
  unprocessable,
} from '../src/routes/params';

class FakeReply {
  code: number | null = null;
  body: unknown = null;

  status(code: number): this {
    this.code = code;
    return this;
  }

  send(body: unknown): this {
    this.body = body;
    return this;
  }
}

function reply(): FakeReply & FastifyReply {
  return new FakeReply() as FakeReply & FastifyReply;
}

describe('routes/params — единственное место ответов-ошибок', () => {
  it('каждый помощник отдаёт свой код и тело { error }', () => {
    const cases = [
      { send: notFound, code: 404 },
      { send: badRequest, code: 400 },
      { send: conflict, code: 409 },
      { send: unprocessable, code: 422 },
    ] as const;

    for (const item of cases) {
      const res = reply();
      item.send(res, 'нет такой итерации');
      expect(res.code).toBe(item.code);
      expect(res.body).toEqual({ error: 'нет такой итерации' });
    }
  });

  it('не добавляет к телу ничего, кроме error', () => {
    const res = reply();
    conflict(res, 'итерация уже идёт');
    expect(Object.keys(res.body as Record<string, unknown>)).toEqual(['error']);
  });
});


function seedIssueRow(db: Db): string {
  const id = randomUUID();
  const now = new Date().toISOString();
  db.insert(issues)
    .values({
      id,
      title: 'Параметры',
      jira_issue_url: null,
      pipeline_steps: ['resolve'],
      container_name: null,
      status: TaskStatus.draft,
      created_at: now,
      updated_at: now,
    })
    .run();
  return id;
}

describe('getIterationRow', () => {
  let db: Db;

  beforeEach(() => {
    db = createDb(':memory:');
  });


  function seed(id: string): void {
    const now = new Date().toISOString();
    db.insert(iterations)
      .values({
        id,
        issue_id: seedIssueRow(db),
        number: 1,
        context: 'ctx',
        steps: ['resolve'],
        status: 'draft',
        created_at: now,
        updated_at: now,
      })
      .run();
  }

  it('возвращает строку итерации по id', () => {
    const id = randomUUID();
    seed(id);

    const row = getIterationRow(db, id);

    expect(row?.id).toBe(id);
    expect(row?.number).toBe(1);
  });

  it('на отсутствующей строке отдаёт null, а не undefined', () => {
    expect(getIterationRow(db, randomUUID())).toBeNull();
  });
});