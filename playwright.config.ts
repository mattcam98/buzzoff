import { defineConfig } from '@playwright/test';

const PORT = Number(process.env.E2E_PORT ?? 3219);

/**
 * End-to-end tests drive real browsers against the production build:
 * `npm run build` first, then `npm run test:e2e`.
 */
export default defineConfig({
  testDir: 'e2e',
  outputDir: 'e2e/.artifacts/results',
  timeout: 120_000,
  expect: { timeout: 8_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: { baseURL: `http://localhost:${PORT}`, trace: 'retain-on-failure' },
  webServer: {
    // No DATABASE_URL: each run starts from an empty in-memory store with the starter pack.
    command: 'node apps/server/dist/index.js',
    env: { PORT: String(PORT), MEDIA_DIR: 'e2e/.artifacts/media', LOG_LEVEL: 'warn' },
    url: `http://localhost:${PORT}/api/health`,
    reuseExistingServer: !process.env.CI,
  },
});
