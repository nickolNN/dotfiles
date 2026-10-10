import { eq } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { createDb } from '../src/db/client';
import { issueRepositories, iterations } from '../src/db/schema';

const db = createDb(':memory:');
const app = buildApp(db);

const ENDPOINT = '/issue-resolver/api/v1/issues';

const post = (payload: object) =>
  app.inject({ method: 'POST', url: ENDPOINT, payload });

afterAll(async () => {
  await app.close();
});

describe('POST /issues — успешное создание', () => {
  it('только jira_issue_url + 1 репозиторий → 201, title из ключа тикета', async () => {
    const response = await post({
      jira_issue_url: 'https://jira.example.com/browse/KLA-5672',
      repositories: [
        { repository_url: 'https://github.com/acme/app.git', base_branch: 'main' },
      ],
    });

    expect(response.statusCode).toBe(201);

    const body = response.json();
    expect(typeof body.id).toBe('string');
    expect(body.title).toBe('KLA-5672');
    expect(body.status).toBe('pending');
    expect(body.jira_issue_url).toBe('https://jira.example.com/browse/KLA-5672');
    expect(body.pipeline_steps).toEqual(['refine', 'resolve']);
    expect(body.repositories).toHaveLength(1);
    expect(body.repositories[0].repository_url).toBe(
      'https://github.com/acme/app.git',
    );
    expect(body.repositories[0].branch_name).toBe('main');
    expect(body.repositories[0].created_at).toBe(body.repositories[0].updated_at);
    expect(typeof body.created_at).toBe('string');
  });

  it('title передан без jira → 201, jira_issue_url === null', async () => {
    const response = await post({
      title: 'Моя задача',
      repositories: [
        { repository_url: 'https://github.com/acme/app.git', base_branch: 'main' },
      ],
    });

    expect(response.statusCode).toBe(201);

    const body = response.json();
    expect(body.title).toBe('Моя задача');
    expect(body.jira_issue_url).toBeNull();
    expect(body.status).toBe('pending');
  });

  it('pipeline_steps: дедуп с сохранением порядка, resolve уже есть', async () => {
    const response = await post({
      title: 'Шаги',
      pipeline_steps: ['review', 'resolve', 'review', 'test'],
      repositories: [
        { repository_url: 'https://github.com/acme/app.git', base_branch: 'main' },
      ],
    });

    expect(response.statusCode).toBe(201);
    // 'resolve' уже присутствует → позиция сохраняется; дубли убираются.
    expect(response.json().pipeline_steps).toEqual(['review', 'resolve', 'test']);
  });

  it('pipeline_steps без resolve → resolve добавлен в начало', async () => {
    const response = await post({
      title: 'Без resolve',
      pipeline_steps: ['review', 'test'],
      repositories: [
        { repository_url: 'https://github.com/acme/app.git', base_branch: 'main' },
      ],
    });

    expect(response.statusCode).toBe(201);
    expect(response.json().pipeline_steps).toEqual(['resolve', 'review', 'test']);
  });

  it('пишет issue_repositories и iteration #1 в БД (одна транзакция)', async () => {
    const response = await post({
      title: 'С контекстом',
      additional_context: 'доп контекст',
      pipeline_steps: ['review'],
      repositories: [
        { repository_url: 'https://github.com/acme/app.git', base_branch: 'main' },
        { repository_url: 'https://github.com/acme/lib.git', base_branch: 'develop' },
      ],
    });

    expect(response.statusCode).toBe(201);
    const body = response.json();

    const repoRows = db
      .select()
      .from(issueRepositories)
      .where(eq(issueRepositories.issue_id, body.id))
      .all();
    expect(repoRows).toHaveLength(2);
    expect(repoRows.map((row) => row.branch_name).sort()).toEqual([
      'develop',
      'main',
    ]);

    const iterationRows = db
      .select()
      .from(iterations)
      .where(eq(iterations.issue_id, body.id))
      .all();
    expect(iterationRows).toHaveLength(1);
    expect(iterationRows[0].number).toBe(1);
    // Фоновый прогон стартует сразу после создания → running/completed.
    expect(['running', 'completed']).toContain(iterationRows[0].status);
    expect(iterationRows[0].context).toBe('доп контекст');
    expect(iterationRows[0].steps).toEqual(['resolve', 'review']);
  });

  it('is_review_need:true → review и test сразу после resolve', async () => {
    const response = await post({
      title: 'Ревью',
      is_review_need: true,
      repositories: [
        { repository_url: 'https://github.com/acme/app.git', base_branch: 'main' },
      ],
    });

    expect(response.statusCode).toBe(201);
    expect(response.json().pipeline_steps).toEqual([
      'refine',
      'resolve',
      'review',
      'test',
    ]);
  });

  it('create_mr:true у репозитория → pr в конец', async () => {
    const response = await post({
      title: 'MR',
      desired_result: 'pr',
      repositories: [
        {
          repository_url: 'https://github.com/acme/app.git',
          base_branch: 'main',
          create_mr: true,
        },
      ],
    });

    expect(response.statusCode).toBe(201);
    expect(response.json().pipeline_steps).toEqual(['refine', 'resolve', 'pr']);
  });

  it('is_review_need:true + create_mr:true → refine,resolve,review,test,pr', async () => {
    const response = await post({
      title: 'Ревью + MR',
      is_review_need: true,
      desired_result: 'pr',
      repositories: [
        {
          repository_url: 'https://github.com/acme/app.git',
          base_branch: 'main',
          create_mr: true,
        },
      ],
    });

    expect(response.statusCode).toBe(201);
    expect(response.json().pipeline_steps).toEqual([
      'refine',
      'resolve',
      'review',
      'test',
      'pr',
    ]);
  });
});

describe('POST /issues — валидация', () => {
  it('без title и без jira → 400', async () => {
    const response = await post({
      repositories: [
        { repository_url: 'https://github.com/acme/app.git', base_branch: 'main' },
      ],
    });

    expect(response.statusCode).toBe(400);
    expect(typeof response.json().error).toBe('string');
  });

  it('repositories не массив → 400', async () => {
    const response = await post({ title: 'Пусто', repositories: 'nope' });

    expect(response.statusCode).toBe(400);
    expect(typeof response.json().error).toBe('string');
  });

  it('repository_url не URL → 400', async () => {
    const response = await post({
      title: 'Кривой URL',
      repositories: [{ repository_url: 'not-a-url', base_branch: 'main' }],
    });

    expect(response.statusCode).toBe(400);
    expect(typeof response.json().error).toBe('string');
  });

  it('base_branch пустой → 400', async () => {
    const response = await post({
      title: 'Пустая ветка',
      repositories: [{ repository_url: 'https://github.com/acme/app.git', base_branch: '' }],
    });

    expect(response.statusCode).toBe(400);
    expect(typeof response.json().error).toBe('string');
  });

  it('jira_issue_url без ключа в пути → 400', async () => {
    const response = await post({
      jira_issue_url: 'https://jira.example.com/',
      repositories: [
        { repository_url: 'https://github.com/acme/app.git', base_branch: 'main' },
      ],
    });

    expect(response.statusCode).toBe(400);
    expect(typeof response.json().error).toBe('string');
  });

  it('step_models с невалидным ключом шага → 400', async () => {
    const response = await post({
      title: 'Кривой шаг',
      step_models: { bogus: 'm' },
      repositories: [],
    });

    expect(response.statusCode).toBe(400);
    expect(typeof response.json().error).toBe('string');
  });

  it('step_models с нестроковым значением → 400', async () => {
    const response = await post({
      title: 'Кривой тип',
      step_models: { resolve: 5 },
      repositories: [],
    });

    expect(response.statusCode).toBe(400);
    expect(typeof response.json().error).toBe('string');
  });
});