import { expect, test } from '@playwright/test';

const API = '/issue-resolver/api/v1';

/**
 * Валидация форм — здесь мок-бэкенд: 400/422 не создают записей, а проверяется
 * реальный контракт роутов.
 */
test.describe('edge: валидация форм', () => {
  test('пустой заголовок → серверная ошибка валидации', async ({ page }) => {
    await page.goto('/#/new');
    await expect(
      page.getByRole('heading', { name: 'Создание задачи' }),
    ).toBeVisible();

    await page
      .getByRole('button', { name: 'Запустить', exact: true })
      .click();

    await expect(page.getByRole('alert')).toContainText('title');
  });

  test('несуществующий repo_id → 422 Repository not found', async ({
    page,
  }) => {
    // Реальная форма больше не вводит URL, поэтому чужой repo_id
    // подставляем в уходящее тело — так проверяем именно серверный 422.
    await page.route(`**${API}/issues`, async (route) => {
      if (route.request().method() !== 'POST') {
        await route.fallback();
        return;
      }
      const body = route.request().postDataJSON() as Record<string, unknown>;
      body.repositories = [
        {
          repo_id: '00000000-0000-0000-0000-000000000000',
          base_branch: 'main',
          create_mr: false,
          bootstrap_enabled: false,
        },
      ];
      await route.continue({ postData: JSON.stringify(body) });
    });

    await page.goto('/#/new');
    await page.getByLabel('Заголовок').fill(`e2e-422-${Date.now()}`);
    await page
      .getByRole('button', { name: 'Запустить', exact: true })
      .click();

    await expect(page.getByRole('alert')).toContainText(
      'Repository not found',
    );
  });

  test('нераспознаваемый URL репозитория → клиентская ошибка', async ({
    page,
  }) => {
    await page.goto('/#/repositories');
    await page.getByTestId('repo-add').click();
    await expect(page.getByTestId('repo-form')).toBeVisible();

    await page
      .getByTestId('repo-url-field')
      .fill('https://exa mple.com/acme/repo');

    await expect(page.getByTestId('repo-url-input')).toHaveAttribute(
      'data-state',
      'invalid',
    );
    await expect(page.getByTestId('repo-url-message')).toContainText(
      'Invalid URL',
    );
    await expect(page.getByTestId('repo-form-save')).toBeDisabled();
  });
});