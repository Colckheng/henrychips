import type { NetdiskAdapter, NetdiskPlatform } from '../types.js';
import { lanzouAdapter } from './lanzou.js';

// Every adapter of the feature is registered here; the other platforms are
// added by the tasks that implement them.
const adapters: NetdiskAdapter[] = [lanzouAdapter];

export const adaptersByPlatform = new Map<NetdiskPlatform, NetdiskAdapter>(
  adapters.map(adapter => [adapter.platform, adapter] as const),
);
