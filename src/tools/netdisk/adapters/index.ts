import type { NetdiskAdapter, NetdiskPlatform } from '../types.js';
import { c139Adapter } from './c139.js';
import { guangyaAdapter } from './guangya.js';
import { lanzouAdapter } from './lanzou.js';
import { pan115Adapter } from './pan115.js';
import { pan123Adapter } from './pan123.js';
import { quarkAdapter } from './quark.js';
import { ucAdapter } from './uc.js';
import { xunleiAdapter } from './xunlei.js';

// Every adapter of the feature is registered here; the other platforms are
// added by the tasks that implement them.
const adapters: NetdiskAdapter[] = [
  lanzouAdapter, guangyaAdapter, quarkAdapter, ucAdapter, pan115Adapter, c139Adapter, pan123Adapter, xunleiAdapter,
];

export const adaptersByPlatform = new Map<NetdiskPlatform, NetdiskAdapter>(
  adapters.map(adapter => [adapter.platform, adapter] as const),
);
