import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { createDb } from '../src/db/client';
import { insertMergeRequest } from '../src/db/iteration-mr.repo';
import { issueRepositories, issues, iterations } from '../src/db/schema';
import { FakePiRunner } from '../src/pi/runner';
import { FakeMrClient } from '../src/pr/mr';

const ISSUES = '/issue-resolver/api/v1/issues';
const MR_URL = 'https://github.com/acme/app/pull/1';
const HEAD_BRANCH = 'feature/kos-1-fix-abcd12';
const REPO_URL = 'https://github.com/acme/app.git';

interface Fixture {
  db: ReturnType<typeof createDb>;
  root: string;
  issueId: string;
  iterationId: string;
  cleanup: () => Promise<void>;
}

/** Задача + репозиторий + завершённая итерация + сохранённый MR. */
function seed(): Fixture {
  const db = createDb(':memory:');
  const root = mkdtempSync(join(tmpdir(), 'issue-resolver-far-'));
  const issueId = randomUUID();
  const iterationId = randomUUID();
  const now = new Date().toISOString();

  db.insert(issues)
    .values({
      id: issueId,
      title: 'KOS-1 Fix bug',
      description: '',
      desired_result: 'md',
      pipeline_steps: ['resolve', 'pr'],
      status: 'completed',
      created_at: now,
      updated_at: now,
    })
    .run();
  db.insert(issueRepositories)
    .values({
      id: randomUUID(),
      issue_id: issueId,
      repository_url: REPO_URL,
      branch_name: 'main',
      create_mr: true,
      bootstrap_enabled: true,
      created_at: now,
      updated_at: now,
    })
    .run();
  db.insert(iterations)
    .values({
      id: iterationId,
      issue_id: issueId,
      number: 1,
      context: 'старый контекст',
      review_context: '',
      is_review_need: false,
      steps: ['resolve', 'pr'],
      status: 'completed',
      created_at: now,
      updated_at: now,
      amend_branch: null,
    })
    .run();
  insertMergeRequest(db, {
    iterationId,
    repositoryUrl: REPO_URL,
    mrUrl: MR_URL,
    mrId: '42',
    mrSource: 'github',
    headBranch: HEAD_BRANCH,
    createdAt: now,
  });

  return {
    db,
    root,
    issueId,
    iterationId,
    cleanup: async () => {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

describe('POST /issues/:issueId/fix-after-review', () => {
  it('нет MR у задачи → 404', async () => {
    const { db, root, issueId, cleanup } = seed();
    const app = buildApp(db, { pi: new FakePiRunner(), workspaceRoot: root });
    try {
      // Задача без MR: чистим таблицу MR.
      db.delete(iterations).run();
      const response = await app.inject({
        method: 'POST',
        url: `${ISSUES}/${issueId}/fix-after-review`,
      });
      expect(response.statusCode).toBe(404);
      expect(response.json()).toEqual({ error: 'no merge requests for issue' });
    } finally {
      await app.close();
      await cleanup();
    }
  });

  it('создаёт amend-итерацию из комментариев MR (201)', async () => {
    const { db, root, issueId, cleanup } = seed();
    const mr = new FakeMrClient();
    mr.setMrComments([
      {
        id: 'c1',
        author: 'reviewer',
        body: 'Поправь обработку ошибок',
        createdAt: '2026-01-01T00:00:00.000Z',
        resolved: false,
      },
    ]);
    const app = buildApp(db, {
      pi: new FakePiRunner(),
      mr,
      workspaceRoot: root,
    });
    try {
      const response = await app.inject({
        method: 'POST',
        url: `${ISSUES}/${issueId}/fix-after-review`,
      });

      expect(response.statusCode).toBe(201);
      const body = response.json();
      expect(body.number).toBe(2);
      expect(body.amend_branch).toBe(HEAD_BRANCH);
      expect(body.steps).toEqual(['refine', 'resolve', 'review', 'test', 'pr']);
      expect(body.is_review_need).toBe(false);
      expect(body.review_context).toContain('Поправь обработку ошибок');
      expect(body.context).toContain('старый контекст');
      expect(body.context).toContain('Поправь обработку ошибок');
      expect(body.context).toContain('review_comments');

      expect(mr.getMrCommentsCalls).toHaveLength(1);
      expect(mr.getMrCommentsCalls[0].mrId).toBe('42');
      expect(mr.getMrCommentsCalls[0].repositoryUrl).toBe(REPO_URL);
    } finally {
      await app.close();
      await cleanup();
    }
  });
});

describe('GET /issues/:issueId/merge-requests', () => {
  it('отдаёт MR со статусом с хостинга и счётчиками комментариев', async () => {
    const { db, root, issueId, cleanup } = seed();
    const mr = new FakeMrClient();
    mr.setMrState({
      mrId: '42',
      mrUrl: MR_URL,
      status: 'merged',
      title: 'Fix bug',
      description: '',
    });
    mr.setMrComments([
      {
        id: 'c1',
        author: 'reviewer',
        body: 'незакрытый',
        createdAt: '2026-01-01T00:00:00.000Z',
        resolved: false,
      },
      {
        id: 'c2',
        author: 'author',
        body: 'закрытый',
        createdAt: '2026-01-01T00:00:00.000Z',
        resolved: true,
      },
    ]);
    const app = buildApp(db, {
      pi: new FakePiRunner(),
      mr,
      workspaceRoot: root,
    });
    try {
      const response = await app.inject({
        method: 'GET',
        url: `${ISSUES}/${issueId}/merge-requests`,
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual([
        {
          repositoryUrl: REPO_URL,
          mrUrl: MR_URL,
          mrId: '42',
          mrSource: 'github',
          status: 'merged',
          commentCount: 2,
          unresolvedCount: 1,
        },
      ]);
    } finally {
      await app.close();
      await cleanup();
    }
  });

  it('нет задачи → 404', async () => {
    const { db, root, cleanup } = seed();
    const app = buildApp(db, { pi: new FakePiRunner(), workspaceRoot: root });
    try {
      const response = await app.inject({
        method: 'GET',
        url: `${ISSUES}/${randomUUID()}/merge-requests`,
      });
      expect(response.statusCode).toBe(404);
      expect(response.json()).toEqual({ error: 'issue not found' });
    } finally {
      await app.close();
      await cleanup();
    }
  });
});