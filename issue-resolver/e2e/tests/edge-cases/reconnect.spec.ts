import { expect, test } from '@playwright/test';
import { FakeApi, wsProgress } from '../../helpers';

test.describe('edge: переподключение SSE', () => {
  test('обрыв потока и восстановление после рестарта backend', async ({
    page,
  }) => {
    const api = new FakeApi();
    await api.install(page);
    const { issue } = api.addIssue({ title: 'Reconnect', status: 'running' });

    api.setSse(issue.id, [
      wsProgress('creating_dirs', 'running'),
      wsProgress('cloning', 'running', 'acme/one'),
    ]);

    await page.goto(`/#/tasks/${issue.id}`);

    await expect(page.getByTestId('workspace-progress')).toBeVisible({
      timeout: 20_000,
    });
    await expect(page.getByText('Клонирование acme/one')).toBeVisible();

    api.killSse(issue.id);
    api.setSse(issue.id, [
      wsProgress('creating_dirs', 'running'),
      wsProgress('cloning', 'running', 'acme/one'),
      wsProgress('installing', 'running', 'acme/one'),
    ]);

    await page.waitForTimeout(4500);
    await expect(
      page.getByText('Установка зависимостей acme/one'),
    ).toHaveCount(0);

    api.restartSse(issue.id);
    await expect(
      page.getByText('Установка зависимостей acme/one'),
    ).toBeVisible({ timeout: 20_000 });
  });
});