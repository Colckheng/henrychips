import type { ErrorCode } from '../contracts/run.js';

export class ToolError extends Error {
  constructor(public readonly code: ErrorCode, message: string, public readonly details?: Array<{ path: string; message: string }>) {
    super(message);
    this.name = 'ToolError';
  }
}

export function fileError(error: unknown): never {
  if (error instanceof ToolError) throw error;
  const code = (error as NodeJS.ErrnoException)?.code;
  if (code === 'ENOENT') throw new ToolError('FILE_NOT_FOUND', '找不到指定的文件或目录。');
  if (code === 'EACCES' || code === 'EPERM') throw new ToolError('ACCESS_DENIED', '没有权限读取指定的文件或目录。');
  if (code === 'EISDIR' || code === 'ENOTDIR') throw new ToolError('INVALID_INPUT', '文件或目录类型与操作不符。');
  throw error;
}
