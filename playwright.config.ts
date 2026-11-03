import { defineConfig, devices } from '@playwright/test';
export default defineConfig({
  testDir: './tests/e2e',
  timeout: 30000,
  expect: { timeout: 10000 },
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  use: { baseURL: 'http://127.0.0.1:4318', trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], channel: 'chrome' } }],
  // The suite must not run against a stale build. Reusing an already running
  // server would silently test the previous code.
  webServer: { command: 'npm run build && npm start', url: 'http://127.0.0.1:4318/api/health', reuseExistingServer: false, timeout: 60000 },
});
