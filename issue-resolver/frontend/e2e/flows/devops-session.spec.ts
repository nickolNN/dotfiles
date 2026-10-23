import { expect, test } from '@playwright/test';
import {
  logChunk,
  createIssueViaUI,
  mockStreamBatches,
  TEST_REPO_NAME,
  uniqueTitle,
  workspaceProgress,
} from '../helpers';

/**
 * Живой вывод DevOps-агента: SSE `log` с синтетическим stepRunId
 * `{issueId}/devops` рендерится тем же `SessionView`, что и шаги, внутри
 * панели подготовки (`data-testid="devops-session"`).
 */
test.describe('devops session', () => {
  test('вывод появляется и инкрементально накапливается', async ({ page }) => {
    const title = uniqueTitle('e2e-devops-session');

    await mockStreamBatches(page, '**/issues/*/stream', (call, issueId) => {
      const run = `${issueId}/devops`;
      if (call === 1) {
        return [
          workspaceProgress('creating_dirs', 'running'),
          workspaceProgress('creating_dirs', 'done'),
          workspaceProgress('cloning', 'done', TEST_REPO_NAME),
          workspaceProgress('checking_instructions', 'running'),
          workspaceProgress('devops', 'running', TEST_REPO_NAME),
          logChunk(run, 'Analyzing repository layout...\n'),
        ];
      }
      if (call === 2) {
        return [logChunk(run, 'No package manifests found\n')];
      }
      return [];
    });

    await createIssueViaUI(page, { title, bootstrapEnabled: true });

    const session = page.getByTestId('devops-session');
    await expect(session).toBeVisible();
    await expect(session).toContainText('Analyzing repository layout...');
    // Вторая порция приходит следующим переподключением EventSource (~3с);
    // под нагрузкой комнаты даём запас.
    await expect(session).toContainText('No package manifests found', {
      timeout: 30_000,
    });
  });
});