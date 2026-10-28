import { expect, test } from '@playwright/test';
import { FakeApi, getLatestIssueId } from '../../helpers';

test.describe('edge: пустое состояние списка задач', () => {
  test('пустой список показывает заглушку, первая задача его наполняет', async ({
    page,
  }) => {
    const api = new FakeApi();
    await api.install(page);

    await page.goto('/');
    await expect(
      page.getByRole('heading', { name: 'Мои задачи' }),
    ).toBeVisible();
    await expect(page.getByText('Пока нет ни одной задачи.')).toBeVisible();

    await page.getByRole('button', { name: 'Создать задачу' }).click();
    await expect(
      page.getByRole('heading', { name: 'Создание задачи' }),
    ).toBeVisible();
    await page.getByLabel('Заголовок').fill('Первая задача');
    await page.getByRole('button', { name: 'Запустить' }).click();

    await getLatestIssueId(page);
    await expect(
      page.getByRole('heading', { name: 'Первая задача' }),
    ).toBeVisible();

    await page.goto('/');
    await expect(page.getByText('Пока нет ни одной задачи.')).toBeHidden();
    await expect(page.getByText('Первая задача')).toBeVisible();
  });
});