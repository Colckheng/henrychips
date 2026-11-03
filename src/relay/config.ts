import { z } from 'zod';

/** Relay configuration. Stored separately from the workstation config. */
export const relayConfigSchema = z.strictObject({
  /** Public address other devices use to reach this relay. */
  address: z.string().min(1),
  port: z.number().int().positive().max(65535),
  /** Shared secret that devices present when registering. */
  pairCode: z.string().min(6).max(64),
  /** Where the relay keeps its database. */
  dataDirectory: z.string().min(1),
  /** Optional bearer token required from every device. */
  deviceToken: z.string().min(8).max(256).optional(),
});

export type RelayConfig = z.infer<typeof relayConfigSchema>;
