import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { createRepo } from '../helpers';

const REPO_URL = 'https://github.com/acme/e2e.git';

// Относительный URL: request-контекст Playwright разрешает его против
// `use.baseURL` (vite :5196), а vite проксирует на мок-бэкенд.
const API_BASE = '/issue-resolver/api/v1';

/**
 * Удаляет созданные тестом задачи через API мок-бэкенда (каскадом уходят
 * repositories/iterations/step_runs/step_outputs). Ошибки cleanup не должны
 * ронять тест — только логируются.
 */
async function cleanupCreatedIssues(
  request: APIRequestContext,
  titles: string[],
): Promise<void> {
  if (titles.length === 0) {
    return;
  }
  const wanted = new Set(titles);
  try {
    const listRes = await request.get(`${API_BASE}/issues`);
    if (!listRes.ok()) {
      console.warn(`[e2e cleanup] GET /issues → ${listRes.status()}`);
      return;
    }
    const issues = (await listRes.json()) as Array<{ id: string; title: string }>;
    for (const issue of issues) {
      if (!wanted.has(issue.title)) {
        continue;
      }
      try {
        const delRes = await request.delete(`${API_BASE}/issues/${issue.id}`);
        if (delRes.ok()) {
          console.log(`[e2e cleanup] deleted ${issue.id} «${issue.title}»`);
        } else if (delRes.status() === 404) {
          console.warn(`[e2e cleanup] ${issue.id} already gone (404)`);
        } else {
          console.warn(
            `[e2e cleanup] DELETE ${issue.id} → ${delRes.status()}`,
          );
        }
      } catch (error) {
        console.warn(`[e2e cleanup] DELETE ${issue.id} failed:`, error);
      }
    }
  } catch (error) {
    console.warn('[e2e cleanup] unexpected error:', error);
  }
}

/**
 * Создаёт задачу через реальную форму NewIssue поверх мок-бэкенда:
 * сохраняет репозиторий (страница «Репозитории») и выбирает его в форме.
 */
async function createIssueThroughUi(page: Page, title: string): Promise<void> {
  await createRepo(page, REPO_URL, 'main');

  await page.goto('/#/new');
  await expect(
    page.getByRole('heading', { name: 'Создание задачи' }),
  ).toBeVisible();
  await page.getByLabel('Заголовок').fill(title);

  await page.getByRole('button', { name: 'Добавить репозиторий' }).click();
  await page.getByTestId('repository-select-0').selectOption({ index: 1 });
  await expect(page.getByTestId('repository-branch-0')).not.toHaveValue('');

  await page.getByRole('button', { name: 'Запустить', exact: true }).click();
  await expect(page.getByRole('heading', { name: title })).toBeVisible();
}

/**
 * Первая волна UI-сценариев. Заголовки уникальны через Date.now(),
 * селекторы — по реальным aria-labels/text из NewIssue/TasksList/TaskDetail.
 */
test.describe('Issue Resolver UI', () => {
  let createdTitles: string[] = [];

  test.beforeEach(() => {
    createdTitles = [];
  });

  test.afterEach(async ({ request }) => {
    await cleanupCreatedIssues(request, createdTitles);
    createdTitles = [];
  });

  test('создать → деталь', async ({ page }) => {
    const title = `E2E-${Date.now()}`;
    createdTitles.push(title);

    await createIssueThroughUi(page, title);

    // После создания App переключается на деталь новой задачи.
    await expect(page.getByText('Итерация #1')).toBeVisible();
  });

  test('деталь + новая итерация', async ({ page }) => {
    // Мок-агент завершает resolve быстро — ждём settle итерации до клика по
    // кнопке новой итерации.
    test.setTimeout(120_000);
    const title = `E2E-${Date.now()}`;
    createdTitles.push(title);

    await createIssueThroughUi(page, title);

    // Backend автосоздаёт итерацию #1 при создании задачи.
    await expect(page.getByText('Итерация #1')).toBeVisible();

    // Дожидаемся, что итерация #1 больше не running: пока она running,
    // кнопка «Запустить новую итерацию» disabled (canStartIteration).
    await expect(page.getByTestId('abort-iteration')).toBeHidden({
      timeout: 90_000,
    });

    // Добавляем новую итерацию — список должен вырасти до #2.
    await page.getByLabel('Контекст итерации').fill(`second attempt ${title}`);
    await page
      .getByRole('button', { name: 'Запустить новую итерацию' })
      .click();

    await expect(page.getByText('Итерация #2')).toBeVisible();
  });
});