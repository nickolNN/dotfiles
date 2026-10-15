import { expect, test } from '@playwright/test';
import { FakeApi } from '../../helpers';

/**
 * Две задачи в списке одновременно. `FakeApi` даёт детерминированный набор
 * (реальная БД общая с другими агентами), а разные статусы проверяют, что
 * прогресс задач считается независимо.
 */
test.describe('edge: две задачи одновременно', () => {
  test('обе в списке, статусы независимы', async ({ page }) => {
    const api = new FakeApi();
    await api.install(page);
    api.addIssue({ title: 'Параллельная A', status: 'running' });
    api.addIssue({ title: 'Параллельная B', status: 'completed' });

    await page.goto('/');
    const rowA = page.locator('tr', { hasText: 'Параллельная A' });
    const rowB = page.locator('tr', { hasText: 'Параллельная B' });

    await expect(rowA).toBeVisible();
    await expect(rowB).toBeVisible();

    // статус-бейджи корректны и не перепутаны
    await expect(rowA.getByText('В работе')).toBeVisible();
    await expect(rowB.getByText('Завершено')).toBeVisible();
    await expect(rowA.getByText('Завершено')).toHaveCount(0);
    await expect(rowB.getByText('В работе')).toHaveCount(0);

    // каждая задача открывается в свою деталь
    await rowA.click();
    await expect(
      page.getByRole('heading', { name: 'Параллельная A' }),
    ).toBeVisible();

    await page.goto('/');
    await page.locator('tr', { hasText: 'Параллельная B' }).click();
    await expect(
      page.getByRole('heading', { name: 'Параллельная B' }),
    ).toBeVisible();
  });
});