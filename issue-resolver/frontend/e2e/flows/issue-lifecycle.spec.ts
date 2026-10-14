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

/**
 * Полный жизненный цикл задачи глазами UI: подготовка рабочей папки,
 * шаги `workspace_progress`, переходы статуса preparing → running → failed.
 *
 * Задача создаётся через реальную форму (POST /issues уходит на
 * мок-бэкенд), а событийный поток задачи мокается: так порядок
 * workspace_progress и статусов детерминирован, а не зависит от скорости
 * clone/pi-агента.
 */
test.describe('issue lifecycle', () => {
  test('подготовка → running → терминальный статус', async ({ page }) => {
    const title = uniqueTitle('e2e-lifecycle');
    let currentStatus = 'preparing';

    // GET /issues/:id отдаём реальный, но с управляемым статусом: начальный
    // экран должен показать `preparing` ещё до живых событий.
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
        // Волна 1: шаги разовой подготовки.
        [
          workspaceProgress('creating_dirs', 'running'),
          workspaceProgress('creating_dirs', 'done'),
          workspaceProgress('cloning', 'running', TEST_REPO_NAME),
          workspaceProgress('cloning', 'done', TEST_REPO_NAME),
          workspaceProgress('checking_instructions', 'running'),
          workspaceProgress('checking_instructions', 'done', TEST_REPO_NAME),
          workspaceProgress('bootstrapping', 'running', TEST_REPO_NAME),
          workspaceProgress('bootstrapping', 'done', TEST_REPO_NAME),
          workspaceProgress('installing', 'running', TEST_REPO_NAME),
          workspaceProgress('installing', 'done', TEST_REPO_NAME),
        ],
        // Волна 2: подготовка закончилась — задача в running.
        [workspaceProgress('ready', 'done'), iterationStatus('running')],
        // Волна 3: терминальный сбой; перед этим GET уже отдаёт failed.
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

    // Панель подготовки видна и подписана репозиторием.
    const panel = page.getByTestId('workspace-progress');
    await expect(panel).toBeVisible();
    await expect(panel).toContainText('Подготовка проектов');
    await expect(panel).toContainText(TEST_REPO_NAME);

    // Все шаги workspace_progress отрисованы.
    for (const step of [
      'cloning',
      'checking_instructions',
      'bootstrapping',
      'installing',
    ]) {
      // checking_instructions приходит и глобально, и на репозиторий — берём
      // первую из строк шага.
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

    // Сводка в шапке обновляется живьём по SSE: после installing — installed.
    const repoRow = page.getByTestId('repo-status-row');
    await expect(repoRow).toHaveAttribute('data-repo', 'octocat/Hello-World');
    await expect(repoRow).toHaveAttribute('data-status', 'installed');

    await waitForStatus(page, 'preparing');
    await waitForStatus(page, 'running');
    // Волна 2 прислала `ready` — индикатор репозитория стал готовым.
    await expect(repoRow).toHaveAttribute('data-status', 'ready');
    await waitForStatus(page, 'failed');

    await expect(page.getByTestId('task-island')).toContainText(title);
    expect(issueId).toBeTruthy();
  });
});