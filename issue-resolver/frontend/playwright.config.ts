import { defineConfig } from '@playwright/test';

/** Порт выделенного мок-бэкенда (e2e-server) и vite-фронта. */
const BACKEND_PORT = Number(process.env.E2E_BACKEND_PORT ?? 8095);
const FRONTEND_PORT = Number(process.env.E2E_FRONTEND_PORT ?? 5195);

/**
 * Playwright-конфиг frontend e2e-сценариев (`frontend/e2e/`).
 *
 * Поднимает СВОЙ стек на свободных портах: e2e-сервер
 * (`backend/test/e2e-server.ts` — реальные роуты/движок поверх мок-агента,
 * без Docker/git/pi/сети) и vite, проксирующий `/issue-resolver` на него.
 * Отдельные порты (8095/5195) не конфликтуют с живым dev-стеком соседей
 * (:8080/:5173), поэтому прогон детерминирован и не тратит токены.
 */
process.env.E2E_API_ORIGIN ??= `http://localhost:${BACKEND_PORT}`;

export default defineConfig({
  testDir: './e2e',
  timeout: 90_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  use: {
    baseURL: `http://localhost:${FRONTEND_PORT}`,
    headless: true,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
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