import { expect, test, type Page } from '@playwright/test';
import type { ToolDescription } from '../../src/contracts/tool.js';

async function openTool(page: Page, name: string) {
  await page.goto(`/#/tools/${name}`);
  await expect(page.getByRole('button', { name: '运行工具', exact: true })).toBeVisible();
}

async function runTool(page: Page) {
  await page.getByRole('button', { name: '运行工具', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: '执行成功' })).toBeVisible();
}

test('catalog reflects the API and supports search, categories and an empty state', async ({ page, request }) => {
  const response = await request.get('/api/tools');
  expect(response.ok()).toBeTruthy();
  const tools = await response.json() as ToolDescription[];
  expect(tools).toHaveLength(12);
  await page.goto('/#/tools');
  await expect(page.getByTestId('tool-card')).toHaveCount(tools.length);
  for (const tool of tools) {
    await expect(page.getByRole('heading', { name: tool.title, exact: true })).toBeVisible();
  }
  await page.getByRole('searchbox', { name: '搜索工具' }).fill('csv_summary');
  await expect(page.getByTestId('tool-card')).toHaveCount(1);
  await page.getByRole('searchbox', { name: '搜索工具' }).fill('找不到的工具 xyz987');
  await expect(page.getByText('没有找到匹配的工具')).toBeVisible();
  await page.getByRole('button', { name: '清除筛选' }).click();
  await page.getByRole('group', { name: '按分类筛选' }).getByRole('button', { name: /数据处理/ }).click();
  await expect(page.getByTestId('tool-card')).toHaveCount(tools.filter(tool => tool.category === 'data').length);
});

test('golden CSV shows sum 20, a preview and downloads the actual result', async ({ page }) => {
  await openTool(page, 'csv_summary');
  await page.getByRole('button', { name: /填入示例/ }).first().click();
  await expect(page.locator('[name="path"]')).toHaveValue('samples/sales.csv');
  const completed = page.waitForResponse(response => response.url().endsWith('/api/tools/csv_summary/run'));
  await runTool(page);
  const actual = await (await completed).json();
  const amount = page.getByRole('table', { name: '数值摘要' }).getByRole('row').filter({ hasText: 'amount' });
  await expect(amount.getByRole('cell', { name: '20', exact: true })).toBeVisible();
  await expect(page.getByRole('table', { name: '数据预览' })).toBeVisible();
  const downloadEvent = page.waitForEvent('download');
  await page.getByRole('button', { name: '下载 JSON' }).click();
  const download = await downloadEvent;
  expect(download.suggestedFilename()).toMatch(/^csv_summary-.+\.json$/);
  const stream = await download.createReadStream();
  if (!stream) throw new Error('Download did not produce a stream');
  let contents = '';
  for await (const chunk of stream) contents += chunk.toString();
  expect(JSON.parse(contents)).toEqual(actual);
  await page.getByRole('button', { name: 'JSON 视图', exact: true }).click();
  await expect(page.getByTestId('result-json')).toContainText(actual.meta.runId);
});

test('missing file preserves the input and exposes the server error code with retry', async ({ page }) => {
  await openTool(page, 'csv_summary');
  await page.locator('[name="path"]').fill('samples/does-not-exist-e2e.csv');
  await page.getByRole('button', { name: '运行工具', exact: true }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'FILE_NOT_FOUND' })).toBeVisible();
  await expect(page.locator('[name="path"]')).toHaveValue('samples/does-not-exist-e2e.csv');
  await page.locator('[name="path"]').fill('samples/sales.csv');
  await page.getByRole('button', { name: '重试运行', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: '执行成功' })).toBeVisible();
});

test('Unicode statistics show code points instead of UTF-16 units', async ({ page }) => {
  await openTool(page, 'text_stats');
  await page.locator('[name="text"]').fill('Hello 世界\n第二行');
  await runTool(page);
  await expect(page.getByTestId('metric-characters')).toContainText('12');
  await expect(page.getByTestId('metric-charactersWithoutWhitespace')).toContainText('10');
  await expect(page.getByTestId('metric-hanCharacters')).toContainText('5');
  await page.locator('[name="text"]').fill('A\u{1F600}中\n');
  await runTool(page);
  await expect(page.getByTestId('metric-characters')).toContainText('4');
  await expect(page.getByTestId('metric-lines')).toContainText('2');
});

test('hash navigation and browser back preserve real pages and summary-only history', async ({ page }) => {
  await openTool(page, 'text_stats');
  await page.locator('[name="text"]').fill('History check');
  await runTool(page);
  await page.getByRole('navigation', { name: '主导航' }).getByRole('link', { name: '执行记录' }).click();
  await expect(page.getByRole('heading', { name: '执行记录', exact: true })).toBeVisible();
  await expect(page.getByRole('table', { name: '运行摘要' })).toContainText('text_stats');
  await expect(page.getByRole('button', { name: /重新运行|再次运行/ })).toHaveCount(0);
  await page.getByRole('navigation', { name: '主导航' }).getByRole('link', { name: 'AI 接入' }).click();
  await expect(page.getByRole('heading', { name: 'AI 接入', exact: true })).toBeVisible();
  await page.goBack();
  await expect(page.getByRole('heading', { name: '执行记录', exact: true })).toBeVisible();
});

test('integrations display literal API config, CLI help and unverified client state', async ({ page, request }) => {
  const response = await request.get('/api/integrations');
  const info = await response.json();
  await page.goto('/#/integrations');
  await expect(page.getByTestId('mcp-config')).toHaveText(JSON.stringify(info.mcp.config, null, 2));
  await expect(page.getByText('客户端连接尚未验证')).toBeVisible();
  for (const command of info.cli) await expect(page.getByTestId('cli-commands')).toContainText(command);
  await page.getByRole('button', { name: '复制 MCP 配置' }).click();
  await expect(page.getByText(/已复制到剪贴板|请手动复制/)).toBeVisible();
});

test('API transport failures offer a working retry', async ({ page }) => {
  await page.route('**/api/tools', route => route.abort('failed'));
  await page.goto('/#/tools');
  await expect(page.getByRole('alert')).toContainText('无法连接本地服务');
  await page.unroute('**/api/tools');
  await page.getByRole('button', { name: '重试加载' }).click();
  await expect(page.getByTestId('tool-card')).toHaveCount(12);
});

for (const width of [375, 1440]) {
  test(`workbench remains usable without page overflow at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/#/tools');
    await expect(page.getByTestId('tool-card')).toHaveCount(12);
    await page.getByRole('navigation', { name: '主导航' }).getByRole('link', { name: 'AI 接入' }).click();
    await expect(page.getByTestId('mcp-config')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy();
    await openTool(page, 'csv_summary');
    await page.getByRole('button', { name: /填入示例/ }).first().click();
    await runTool(page);
    await expect(page.getByRole('table', { name: '数值摘要' })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy();
  });
}

test('media and document tools join the catalog and photo compression runs in the browser', async ({ page }) => {
  await page.goto('/#/tools');
  await expect(page.getByTestId('tool-card')).toHaveCount(12);
  await page.getByRole('group', { name: '按分类筛选' }).getByRole('button', { name: '影音处理' }).click();
  await expect(page.getByTestId('tool-card')).toHaveCount(4);
  await openTool(page, 'photo_compress');
  await page.locator('[name="path"]').fill('samples/photo.jpg');
  await runTool(page);
  await expect(page.locator('.result-body')).toContainText('压缩后体积');
  await expect(page.getByRole('button', { name: '打开输出文件夹' })).toBeVisible();
  await openTool(page, 'doc_convert');
  await page.locator('[name="path"]').fill('samples/guide.pdf');
  await page.locator('[name="to"]').selectOption('markdown');
  await runTool(page);
  await expect(page.locator('.result-body')).toContainText('Personal Workstation Guide');
});

test('the catalog shows the new table tool and long runs report progress', async ({ page }) => {
  await page.goto('/#/tools');
  await expect(page.getByTestId('tool-card')).toHaveCount(12);
  await page.getByRole('searchbox', { name: '搜索工具' }).fill('表格分析');
  await expect(page.getByTestId('tool-card')).toHaveCount(1);
  await openTool(page, 'pdf_extract');
  await page.locator('[name="path"]').fill('samples/guide.pdf');
  await page.getByRole('button', { name: '运行工具', exact: true }).click();
  await expect(page.locator('.progress-view')).toBeVisible({ timeout: 15000 });
  await expect(page.getByRole('status').filter({ hasText: '执行成功' })).toBeVisible({ timeout: 30000 });
});

test('switching pages keeps the running task alive and its progress visible', async ({ page }) => {
  await openTool(page, 'pdf_extract');
  await page.locator('[name="path"]').fill('samples/guide.pdf');
  await page.getByRole('button', { name: '运行工具', exact: true }).click();
  await expect(page.locator('.progress-view')).toBeVisible({ timeout: 15000 });
  await page.getByRole('navigation', { name: '主导航' }).getByRole('link', { name: 'AI 接入' }).click();
  await expect(page.getByRole('heading', { name: 'AI 接入', exact: true })).toBeVisible();
  await expect(page.locator('.running-task')).toBeVisible();
  await page.getByRole('navigation', { name: '主导航' }).getByRole('link', { name: '工具箱' }).click();
  await expect(page.getByTestId('tool-card').first()).toBeVisible();
  await openTool(page, 'pdf_extract');
  await expect(page.getByRole('status').filter({ hasText: '执行成功' })).toBeVisible({ timeout: 30000 });
  await expect(page.locator('.result-body')).toContainText('Personal Workstation Guide');
});

test('closing the tab keeps the run on the server and the result can be picked up again', async ({ page }) => {
  await openTool(page, 'pdf_extract');
  await page.locator('[name="path"]').fill('samples/guide.pdf');
  await page.getByRole('button', { name: '运行工具', exact: true }).click();
  await expect(page.locator('.progress-view')).toBeVisible({ timeout: 15000 });
  await page.goto('about:blank');
  await page.goto('/#/tools/pdf_extract');
  await expect(page.getByRole('status').filter({ hasText: '执行成功' })).toBeVisible({ timeout: 30000 });
  await expect(page.locator('.result-body')).toContainText('Personal Workstation Guide');
});

test('PDF, environment and file preview execute without browser errors', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  page.on('requestfailed', request => { if (!request.url().includes('/events')) errors.push(`${request.method()} ${request.url()}`); });
  await openTool(page, 'pdf_extract');
  await page.locator('[name="path"]').fill('samples/guide.pdf');
  await runTool(page);
  await expect(page.getByRole('heading', { name: '第 1 页', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: '第 2 页', exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('heading', { name: '准备好了，运行看看' })).toBeVisible();
  await openTool(page, 'env_inspect');
  await runTool(page);
  await expect(page.locator('.result-body')).toContainText(process.platform);
  await expect(page.locator('.result-body')).toContainText(process.version);
  await openTool(page, 'files_plan');
  await page.locator('[name="directory"]').fill('inbox');
  await runTool(page);
  await expect(page.getByRole('table', { name: '文件整理计划' })).toContainText('会议记录.txt');
  await expect(page.getByText('这是整理建议，未移动或修改任何文件。')).toBeVisible();
  expect(errors).toEqual([]);
});

test('keyboard navigation and long text keep the workbench usable', async ({ page }) => {
  await page.goto('/#/tools');
  await expect(page.getByTestId('tool-card')).toHaveCount(12);
  await page.keyboard.press('Tab');
  await expect(page.getByRole('link', { name: '跳至主要内容' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('main')).toBeFocused();
  await page.getByRole('navigation', { name: '主导航' }).getByRole('link', { name: 'AI 接入' }).click();
  await expect(page.getByRole('main')).toBeFocused();
  await openTool(page, 'text_stats');
  await page.setViewportSize({ width: 375, height: 900 });
  await page.locator('[name="text"]').fill('中'.repeat(100000));
  await runTool(page);
  await expect(page.getByTestId('metric-characters')).toContainText('100,000');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy();
  await page.locator('[name="text"]').fill(' ');
  await page.getByRole('button', { name: '运行工具', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('INVALID_INPUT');
});
