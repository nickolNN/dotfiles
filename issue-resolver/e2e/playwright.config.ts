import { defineConfig } from '@playwright/test';

/** Порт выделенного мок-бэкенда (e2e-server) и vite-фронта. */
const BACKEND_PORT = Number(process.env.E2E_BACKEND_PORT ?? 8096);
const FRONTEND_PORT = Number(process.env.E2E_FRONTEND_PORT ?? 5196);

/**
 * Конфиг для edge-case и flow тестов в корневой `e2e/tests/`.
 *
 * Поднимает свой мок-стек (e2e-server + vite на 8096/5196): edge-cases
 * перехватывают API/SSE через Playwright, а `flow.spec.ts` ходит через
 * vite-прокси на мок-бэкенд. Реальные Docker/git/pi/сеть не нужны, поэтому
 * прогон детерминирован и не зависит от живого dev-стека соседей.
 */
export default defineConfig({
  testDir: './tests',
  timeout: 90_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  use: {
    baseURL: `http://localhost:${FRONTEND_PORT}`,
    headless: true,
    screenshot: 'only-on-failure',
  },
  webServer: [
    {
      command: 'npm run start:e2e --workspace @issue-resolver/backend',
      cwd: '..',
      url: `http://localhost:${BACKEND_PORT}/ping`,
      reuseExistingServer: true,
      timeout: 120_000,
      env: { PORT: String(BACKEND_PORT), E2E_BOOTSTRAP_HOLD_MS: '800' },
    },
    {
      command: `npm run dev --workspace @issue-resolver/frontend -- --host 0.0.0.0 --port ${FRONTEND_PORT}`,
      cwd: '..',
      url: `http://localhost:${FRONTEND_PORT}`,
      reuseExistingServer: true,
      timeout: 120_000,
      env: { VITE_PROXY_TARGET: `http://localhost:${BACKEND_PORT}` },
    },
  ],
});