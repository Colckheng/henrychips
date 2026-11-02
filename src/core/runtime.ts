import type { WorkstationConfig } from './config.js';
import { ToolExecutor } from './executor.js';
import { RunStore } from './run-store.js';
import { createRegistry } from '../tools/index.js';
import { createPublicHttp } from './public-http.js';
import { createProcessProbe } from './process-probe.js';

export function createRuntime(config: WorkstationConfig) {
  const registry = createRegistry();
  const store = new RunStore(config.stateDirectory);
  const executor = new ToolExecutor(registry, config, store, { http: createPublicHttp(config.limits.webBytes), probes: createProcessProbe() });
  return { registry, store, executor };
}
export type Runtime = ReturnType<typeof createRuntime>;
