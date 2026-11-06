import { expect, test } from '@playwright/test';
import type { Issue } from '@issue-resolver/shared';
import { createIssueViaUI, uniqueTitle } from '../helpers';

test.describe('concurrent issues', () => {
  test('две задачи в списке, статусы независимы, каждая открывается', async ({
    page,
  }) => {
    const titleA = uniqueTitle('e2e-parallel-a');
    const titleB = uniqueTitle('e2e-parallel-b');

    const idA = await createIssueViaUI(page, {
      title: titleA,
      bootstrapEnabled: false,
    });
    const idB = await createIssueViaUI(page, {
      title: titleB,
      bootstrapEnabled: false,
    });

    await page.route(/\/issues$/, async (route) => {
      if (route.request().method() !== 'GET') return route.fallback();
      const response = await route.fetch();
      const issues = (await response.json()) as Issue[];
      const patched = issues.map((issue) => {
        if (issue.id === idA) return { ...issue, status: 'running' as const };
        if (issue.id === idB) return { ...issue, status: 'completed' as const };
        return issue;
      });
      await route.fulfill({ response, json: patched });
    });

    await page.goto('/tasks');

    const cardA = page.locator('article', { hasText: titleA });
    const cardB = page.locator('article', { hasText: titleB });

    await expect(cardA).toBeVisible();
    await expect(cardB).toBeVisible();

    await expect(cardA.getByTestId('issue-status')).toHaveAttribute(
      'data-status',
      'running',
    );
    await expect(cardA.getByTestId('issue-status')).toHaveText('В работе');
    await expect(cardB.getByTestId('issue-status')).toHaveAttribute(
      'data-status',
      'completed',
    );
    await expect(cardB.getByTestId('issue-status')).toHaveText('Завершено');

    await expect(cardA.getByText('Завершено')).toHaveCount(0);
    await expect(cardB.getByText('В работе')).toHaveCount(0);

    await cardA.getByTestId('issue-status').click();
    await expect(page.getByRole('heading', { name: titleA })).toBeVisible();

    await page.goto('/tasks');
    await page.locator('article', { hasText: titleB }).getByTestId(
      'issue-status',
    ).click();
    await expect(page.getByRole('heading', { name: titleB })).toBeVisible();
  });
});