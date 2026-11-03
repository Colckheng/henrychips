import { app, BrowserWindow, Menu, Tray, shell, nativeImage } from 'electron';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const iconPath = path.join(root, 'build/icon.png');
// The service and the web assets live next to this file. In a packaged build
// that is inside app.asar, where the same relative paths still resolve.
const assetRoot = root;
const serviceEntry = path.join(assetRoot, 'dist/server/adapters/http/server.js');

let window = null;
let tray = null;
let server = null;
let quitting = false;

function userConfigPath() {
  return path.join(app.getPath('userData'), 'workstation.config.json');
}

function readUserConfig() {
  try { return JSON.parse(readFileSync(userConfigPath(), 'utf8')); }
  catch { return null; }
}

function defaultConfig() {
  return {
    workspaceRoot: path.join(app.getPath('userData'), 'sandbox'),
    stateDirectory: path.join(app.getPath('userData'), 'state'),
    outputDirectory: path.join(app.getPath('userData'), 'sandbox', 'downloads'),
    http: { host: '127.0.0.1', port: 4318 },
    network: { enabled: true },
    limits: {
      fileBytes: 10485760, csvRows: 10000, directoryEntries: 1000, pdfPages: 30,
      webBytes: 2097152, downloadBytes: 209715200, outputBytes: 209715200, toolTimeoutMs: 15000,
    },
  };
}

/** The config lives beside the app data so an installed copy keeps its own state. */
function ensureConfig() {
  const existing = readUserConfig();
  if (existing) return existing;
  const config = defaultConfig();
  mkdirSync(config.workspaceRoot, { recursive: true });
  mkdirSync(config.outputDirectory, { recursive: true });
  mkdirSync(config.stateDirectory, { recursive: true });
  writeFileSync(userConfigPath(), JSON.stringify(config, null, 2));
  return config;
}

function serviceOrigin(config) {
  return `http://${config.http.host}:${config.http.port}/`;
}

function serviceHealthy(url) {
  return new Promise(resolve => {
    const request = http.get(`${url}api/health`, response => {
      response.resume();
      resolve(response.statusCode === 200);
    });
    request.on('error', () => resolve(false));
    request.setTimeout(1500, () => { request.destroy(); resolve(false); });
  });
}

async function waitForService(url, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await serviceHealthy(url)) return true;
    await new Promise(resolve => setTimeout(resolve, 300));
  }
  return false;
}

/**
 * Runs the workstation service inside this process. Electron's Node runtime
 * supports node:sqlite and the sharp binary, so a packaged build needs no
 * separate Node installation.
 */
async function startService(config) {
  if (!existsSync(serviceEntry)) {
    process.stderr.write('未找到构建产物，请先运行 npm run build。\n');
    return;
  }
  const { loadConfig } = await import(pathToFileURL(path.join(assetRoot, 'dist/server/core/config.js')).href);
  const { buildApp } = await import(pathToFileURL(path.join(assetRoot, 'dist/server/adapters/http/app.js')).href);
  const loaded = await loadConfig(userConfigPath());
  server = await buildApp(loaded, { assetRoot });
  await server.listen(loaded.http);
  process.stderr.write(`个人工作站已启动：http://${loaded.http.host}:${loaded.http.port}\n`);
}

function createWindow(url) {
  window = new BrowserWindow({
    width: 1360,
    height: 900,
    minWidth: 960,
    minHeight: 640,
    show: false,
    backgroundColor: '#f7f8f3',
    title: 'Henry 工作站',
    icon: existsSync(iconPath) ? iconPath : undefined,
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  window.loadURL(url);
  window.once('ready-to-show', () => { if (window) window.show(); });
  window.webContents.on('did-fail-load', (_event, errorCode, errorDescription) => {
    process.stderr.write(`工作台加载失败（${errorCode} ${errorDescription}），稍后重试。\n`);
    setTimeout(() => { if (window && !window.isDestroyed()) window.loadURL(url); }, 2000);
  });
  window.on('close', event => {
    // Closing the window keeps the workstation running in the tray.
    if (!quitting) { event.preventDefault(); if (window) window.hide(); }
  });
  window.webContents.setWindowOpenHandler(({ url: target }) => {
    shell.openExternal(target);
    return { action: 'deny' };
  });
}

function createTray(outputDirectory) {
  const icon = existsSync(iconPath) ? nativeImage.createFromPath(iconPath) : nativeImage.createEmpty();
  tray = new Tray(icon);
  tray.setToolTip('Henry 工作站');
  const menu = Menu.buildFromTemplate([
    { label: '打开工作台', click: () => { if (window) { window.show(); window.focus(); } } },
    { label: '打开输出文件夹', click: () => { shell.openPath(outputDirectory); } },
    { type: 'separator' },
    {
      label: '开机自动启动',
      type: 'checkbox',
      checked: app.getLoginItemSettings().openAtLogin,
      click: item => { app.setLoginItemSettings({ openAtLogin: item.checked }); },
    },
    { type: 'separator' },
    { label: '退出', click: () => { quitting = true; app.quit(); } },
  ]);
  tray.setContextMenu(menu);
  tray.on('click', () => { if (window) { window.show(); window.focus(); } });
  // Electron has no Tray.getAll(), so the shell keeps its own handle for checks.
  globalThis.__henryTray = { exists: () => Boolean(tray) && !tray.isDestroyed(), menuLabels: () => menu.items.map(item => item.label).filter(Boolean) };
}

app.whenReady().then(async () => {
  const config = ensureConfig();
  const url = serviceOrigin(config);
  createTray();
  // Reuse an already running service so a second launch does not fight for the port.
  if (!(await serviceHealthy(url))) {
    try { await startService(config); }
    catch (error) {
      process.stderr.write(`${error instanceof Error ? error.message : '本地服务启动失败。'}\n`);
      app.exit(1);
    }
  }
  // The window must not load before the service binds the port, or it renders blank.
  if (!(await waitForService(url))) process.stderr.write('本地服务未能在预期时间内就绪，窗口可能无法加载。\n');
  createWindow(url);
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(url); });
});

app.on('window-all-closed', () => {
  // Stay resident in the tray so other devices can reach the workstation.
});

app.on('before-quit', () => {
  quitting = true;
  if (server) void server.close();
});
