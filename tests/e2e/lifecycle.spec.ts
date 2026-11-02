import { expect, test } from '@playwright/test';
import type { ToolDescription } from '../../src/contracts/tool.js';

test('schema defaults and blank optional numbers produce the expected PDF payload', async ({ page, request }) => {
  const metadata = await (await request.get('/api/tools/pdf_extract')).json() as ToolDescription;
  const properties = metadata.inputSchema.properties as Record<string, { default?: unknown }>;
  await page.goto('/#/tools/pdf_extract');
  await expect(page.locator('[name="startPage"]')).toHaveValue(String(properties.startPage.default ?? ''));
  await page.locator('[name="path"]').fill('samples/guide.pdf');
  await page.locator('[name="endPage"]').fill('');
  const sent = page.waitForRequest(request => request.url().endsWith('/api/tools/pdf_extract/run'));
  await page.getByRole('button', { name: '运行工具', exact: true }).click();
  expect((await sent).postDataJSON()).toMatchObject({ input: { path: 'samples/guide.pdf', startPage: 1 } });
});

test('a late response from an earlier run cannot overwrite the current result', async ({ page }) => {
  let release!: () => void;
  let ready!: () => void;
  let delivered!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const fetched = new Promise<void>(resolve => { ready = resolve; });
  const lateResponse = new Promise<void>(resolve => { delivered = resolve; });
  let first = true;
  await page.route('**/api/tools/pdf_extract/run', async route => {
    if (!first) return route.continue();
    first = false;
    const response = await route.fetch();
    ready();
    await held;
    await route.fulfill({ response }).catch(() => undefined);
    delivered();
  });
  await page.goto('/#/tools/pdf_extract');
  await page.locator('[name="path"]').fill('samples/guide.pdf');
  await page.getByRole('button', { name: '运行工具', exact: true }).click();
  await fetched;
  await expect(page.getByRole('status').filter({ hasText: '执行成功' })).toBeVisible({ timeout: 30000 });
  const firstRunId = await page.locator('.result-meta code').innerText();
  expect(firstRunId.trim()).not.toBe('');
  await page.getByRole('button', { name: '运行工具', exact: true }).click();
  // Wait until the panel shows the newer run before reading its identifier.
  await expect(page.locator('.result-meta code')).not.toHaveText(firstRunId, { timeout: 30000 });
  const secondRunId = await page.locator('.result-meta code').innerText();
  release();
  await lateResponse;
  await expect(page.locator('.result-meta code')).toHaveText(secondRunId);
});

test('switching tools discards late responses from the previous tool', async ({ page }) => {
  let release!: () => void;
  let ready!: () => void;
  let delivered!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const fetched = new Promise<void>(resolve => { ready = resolve; });
  const lateResponse = new Promise<void>(resolve => { delivered = resolve; });
  await page.route('**/api/tools/text_stats/run', async route => {
    const response = await route.fetch();
    ready();
    await held;
    await route.fulfill({ response }).catch(() => undefined);
    delivered();
  });
  await page.goto('/#/tools/text_stats');
  await page.locator('[name="text"]').fill('Previous tool result');
  await page.getByRole('button', { name: '运行工具', exact: true }).click();
  await fetched;
  await page.evaluate(() => { window.location.hash = '#/tools/csv_summary'; });
  await expect(page.locator('[name="path"]')).toBeVisible();
  release();
  await lateResponse;
  await expect(page.getByTestId('metric-characters')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '运行工具', exact: true })).toBeEnabled();
});

test('failed clipboard access leaves the actual result available for manual copying', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: async () => { throw new Error('Clipboard denied'); } },
      configurable: true,
    });
  });
  await page.goto('/#/tools/text_stats');
  await page.locator('[name="text"]').fill('Copy me');
  const completed = page.waitForResponse(response => response.url().endsWith('/api/tools/text_stats/run'));
  await page.getByRole('button', { name: '运行工具', exact: true }).click();
  const actual = await (await completed).json();
  await page.getByRole('button', { name: '复制结果', exact: true }).click();
  await expect(page.getByRole('textbox', { name: '手动复制内容' })).toHaveValue(JSON.stringify(actual, null, 2));
});

test('required empty text is validated without inventing a successful result', async ({ page }) => {
  await page.goto('/#/tools/text_stats');
  await page.locator('[name="text"]').fill('');
  await page.getByRole('button', { name: '运行工具', exact: true }).click();
  await expect(page.locator('[name="text"]')).toBeFocused();
  await expect(page.getByRole('status').filter({ hasText: '执行成功' })).toHaveCount(0);
});
