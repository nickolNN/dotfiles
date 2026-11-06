import { expect, test } from '@playwright/test';
import {
  createIssueViaUI,
  iterationStatus,
  mockStreamBatches,
  uniqueTitle,
} from '../helpers';

const ITERATION_ID = 'e2e-iteration-question';
const STEP_RUN_ID = 'e2e-step-run-question';
const QUESTION_ID = 'e2e-question-1';

const now = () => new Date().toISOString();

const iteration = {
  id: ITERATION_ID,
  issue_id: 'e2e-issue',
  number: 1,
  context: 'Вопрос от агента',
  review_context: '',
  is_review_need: false,
  steps: ['resolve'],
  status: 'running',
  model: null,
  thinking_level: null,
  created_at: now(),
  updated_at: now(),
};

const stepRun = {
  id: STEP_RUN_ID,
  iteration_id: ITERATION_ID,
  step: 'resolve',
  attempt: 1,
  status: 'running',
  context: '',
  feedback: null,
  created_at: now(),
  updated_at: now(),
  stdout: '',
  stderr: '',
  stats: null,
  report: null,
  screenshots_dir: null,
  events: [
    {
      type: 'question',
      id: QUESTION_ID,
      method: 'input',
      title: 'Уточните детали задачи',
      message: 'Опишите ожидаемое поведение',
    },
  ],
};

async function openQuestionScreen(
  page: Parameters<typeof createIssueViaUI>[0],
): Promise<Record<string, unknown>[]> {
  const responses: Record<string, unknown>[] = [];
  const title = uniqueTitle('e2e-question');

  await page.route('**/issues/*/iterations', (route) =>
    route.request().method() === 'GET'
      ? route.fulfill({ json: [iteration] })
      : route.continue(),
  );
  await page.route('**/iterations/*/step-runs', (route) =>
    route.fulfill({ json: [stepRun] }),
  );
  await page.route('**/iterations/*/question-answers', (route) =>
    route.fulfill({ json: [] }),
  );
  await page.route('**/iterations/*/ui-response', (route) => {
    responses.push((route.request().postDataJSON() ?? {}) as Record<string, unknown>);
    return route.request().method() === 'POST'
      ? route.fulfill({ json: { ok: true } })
      : route.continue();
  });
  await mockStreamBatches(page, '**/issues/*/stream', [
    [iterationStatus('question')],
  ]);

  await createIssueViaUI(page, { title, bootstrapEnabled: false });
  return responses;
}

test.describe('question flow', () => {
  test('вопрос виден инлайном, ответ отправляется и блок исчезает', async ({
    page,
  }) => {
    const responses = await openQuestionScreen(page);

    const question = page.getByTestId('inline-question');
    await expect(question).toBeVisible();
    await expect(question).toContainText('Уточните детали задачи');

    await question.getByLabel('Ответ').fill('Ожидаемое поведение: всё ок');
    await question.getByRole('button', { name: 'Ответить' }).click();

    await expect(question).toBeHidden();
    expect(responses).toHaveLength(1);
    expect(responses[0]).toMatchObject({
      id: QUESTION_ID,
      value: 'Ожидаемое поведение: всё ок',
    });
  });

  test('крестик отправляет отмену и блок исчезает', async ({ page }) => {
    const responses = await openQuestionScreen(page);

    const question = page.getByTestId('inline-question');
    await expect(question).toBeVisible();

    await question.getByTestId('question-close').click();

    await expect(question).toBeHidden();
    expect(responses).toHaveLength(1);
    expect(responses[0]).toMatchObject({ id: QUESTION_ID, cancelled: true });
  });
});