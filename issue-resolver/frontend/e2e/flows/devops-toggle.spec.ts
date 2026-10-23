import { expect, test } from '@playwright/test';
import {
  API,
  createIssueViaUI,
  iterationStatus,
  mockStreamBatches,
  TEST_REPO_NAME,
  uniqueTitle,
  waitForStatus,
  workspaceProgress,
} from '../helpers';

/**
 * Галочка «Запустить (установка зависимостей)» = `bootstrap_enabled`.
 * Когда она снята, шаги devops/installing помечаются «пропущен», но
 * задача всё равно доходит до running. Флаг проверяем и по реальному API.
 */
test.describe('devops toggle', () => {
  test('devops выключен: шаги пропущены, задача переходит в running', async ({
    page,
    request,
  }) => {
    const title = uniqueTitle('e2e-devops-off');

    await mockStreamBatches(page, '**/issues/*/stream', [
      [
        workspaceProgress('creating_dirs', 'running'),
        workspaceProgress('creating_dirs', 'done'),
        workspaceProgress('cloning', 'running', TEST_REPO_NAME),
        workspaceProgress('cloning', 'done', TEST_REPO_NAME),
        workspaceProgress('checking_instructions', 'running'),
        workspaceProgress('checking_instructions', 'done'),
        workspaceProgress('devops', 'done', TEST_REPO_NAME, 'пропущен'),
        workspaceProgress('installing', 'done', TEST_REPO_NAME, 'пропущен'),
      ],
      [iterationStatus('running')],
    ]);

    const issueId = await createIssueViaUI(page, {
      title,
      bootstrapEnabled: false,
    });

    const panel = page.getByTestId('workspace-progress');
    await expect(panel).toBeVisible();

    // Сводка в шапке: owner/repo + статус «devops пропущен» из SSE.
    const repoRow = page.getByTestId('repo-status-row');
    await expect(repoRow).toHaveAttribute('data-repo', 'octocat/Hello-World');
    await expect(repoRow).toHaveAttribute('data-status', 'skipped');
    await expect(repoRow).toContainText('(запуск отключён)');

    await expect(
      page.locator('[data-testid="workspace-step"][data-step="devops"]'),
    ).toContainText('пропущен');
    await expect(
      page.locator('[data-testid="workspace-step"][data-step="installing"]'),
    ).toContainText('пропущен');

    await waitForStatus(page, 'running');

    // Реальная интеграция: флаг уехал на backend и сохранён в задаче.
    const res = await request.get(`${API}/issues/${issueId}`);
    expect(res.ok()).toBeTruthy();
    const issue = (await res.json()) as {
      repositories: Array<{ bootstrap_enabled: boolean }>;
    };
    expect(issue.repositories[0]?.bootstrap_enabled).toBe(false);
  });
});