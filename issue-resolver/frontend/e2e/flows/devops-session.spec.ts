import { expect, test } from '@playwright/test';
import {
  logChunk,
  createIssueViaUI,
  mockStreamBatches,
  TEST_REPO_NAME,
  uniqueTitle,
  workspaceProgress,
} from '../helpers';

test.describe('devops session', () => {
  test('вывод появляется и инкрементально накапливается', async ({ page }) => {
    const title = uniqueTitle('e2e-devops-session');

    await mockStreamBatches(page, '**/issues/*/stream', (call, issueId) => {
      const run = `issue.${issueId}.devops`;
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

    await page.route('**/issues/*/devops/status', (route) =>
      route.fulfill({
        json: { status: 'running', startedAt: new Date().toISOString() },
      }),
    );

    await createIssueViaUI(page, { title, bootstrapEnabled: true });

    const session = page.getByTestId('devops-live');
    await expect(session).toBeVisible();
    await expect(session).toContainText('Analyzing repository layout...');
    await expect(session).toContainText('No package manifests found', {
      timeout: 30_000,
    });
  });
});