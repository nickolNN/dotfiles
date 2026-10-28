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

test.describe('question flow', () => {
  test('модалка → Escape → баннер → ответ', async ({ page }) => {
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
    await page.route('**/iterations/*/ui-response', (route) =>
      route.request().method() === 'POST'
        ? route.fulfill({ json: { ok: true } })
        : route.continue(),
    );
    await mockStreamBatches(page, '**/issues/*/stream', [
      [iterationStatus('question')],
    ]);

    await createIssueViaUI(page, { title, bootstrapEnabled: false });

    const modal = page.getByTestId('question-modal');
    await expect(modal).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(modal).toBeHidden();

    const banner = page.getByTestId('step-pending-question');
    await expect(banner).toBeVisible();
    await banner.click();
    await expect(modal).toBeVisible();

    await modal.getByLabel('Ответ').fill('Ожидаемое поведение: всё ок');
    await modal.getByRole('button', { name: 'Ответить' }).click();
    await expect(modal).toBeHidden();
    await expect(page.getByTestId('step-pending-question')).toBeHidden();
  });
});