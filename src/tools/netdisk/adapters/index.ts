import type { NetdiskAdapter, NetdiskPlatform } from '../types.js';
import { guangyaAdapter } from './guangya.js';
import { lanzouAdapter } from './lanzou.js';
import { pan115Adapter } from './pan115.js';
import { quarkAdapter } from './quark.js';
import { ucAdapter } from './uc.js';

// Every adapter of the feature is registered here; the other platforms are
// added by the tasks that implement them.
const adapters: NetdiskAdapter[] = [lanzouAdapter, guangyaAdapter, quarkAdapter, ucAdapter, pan115Adapter];

export const adaptersByPlatform = new Map<NetdiskPlatform, NetdiskAdapter>(
  adapters.map(adapter => [adapter.platform, adapter] as const),
);
