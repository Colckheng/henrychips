import type { WorkstationConfig } from './config.js';
import { ToolExecutor } from './executor.js';
import { RunStore } from './run-store.js';
import { createRegistry } from '../tools/index.js';
import { createPublicHttp } from './public-http.js';
import { createProcessProbe } from './process-probe.js';
import { DownloadManager } from './download/manager.js';
import { ToolError } from './errors.js';
import { NetdiskSession } from '../tools/netdisk/session.js';
import { adaptersByPlatform } from '../tools/netdisk/adapters/index.js';
import { resolveCredential } from '../tools/netdisk/credentials.js';
import type { NetdiskFile } from '../tools/netdisk/types.js';

export function createRuntime(config: WorkstationConfig) {
  const registry = createRegistry();
  const store = new RunStore(config.stateDirectory);
  const http = createPublicHttp(config.limits.webBytes);
  // The manager lives outside the executor, because a download takes far
  // longer than one run of a tool and must not be bound by the concurrency of
  // the tools.
  const downloads = new DownloadManager({
    http,
    stateDirectory: config.stateDirectory,
    outputDirectory: config.outputDirectory,
    outputBytesLimit: config.limits.outputBytes,
    // A direct link expires within minutes, so a long download needs a new
    // one. The task knows the share it came from, so the adapter of the
    // platform can hand out a new link.
    refreshLink: async task => {
      const adapter = adaptersByPlatform.get(task.platform);
      if (!adapter) throw new ToolError('TOOL_FAILED', '该平台没有可用的适配器，无法重新取链。');
      const signal = new AbortController().signal;
      const session = new NetdiskSession({ http, signal });
      const context = {
        session,
        shareId: task.source.shareUrl,
        shareUrl: task.source.shareUrl,
        code: task.source.code,
        credential: resolveCredential(task.platform, config.stateDirectory),
        signal,
        reportProgress: () => {},
      };
      const file: NetdiskFile = {
        id: task.source.fileId,
        path: task.source.filePath,
        name: task.fileName,
        sizeBytes: task.sizeBytes,
        isDirectory: false,
      };
      return adapter.link(context, file);
    },
  });
  const executor = new ToolExecutor(registry, config, store, { http, probes: createProcessProbe() });
  return { registry, store, executor, downloads };
}
export type Runtime = ReturnType<typeof createRuntime>;
