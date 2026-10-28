import { expect, test } from '@playwright/test';

const now = new Date().toISOString();

type Status = 'pending' | 'running' | 'completed' | 'failed' | 'question';

function issue(status: Status, title: string) {
  return {
    id: `e2e-${status}`,
    title,
    description: '',
    desired_result: 'md',
    jira_issue_url: null,
    source: null,
    repositories: [],
    pipeline_steps: ['resolve'],
    thinking_level: null,
    status,
    created_at: now,
    updated_at: now,
    workspace_missing: false,
  };
}

const CASES: Array<{ status: Status; label: string; rgb: string }> = [
  { status: 'pending', label: 'В очереди', rgb: 'rgb(0, 143, 17)' },
  { status: 'running', label: 'В работе', rgb: 'rgb(0, 180, 255)' },
  { status: 'completed', label: 'Завершено', rgb: 'rgb(0, 255, 65)' },
  { status: 'failed', label: 'Ошибка', rgb: 'rgb(255, 0, 51)' },
  { status: 'question', label: 'Вопрос', rgb: 'rgb(255, 176, 0)' },
];

test.describe('status badge', () => {
  test('все статусы: подпись и янтарный вопрос', async ({ page }) => {
    await page.route(/\/issue-resolver\/api\/v1\/issues$/, (route) =>
      route.request().method() === 'GET'
        ? route.fulfill({
            json: CASES.map(({ status, label }) => issue(status, label)),
          })
        : route.continue(),
    );

    await page.goto('/#/tasks');
    await expect(
      page.getByRole('heading', { name: 'Мои задачи' }),
    ).toBeVisible();

    for (const { status, label, rgb } of CASES) {
      const badge = page.locator(
        `[data-testid="issue-status"][data-status="${status}"]`,
      );
      await expect(badge).toHaveText(label);
      await expect(badge).toHaveCSS('color', rgb);
    }

    const question = page.locator(
      '[data-testid="issue-status"][data-status="question"]',
    );
    await expect(question).toHaveText('Вопрос');
    await expect(question).toHaveCSS('color', 'rgb(255, 176, 0)');
  });
});