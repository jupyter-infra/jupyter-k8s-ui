import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false, // CRUD tests are sequential — they share workspace state
  retries: 0,
  workers: 1,
  reporter: [['html', { open: 'never' }], ['list']],
  timeout: 60_000, // 1 minute per test
  expect: {
    timeout: 30_000, // 30s for assertions that wait for K8s state
  },
  use: {
    baseURL: process.env.E2E_BASE_URL || 'http://localhost:8090',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { browserName: 'chromium' },
    },
  ],
});
