import { expect, test } from '@playwright/test';
import {
  bootstrapLog,
  createIssueViaUI,
  mockStreamBatches,
  TEST_REPO_NAME,
  uniqueTitle,
  workspaceProgress,
} from '../helpers';

/**
 * Живой лог агента-бутстрапера (`bootstrap_log`): блок появляется во время
 * подготовки, подписан именем репозитория и накапливает порции вывода по мере
 * поступления SSE-событий.
 */
test.describe('bootstrap log', () => {
  test('лог появляется и инкрементально накапливает вывод', async ({ page }) => {
    const title = uniqueTitle('e2e-bootstrap-log');

    await mockStreamBatches(page, '**/issues/*/stream', [
      [
        workspaceProgress('creating_dirs', 'running'),
        workspaceProgress('creating_dirs', 'done'),
        workspaceProgress('cloning', 'done', TEST_REPO_NAME),
        workspaceProgress('checking_instructions', 'running'),
        workspaceProgress('bootstrapping', 'running', TEST_REPO_NAME),
        bootstrapLog(TEST_REPO_NAME, 'Analyzing repository layout...'),
      ],
      [bootstrapLog(TEST_REPO_NAME, 'No package manifests found')],
    ]);

    await createIssueViaUI(page, { title, bootstrapEnabled: true });

    const log = page.getByTestId('bootstrap-log');
    await expect(log).toBeVisible();
    await expect(log).toContainText(TEST_REPO_NAME);
    await expect(log).toContainText('Analyzing repository layout...');
    // Вторая порция приходит следующим переподключением EventSource (~3с);
    // под нагрузкой комнаты даём запас.
    await expect(log).toContainText('No package manifests found', {
      timeout: 30_000,
    });
  });
});