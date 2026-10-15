import { expect, test } from '@playwright/test';
import {
  FakeApi,
  bsLog,
  createRepo,
  getLatestIssueId,
  wsProgress,
} from '../../helpers';

/**
 * Задача с двумя репозиториями: и форма (оба уходят с bootstrap_enabled),
 * и панель подготовки (обе подписи репо), и bootstrap-лог (repo-поле).
 *
 * SSE отдаём скриптом: реальный bootstrap гоняет pi-анализатор на каждый
 * репозиторий (минуты), а контракт «событие → подпись/лог по repo» здесь
 * проверяется детерминированно.
 */
test.describe('edge: подготовка двух репозиториев', () => {
  test('прогресс и bootstrap-лог раздельно по каждому репо', async ({
    page,
  }) => {
    const api = new FakeApi();
    await api.install(page);

    await createRepo(page, 'https://github.com/acme/one', 'main');
    await createRepo(page, 'https://github.com/acme/two', 'main');

    await page.goto('/#/new');
    await page.getByLabel('Заголовок').fill('Два репозитория');

    await page.getByRole('button', { name: 'Добавить репозиторий' }).click();
    await expect(page.getByTestId('repository-select-0')).toContainText(
      'acme/one',
    );
    await page.getByTestId('repository-select-0').selectOption({ index: 1 });

    await page.getByRole('button', { name: 'Добавить репозиторий' }).click();
    await page.getByTestId('repository-select-1').selectOption({ index: 2 });

    // bootstrap_enabled включён по умолчанию для обеих строк.
    await page
      .getByRole('button', { name: 'Запустить', exact: true })
      .click();

    const issueId = await getLatestIssueId(page);
    const issue = api.issues.find((item) => item.id === issueId);
    expect(issue?.repositories).toHaveLength(2);
    expect(
      issue?.repositories.every((repo) => repo.bootstrap_enabled === true),
    ).toBe(true);

    api.setSse(issueId, [
      wsProgress('creating_dirs', 'running'),
      wsProgress('cloning', 'running', 'acme/one'),
      wsProgress('cloning', 'done', 'acme/one'),
      wsProgress('cloning', 'done', 'acme/two'),
      wsProgress('bootstrapping', 'running', 'acme/one'),
      wsProgress('installing', 'running', 'acme/one'),
      wsProgress('bootstrapping', 'running', 'acme/two'),
      wsProgress('installing', 'running', 'acme/two'),
      bsLog('acme/one', 'deps installed for one\n'),
      bsLog('acme/two', 'deps installed for two\n'),
      bsLog('acme/two', 'npm warn two\n', 'stderr'),
    ]);

    const progress = page.getByTestId('workspace-progress');
    await expect(progress).toBeVisible({ timeout: 20_000 });

    // подписи обоих репозиториев
    await expect(progress.getByText('Клонирование acme/one')).toBeVisible();
    await expect(progress.getByText('Клонирование acme/two')).toBeVisible();

    // bootstrapping и installing отработали по обоим репо
    await expect(
      progress.locator(
        '[data-testid="workspace-step"][data-step="bootstrapping"]',
      ),
    ).toHaveCount(2);
    await expect(
      progress.locator(
        '[data-testid="workspace-step"][data-step="installing"]',
      ),
    ).toHaveCount(2);
    await expect(progress.getByText('Bootstrapping acme/one')).toBeVisible();
    await expect(progress.getByText('Bootstrapping acme/two')).toBeVisible();
    await expect(
      progress.getByText('Установка зависимостей acme/one'),
    ).toBeVisible();
    await expect(
      progress.getByText('Установка зависимостей acme/two'),
    ).toBeVisible();

    // bootstrap_log: у каждого блока свой repo
    await expect(page.getByTestId('bootstrap-log-repo')).toHaveCount(2);
    await expect(
      page.locator(
        '[data-testid="bootstrap-log-repo"][data-repo="acme/one"]',
      ),
    ).toContainText('deps installed for one');
    await expect(
      page.locator(
        '[data-testid="bootstrap-log-repo"][data-repo="acme/two"]',
      ),
    ).toContainText('deps installed for two');
    await expect(
      page.locator(
        '[data-testid="bootstrap-log-repo"][data-repo="acme/two"] [data-kind="stderr"]',
      ),
    ).toContainText('npm warn two');
  });
});