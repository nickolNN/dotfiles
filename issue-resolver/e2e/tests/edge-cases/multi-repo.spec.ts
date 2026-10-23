import { expect, test } from '@playwright/test';
import {
  FakeApi,
  logChunk,
  createRepo,
  getLatestIssueId,
  wsProgress,
} from '../../helpers';

/**
 * Задача с двумя репозиториями: и форма (оба уходят с bootstrap_enabled),
 * и панель подготовки (обе подписи репо), и живой devops-вывод.
 *
 * SSE отдаём скриптом: реальный DevOps-агент гоняет pi-анализатор на каждый
 * репозиторий (минуты), а контракт «событие → подпись/лог» здесь
 * проверяется детерминированно. Вывод обоих репо идёт одним stepRunId
 * `{issueId}/devops` — это единая issue-уровневая сессия.
 */
test.describe('edge: подготовка двух репозиториев', () => {
  test('прогресс по каждому репо и общий devops-вывод', async ({
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
      wsProgress('devops', 'running', 'acme/one'),
      wsProgress('installing', 'running', 'acme/one'),
      wsProgress('devops', 'running', 'acme/two'),
      wsProgress('installing', 'running', 'acme/two'),
      logChunk(`${issueId}/devops`, 'deps installed for one\n'),
      logChunk(`${issueId}/devops`, 'deps installed for two\n'),
      logChunk(`${issueId}/devops`, 'npm warn two\n', 'stderr'),
    ]);

    const progress = page.getByTestId('workspace-progress');
    await expect(progress).toBeVisible({ timeout: 20_000 });

    // подписи обоих репозиториев
    await expect(progress.getByText('Клонирование acme/one')).toBeVisible();
    await expect(progress.getByText('Клонирование acme/two')).toBeVisible();

    // devops и installing отработали по обоим репо
    await expect(
      progress.locator(
        '[data-testid="workspace-step"][data-step="devops"]',
      ),
    ).toHaveCount(2);
    await expect(
      progress.locator(
        '[data-testid="workspace-step"][data-step="installing"]',
      ),
    ).toHaveCount(2);
    await expect(progress.getByText('DevOps acme/one')).toBeVisible();
    await expect(progress.getByText('DevOps acme/two')).toBeVisible();
    await expect(
      progress.getByText('Установка зависимостей acme/one'),
    ).toBeVisible();
    await expect(
      progress.getByText('Установка зависимостей acme/two'),
    ).toBeVisible();

    // Живой devops-вывод: одна issue-уровневая сессия (`{issueId}/devops`),
    // без разбивки на блоки по repo — SessionView копит все чанки подряд.
    const session = page.getByTestId('devops-session');
    await expect(session).toBeVisible();
    await expect(session).toContainText('deps installed for one');
    await expect(session).toContainText('deps installed for two');
    await expect(session).toContainText('npm warn two');
  });
});