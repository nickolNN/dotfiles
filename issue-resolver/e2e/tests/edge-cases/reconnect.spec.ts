import { expect, test } from '@playwright/test';
import { FakeApi, wsProgress } from '../../helpers';

/**
 * Переподключение SSE после обрыва.
 *
 * Отступление от исходной спеки: у `TaskDetail` сейчас НЕТ видимого
 * индикатора «соединение потеряно / переподключаемся» (в `subscribeToIssueEvents`
 * не передаётся `onError`). Поэтому проверяем наблюдаемое поведение:
 * во время обрыва события не доходят, а после «подъёма backend» EventSource
 * восстанавливается сам и доставляет новые события — состояние UI
 * обновляется.
 */
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

    // соединение установилось — пришли первые события
    await expect(page.getByTestId('workspace-progress')).toBeVisible({
      timeout: 20_000,
    });
    await expect(page.getByText('Клонирование acme/one')).toBeVisible();

    // backend «умер»: стрим больше не отвечает
    api.killSse(issue.id);
    api.setSse(issue.id, [
      wsProgress('creating_dirs', 'running'),
      wsProgress('cloning', 'running', 'acme/one'),
      wsProgress('installing', 'running', 'acme/one'),
    ]);

    // пока соединение лежит, новые события не доходят
    await page.waitForTimeout(4500);
    await expect(
      page.getByText('Установка зависимостей acme/one'),
    ).toHaveCount(0);

    // backend «поднялся» — EventSource переподключается и догоняет состояние
    api.restartSse(issue.id);
    await expect(
      page.getByText('Установка зависимостей acme/one'),
    ).toBeVisible({ timeout: 20_000 });
  });
});