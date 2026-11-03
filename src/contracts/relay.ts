export interface RelayStatus {
  /** Whether this workstation is paired with a relay. */
  configured: boolean;
  /** Relay address, for example http://203.0.113.10:4319 */
  address: string | null;
  /** Device id the relay assigned to this workstation. */
  deviceId: string | null;
  deviceName: string | null;
  /** Whether the node connector is running. */
  connected: boolean;
  /** Devices the relay knows about, this node included. */
  devices: Array<{ id: string; name: string; online: boolean; lastSeen: number; tools: number }>;
  /** Recent runs across devices. */
  runs: Array<{ id: string; deviceId: string; deviceName: string; tool: string; status: string; startedAt: number }>;
  /** Instructions an AI can follow to use the relay. */
  aiUsage: string;
}
