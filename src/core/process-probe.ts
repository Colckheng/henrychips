import childProcess from 'node:child_process';
import type { EnvironmentReport, ProcessProbe } from '../contracts/tool.js';
import { ToolError } from './errors.js';

export function createProcessProbe(): ProcessProbe {
  return {
    async inspect(signal) {
      if (signal.aborted) throw new ToolError('CANCELLED', '环境检查已取消。');
      const git = await new Promise<EnvironmentReport['git']>((resolve, reject) => {
        childProcess.execFile('git', ['--version'], {
          shell: false, timeout: 3000, signal, windowsHide: true, encoding: 'utf8', maxBuffer: 4096,
        }, (error, stdout) => {
          if (signal.aborted) { reject(new ToolError('CANCELLED', '环境检查已取消。')); return; }
          // Accept the fixed version line only, never executable paths, stderr,
          // environment variables, or arbitrary output from a failed process.
          const version = stdout.trim();
          if (error || !/^git version \d+\.\d+(?:\.\d+)?(?:[.\w+-]*)(?: \([\w .+-]+\))?$/.test(version)) {
            resolve({ available: false, version: null });
          } else resolve({ available: true, version });
        });
      });
      if (signal.aborted) throw new ToolError('CANCELLED', '环境检查已取消。');
      return {
        platform: process.platform, architecture: process.arch,
        node: { available: true, version: process.version }, git,
      };
    },
  };
}
