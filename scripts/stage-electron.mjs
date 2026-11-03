import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.join(root, 'node_modules', 'electron', 'dist');
const target = path.join(root, 'el-stage');

if (!existsSync(source)) {
  process.stderr.write('未找到 Electron 运行文件，请先运行 npm install。\n');
  process.exit(1);
}

rmSync(target, { recursive: true, force: true });
mkdirSync(target, { recursive: true });

/**
 * Copies the Electron runtime without `resources/default_app.asar`. On Windows
 * that file stays locked after the archive is unpacked, and the installer
 * cannot replace it, so the packaged app simply never ships it.
 */
function copy(sourceDirectory, targetDirectory) {
  for (const entry of readdirSync(sourceDirectory)) {
    if (entry === 'default_app.asar') continue;
    const from = path.join(sourceDirectory, entry);
    const to = path.join(targetDirectory, entry);
    if (statSync(from).isDirectory()) {
      mkdirSync(to, { recursive: true });
      copy(from, to);
    } else {
      cpSync(from, to);
    }
  }
}

copy(source, target);
process.stdout.write(`已准备 Electron 运行文件：${target}\n`);
