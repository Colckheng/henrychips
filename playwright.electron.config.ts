import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests/electron',
  timeout: 60000,
  expect: { timeout: 15000 },
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
});
