import { expect, test } from '@playwright/test';
import {
  createIssueViaUI,
  issueDetailPattern,
  iterationStatus,
  mockStreamBatches,
  TEST_REPO_NAME,
  uniqueTitle,
  waitForStatus,
  workspaceProgress,
} from '../helpers';

test.describe('issue lifecycle', () => {
  test('подготовка → running → терминальный статус', async ({ page }) => {
    const title = uniqueTitle('e2e-lifecycle');
    let currentStatus = 'preparing';

    await page.route(issueDetailPattern, async (route) => {
      const response = await route.fetch();
      const body = (await response.json()) as Record<string, unknown>;
      await route.fulfill({
        response,
        body: JSON.stringify({ ...body, status: currentStatus }),
      });
    });

    await mockStreamBatches(
      page,
      '**/issues/*/stream',
      [
        [
          workspaceProgress('creating_dirs', 'running'),
          workspaceProgress('creating_dirs', 'done'),
          workspaceProgress('cloning', 'running', TEST_REPO_NAME),
          workspaceProgress('cloning', 'done', TEST_REPO_NAME),
          workspaceProgress('checking_instructions', 'running'),
          workspaceProgress('checking_instructions', 'done', TEST_REPO_NAME),
          workspaceProgress('devops', 'running', TEST_REPO_NAME),
          workspaceProgress('devops', 'done', TEST_REPO_NAME),
          workspaceProgress('installing', 'running', TEST_REPO_NAME),
          workspaceProgress('installing', 'done', TEST_REPO_NAME),
        ],
        [workspaceProgress('ready', 'done'), iterationStatus('running')],
        [iterationStatus('failed')],
      ],
      (call) => {
        if (call === 3) currentStatus = 'failed';
      },
    );

    const issueId = await createIssueViaUI(page, {
      title,
      description: 'Жизненный цикл: подготовка и переходы статуса.',
      bootstrapEnabled: true,
    });

    const panel = page.getByTestId('workspace-progress');
    await expect(panel).toBeVisible();
    await expect(panel).toContainText('Подготовка проектов');
    await expect(panel).toContainText(TEST_REPO_NAME);

    for (const step of [
      'cloning',
      'checking_instructions',
      'devops',
      'installing',
    ]) {
      await expect(
        page
          .locator(`[data-testid="workspace-step"][data-step="${step}"]`)
          .first(),
      ).toBeVisible();
    }
    await expect(
      page.locator(
        '[data-testid="workspace-step"][data-step="installing"][data-status="done"]',
      ),
    ).toBeVisible();

    const repoRow = page.getByTestId('repo-status-row');
    await expect(repoRow).toHaveAttribute('data-repo', 'octocat/Hello-World');
    await expect(repoRow).toHaveAttribute('data-status', 'installed');

    await waitForStatus(page, 'preparing');
    await waitForStatus(page, 'running');
    await expect(repoRow).toHaveAttribute('data-status', 'ready');
    await waitForStatus(page, 'failed');

    await expect(page.getByTestId('task-island')).toContainText(title);
    expect(issueId).toBeTruthy();
  });
});