import { open, opendir, realpath, lstat, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { FileAccess, FileEntry, FileWriter } from '../contracts/tool.js';
import { ToolError, fileError } from './errors.js';

export function createFileAccess(root: string, signal: AbortSignal): FileAccess {
  function within(candidate: string) {
    const rel = path.relative(root, candidate);
    if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
      throw new ToolError('ACCESS_DENIED', '只允许访问工作区内的文件。');
    }
  }
  function candidate(relative: string) {
    signal.throwIfAborted();
    if (!relative || /[:\u0000]/.test(relative) || path.win32.isAbsolute(relative) || path.posix.isAbsolute(relative)) {
      throw new ToolError('ACCESS_DENIED', '请使用工作区内的相对路径。');
    }
    const segments = relative.replaceAll('\\', '/').split('/');
    if (segments.some(s => /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(s) || /[. ]$/.test(s) && s !== '.' && s !== '..')) {
      throw new ToolError('ACCESS_DENIED', '不支持设备路径或特殊文件路径。');
    }
    const absolute = path.resolve(root, ...segments);
    within(absolute);
    return absolute;
  }
  async function resolve(relative: string) {
    try {
      const resolved = await realpath(candidate(relative));
      within(resolved);
      return resolved;
    } catch (error) { return fileError(error); }
  }
  async function readBytes(relative: string, maxBytes: number) {
    const filename = await resolve(relative);
    try {
      const handle = await open(filename, 'r');
      try {
        const info = await handle.stat();
        if (!info.isFile()) throw new ToolError('INVALID_INPUT', '请选择普通文件。');
        if (info.size > maxBytes) throw new ToolError('LIMIT_EXCEEDED', '文件超过本次读取大小限制。');
        const chunks: Uint8Array[] = [];
        let total = 0;
        while (true) {
          signal.throwIfAborted();
          const buffer = Buffer.alloc(Math.min(65536, maxBytes + 1 - total));
          const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
          if (!bytesRead) break;
          total += bytesRead;
          if (total > maxBytes) throw new ToolError('LIMIT_EXCEEDED', '文件超过本次读取大小限制。');
          chunks.push(buffer.subarray(0, bytesRead));
        }
        signal.throwIfAborted();
        return Buffer.concat(chunks);
      } finally { await handle.close(); }
    } catch (error) { return fileError(error); }
  }
  return {
    readBytes,
    async readText(relative, maxBytes) {
      const bytes = await readBytes(relative, maxBytes);
      try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
      catch { throw new ToolError('UNSUPPORTED_FORMAT', '请选择 UTF-8 编码的文本文件。'); }
    },
    async exists(relative) {
      try { await resolve(relative); return true; }
      catch (error) { if (error instanceof ToolError && error.code === 'FILE_NOT_FOUND') return false; throw error; }
    },
    async list(relative, maxEntries) {
      const directory = await resolve(relative);
      try {
        const entries: FileEntry[] = [];
        for await (const entry of await opendir(directory)) {
          signal.throwIfAborted();
          if (entries.length >= maxEntries) throw new ToolError('LIMIT_EXCEEDED', '目录条目超过处理上限。');
          const relativePath = path.posix.join(relative.replaceAll('\\', '/'), entry.name);
          const info = await lstat(path.join(directory, entry.name));
          if (!info.isFile() && !info.isDirectory() && !info.isSymbolicLink()) continue;
          entries.push({ name: entry.name, relativePath, kind: info.isSymbolicLink() ? 'symlink' : info.isDirectory() ? 'directory' : 'file', sizeBytes: info.isFile() ? info.size : null });
        }
        return entries.sort((a, b) => a.name.localeCompare(b.name));
      } catch (error) { return fileError(error); }
    },
  };
}

export async function writeUniqueFile(writer: FileWriter, fileName: string, bytes: Uint8Array, options?: { overwrite?: boolean }): Promise<{ relativePath: string; bytes: number }> {
  const dot = fileName.lastIndexOf('.');
  const base = dot > 0 ? fileName.slice(0, dot) : fileName;
  const extension = dot > 0 ? fileName.slice(dot) : '';
  for (let index = 1; index <= 50; index++) {
    const candidate = index === 1 ? fileName : `${base}-${index}${extension}`;
    try { return await writer.write(candidate, bytes, options); }
    catch (error) {
      const isExisting = error instanceof ToolError && error.code === 'ACCESS_DENIED' && error.message.includes('已存在');
      if (!isExisting) throw error;
    }
  }
  throw new ToolError('ACCESS_DENIED', '输出目录中同名文件过多，请更换文件名。');
}

const unsafeSegment = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;

export function createFileWriter(root: string, signal: AbortSignal, maxBytes: number): FileWriter {
  function target(relativePath: string) {
    signal.throwIfAborted();
    if (!relativePath || /[:\u0000]/.test(relativePath) || path.win32.isAbsolute(relativePath) || path.posix.isAbsolute(relativePath)) {
      throw new ToolError('ACCESS_DENIED', '输出路径必须是输出目录内的相对路径。');
    }
    const segments = relativePath.replaceAll('\\', '/').split('/').filter(Boolean);
    if (!segments.length) throw new ToolError('ACCESS_DENIED', '输出路径必须位于输出目录内。');
    if (segments.some(segment => segment === '..')) throw new ToolError('ACCESS_DENIED', '输出路径必须位于输出目录内，不能包含上级目录。');
    if (segments.some(segment => segment === '.' || unsafeSegment.test(segment) || /[. ]$/.test(segment))) {
      throw new ToolError('ACCESS_DENIED', '输出路径包含不受支持的目录或文件名。');
    }
    const absolute = path.resolve(root, ...segments);
    const relative = path.relative(root, absolute);
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new ToolError('ACCESS_DENIED', '输出路径必须位于输出目录内。');
    return { absolute, relativePath: segments.join('/') };
  }
  return {
    async write(relativePath, bytes, options) {
      const { absolute, relativePath: safePath } = target(relativePath);
      if (!Number.isSafeInteger(bytes.byteLength) || bytes.byteLength < 0) throw new ToolError('INVALID_INPUT', '输出内容无效。');
      if (bytes.byteLength > maxBytes) throw new ToolError('LIMIT_EXCEEDED', '输出文件超过写入大小限制。');
      const directory = path.dirname(absolute);
      await mkdir(directory, { recursive: true });
      // A junction or symbolic link inside the output directory must not be able
      // to redirect the write outside of it.
      const realDirectory = await realpath(directory).catch(() => { throw new ToolError('ACCESS_DENIED', '输出目录不可用。'); });
      const realRelative = path.relative(root, realDirectory);
      if (realRelative.startsWith('..') || path.isAbsolute(realRelative)) throw new ToolError('ACCESS_DENIED', '输出路径必须位于输出目录内。');
      const existing = await lstat(absolute).catch(() => null);
      if (existing?.isSymbolicLink()) throw new ToolError('ACCESS_DENIED', '输出目标不能是符号链接或联接点。');
      if (existing && !options?.overwrite) throw new ToolError('ACCESS_DENIED', '输出目录中已存在同名文件，请更换名称或勾选覆盖。');
      try {
        await writeFile(absolute, bytes, { flag: options?.overwrite ? 'w' : 'wx', mode: 0o600 });
      } catch (error) {
        if ((error as { code?: string }).code === 'EEXIST') throw new ToolError('ACCESS_DENIED', '输出目录中已存在同名文件，请更换名称或勾选覆盖。');
        return fileError(error);
      }
      return { relativePath: safePath, bytes: bytes.byteLength };
    },
  };
}
