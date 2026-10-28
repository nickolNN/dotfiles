import { expect, test } from '@playwright/test';
import { FakeApi, createRepo, getLatestIssueId } from '../../helpers';

test.describe('edge: желаемый результат', () => {
  test('html → результат рендерится как html', async ({ page }) => {
    const api = new FakeApi();
    await api.install(page);
    const { issue } = api.addIssue({
      title: 'HTML результат',
      status: 'completed',
      desired_result: 'html',
    });
    api.resultHtml.set(
      issue.id,
      '<!doctype html><html><body><h1>HTML RESULT</h1></body></html>',
    );

    await page.goto(`/#/tasks/${issue.id}`);
    await page.getByTestId('open-result').click();
    await expect(page.getByTestId('result-modal')).toBeVisible();

    const frame = page.frameLocator('[data-testid="result-html"]');
    await expect(
      frame.getByRole('heading', { name: 'HTML RESULT' }),
    ).toBeVisible();
    await expect(page.getByTestId('result-markdown')).toHaveCount(0);
  });

  test('pr → радио доступно только с репозиторием и уходит в POST', async ({
    page,
  }) => {
    const api = new FakeApi();
    await api.install(page);
    await createRepo(page, 'https://github.com/acme/one', 'main');

    await page.goto('/#/new');
    await expect(page.getByTestId('desired-result-pr')).toBeDisabled();

    await page.getByLabel('Заголовок').fill('PR результат');
    await page.getByRole('button', { name: 'Добавить репозиторий' }).click();
    await expect(page.getByTestId('repository-select-0')).toContainText(
      'acme/one',
    );
    await page.getByTestId('repository-select-0').selectOption({ index: 1 });

    await expect(page.getByTestId('desired-result-pr')).toBeEnabled();
    await page.getByTestId('desired-result-pr').check();

    await page
      .getByRole('button', { name: 'Запустить', exact: true })
      .click();

    const issueId = await getLatestIssueId(page);
    expect(
      api.issues.find((item) => item.id === issueId)?.desired_result,
    ).toBe('pr');
  });
});