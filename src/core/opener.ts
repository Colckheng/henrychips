import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

/**
 * Opens a directory in the operating system file manager. Only the configured
 * output directory may be opened; no arbitrary path is accepted from callers.
 */
export function openDirectory(directory: string): { opened: boolean; reason?: string } {
  const target = path.resolve(directory);
  if (!existsSync(target)) return { opened: false, reason: '输出目录不存在。' };
  const platform = process.platform;
  const command = platform === 'win32' ? 'explorer.exe' : platform === 'darwin' ? 'open' : 'xdg-open';
  try {
    const child = spawn(command, [target], { detached: true, stdio: 'ignore', windowsHide: true });
    child.on('error', () => { /* the desktop may not have a file manager */ });
    child.unref();
    return { opened: true };
  } catch {
    return { opened: false, reason: '无法调用系统文件管理器。' };
  }
}
