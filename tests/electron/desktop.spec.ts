import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { expect, test } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

let app: ElectronApplication;
let page: Page;

test.beforeAll(async () => {
  app = await electron.launch({ args: [root] });
  page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
});

test.afterAll(async () => {
  await app?.close();
});

test('the desktop shell renders the workbench instead of a blank window', async () => {
  await expect(page.locator('#root')).not.toBeEmpty();
  await expect(page.locator('h1').first()).toBeVisible();
  expect(page.url()).toContain('127.0.0.1:4318');
});

test('closing the window hides it but keeps the app and the service alive', async () => {
  const before = await app.windows().length;
  expect(before).toBeGreaterThan(0);
  await app.evaluate(({ BrowserWindow }) => {
    for (const window of BrowserWindow.getAllWindows()) window.close();
  });
  await new Promise(resolve => setTimeout(resolve, 1200));
  const serviceAlive = await app.evaluate(async () => {
    const response = await fetch('http://127.0.0.1:4318/api/health');
    return response.ok;
  });
  expect(serviceAlive).toBe(true);
});

test('the tray exists and offers the expected entries', async () => {
  await expect.poll(async () => app.evaluate(() => Boolean((globalThis as unknown as { __henryTray?: unknown }).__henryTray))).toBe(true);
  const tray = await app.evaluate(() => {
    const handle = (globalThis as unknown as { __henryTray?: { exists(): boolean; menuLabels(): string[] } }).__henryTray;
    return { exists: handle?.exists() ?? false, labels: handle?.menuLabels() ?? [] };
  });
  expect(tray.exists).toBe(true);
  expect(tray.labels).toEqual(expect.arrayContaining(['打开工作台', '打开输出文件夹', '开机自动启动', '退出']));
});

test('the autostart switch reflects the login item state', async () => {
  const settings = await app.evaluate(({ app: electronApp }) => electronApp.getLoginItemSettings());
  expect(settings).toHaveProperty('openAtLogin');
  expect(typeof settings.openAtLogin).toBe('boolean');
});
