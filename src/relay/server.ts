import { randomUUID, randomBytes, timingSafeEqual } from 'node:crypto';
import { type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { relayConfigSchema, type RelayConfig } from './config.js';
import { RelayStore } from './store.js';

interface NodeMessage {
  type: 'task' | 'progress' | 'result';
  id?: string;
  tool?: string;
  input?: unknown;
  status?: string;
  result?: unknown;
  error?: string;
  runId?: string;
  durationMs?: number;
  startedAt?: string;
}

interface WaitingNode {
  deviceId: string;
  name: string;
  identity: Record<string, unknown> | null;
  resolveTask: ((task: { id: string; tool: string; input: unknown } | null) => void) | null;
}

const startTaskSchema = z.strictObject({
  deviceId: z.string().min(1),
  tool: z.string().min(1),
  input: z.unknown(),
});

/**
 * Relay between devices. Phones and desktops talk only to this service, and
 * the workstation nodes keep an outbound connection, so the execution surface
 * never has to be exposed publicly.
 *
 * Transport is deliberately plain HTTP: nodes stream progress as newline
 * delimited JSON on a long lived request, and long poll for new tasks.
 */
export class RelayServer {
  private readonly store: RelayStore;
  private readonly nodes = new Map<string, WaitingNode>();
  private readonly waiters = new Map<string, { resolve: (task: { id: string; tool: string; input: unknown } | null) => void; timer: NodeJS.Timeout }>();

  constructor(private readonly config: RelayConfig) {
    this.store = new RelayStore(config.dataDirectory);
  }

  private authorize(request: IncomingMessage): boolean {
    if (!this.config.deviceToken) return true;
    const header = request.headers.authorization;
    if (typeof header !== 'string' || !header.startsWith('Bearer ')) return false;
    const provided = header.slice(7);
    const expected = this.config.deviceToken;
    if (provided.length !== expected.length) return false;
    return timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
  }

  private async readBody(request: IncomingMessage): Promise<unknown> {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    if (!chunks.length) return undefined;
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { throw new Error('请求内容不是有效 JSON。'); }
  }

  private json(response: ServerResponse, status: number, body: unknown): void {
    response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    response.end(JSON.stringify(body));
  }

  async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
    try {
      if (url.pathname === '/relay/health') { this.json(response, 200, { status: 'ok', nodes: this.nodes.size }); return; }
      if (!this.authorize(request)) { this.json(response, 401, { error: '设备令牌无效。' }); return; }

      if (url.pathname === '/relay/pair' && request.method === 'POST') {
        const body = await this.readBody(request) as { name?: string; code?: string };
        if (!body?.code || body.code !== this.config.pairCode) { this.json(response, 403, { error: '配对码不正确。' }); return; }
        const token = randomBytes(24).toString('base64url');
        const device = { id: randomUUID(), name: String(body?.name ?? '未命名设备').slice(0, 60), token, identity: null, lastSeen: Date.now(), createdAt: Date.now() };
        this.store.addDevice(device);
        this.json(response, 201, { deviceId: device.id, deviceToken: token, relay: this.config.address });
        return;
      }

      if (url.pathname === '/relay/devices' && request.method === 'GET') {
        this.json(response, 200, { devices: this.store.devices().map(device => ({ id: device.id, name: device.name, identity: device.identity ? JSON.parse(device.identity) : null, lastSeen: device.lastSeen, createdAt: device.createdAt, online: this.nodes.has(device.id) })) });
        return;
      }

      if (url.pathname === '/relay/tasks' && request.method === 'POST') {
        const parsed = startTaskSchema.safeParse(await this.readBody(request));
        if (!parsed.success) { this.json(response, 400, { error: '任务参数无效。' }); return; }
        const node = this.nodes.get(parsed.data.deviceId);
        if (!node) { this.json(response, 409, { error: '目标设备当前不在线。' }); return; }
        const taskId = randomUUID();
        this.store.addTask({ id: taskId, deviceId: parsed.data.deviceId, tool: parsed.data.tool, input: JSON.stringify(parsed.data.input), status: 'queued', result: null, error: null, runId: null, createdAt: Date.now(), updatedAt: Date.now() });
        const waiter = this.waiters.get(parsed.data.deviceId);
        if (waiter) {
          clearTimeout(waiter.timer);
          this.waiters.delete(parsed.data.deviceId);
          waiter.resolve({ id: taskId, tool: parsed.data.tool, input: parsed.data.input });
        }
        this.json(response, 202, { taskId, status: 'queued' });
        return;
      }

      if (url.pathname === '/relay/tasks' && request.method === 'GET') {
        this.json(response, 200, { tasks: this.store.tasks(url.searchParams.get('deviceId') ?? undefined) });
        return;
      }

      if (url.pathname === '/relay/runs' && request.method === 'GET') {
        this.json(response, 200, { runs: this.store.runs() });
        return;
      }

      if (url.pathname === '/relay/node/register' && request.method === 'POST') {
        await this.handleNodeRegister(request, response);
        return;
      }

      if (url.pathname === '/relay/node/poll' && request.method === 'GET') {
        await this.handleNodePoll(request, response);
        return;
      }

      if (url.pathname === '/relay/node/events' && request.method === 'POST') {
        await this.handleNodeEvents(request, response);
        return;
      }

      this.json(response, 404, { error: '接口不存在。' });
    } catch (error) {
      this.json(response, 500, { error: error instanceof Error ? error.message : '中继服务内部错误。' });
    }
  }

  private async handleNodeRegister(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const token = request.headers['x-node-token'];
    const deviceId = request.headers['x-device-id'];
    if (typeof token !== 'string' || typeof deviceId !== 'string') { this.json(response, 401, { error: '缺少节点令牌。' }); return; }
    const device = this.store.deviceByToken(token);
    if (!device || device.id !== deviceId) { this.json(response, 403, { error: '节点令牌无效。' }); return; }
    const identity = await this.readBody(request) as Record<string, unknown> | undefined;
    this.store.touchDevice(device.id, identity ? JSON.stringify(identity) : null);
    this.nodes.set(device.id, { deviceId: device.id, name: device.name, identity: identity ?? null, resolveTask: null });
    this.json(response, 200, { ok: true, deviceId: device.id });
  }

  private async handleNodePoll(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const deviceId = request.headers['x-device-id'];
    if (typeof deviceId !== 'string') { this.json(response, 401, { error: '缺少节点标识。' }); return; }
    const node = this.nodes.get(deviceId);
    if (!node) { this.json(response, 409, { error: '节点尚未注册。' }); return; }
    const task = await new Promise<{ id: string; tool: string; input: unknown } | null>(resolve => {
      const timer = setTimeout(() => { this.waiters.delete(deviceId); resolve(null); }, 25_000);
      this.waiters.set(deviceId, { resolve, timer });
      node.resolveTask = resolve;
    });
    this.json(response, 200, { task });
  }

  private async handleNodeEvents(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const deviceId = request.headers['x-device-id'];
    if (typeof deviceId !== 'string') { this.json(response, 401, { error: '缺少节点标识。' }); return; }
    const node = this.nodes.get(deviceId);
    if (!node) { this.json(response, 409, { error: '节点尚未注册。' }); return; }
    // Acknowledge first, then consume the body: the node may stream progress
    // over a long lived connection.
    this.json(response, 202, { accepted: true });
    let buffer = '';
    for await (const chunk of request) {
      buffer += (chunk as Buffer).toString('utf8');
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) this.onNodeMessage(node, line);
    }
    if (buffer.trim()) this.onNodeMessage(node, buffer);
  }

  private onNodeMessage(node: WaitingNode, raw: string): void {
    if (!raw.trim()) return;
    let message: NodeMessage;
    try { message = JSON.parse(raw); } catch { return; }
    if (!message.id) return;
    if (message.type === 'progress') {
      const status = message.status === 'succeeded' ? 'succeeded' : message.status === 'failed' ? 'failed' : message.status === 'cancelled' ? 'cancelled' : 'running';
      this.store.updateTask(message.id, { status, error: message.error ?? null, runId: message.runId ?? null });
      if (message.runId && status !== 'running') {
        this.store.addRun({ id: message.runId, deviceId: node.deviceId, deviceName: node.name, tool: message.tool ?? '', status, durationMs: message.durationMs ?? null, startedAt: message.startedAt ? Date.parse(message.startedAt) : Date.now(), recordedAt: Date.now() });
      }
      return;
    }
    if (message.type === 'result') {
      const status = message.status === 'succeeded' ? 'succeeded' : message.status === 'cancelled' ? 'cancelled' : 'failed';
      this.store.updateTask(message.id, { status, result: typeof message.result === 'string' ? message.result : JSON.stringify(message.result ?? null), error: message.error ?? null, runId: message.runId ?? null });
      if (message.runId) {
        this.store.addRun({ id: message.runId, deviceId: node.deviceId, deviceName: node.name, tool: message.tool ?? '', status, durationMs: message.durationMs ?? null, startedAt: message.startedAt ? Date.parse(message.startedAt) : Date.now(), recordedAt: Date.now() });
      }
    }
  }
}

export async function loadRelayConfig(configPath: string): Promise<RelayConfig> {
  const raw = JSON.parse(await readFile(configPath, 'utf8'));
  const parsed = relayConfigSchema.safeParse(raw);
  if (!parsed.success) throw new Error(`中继配置无效：${parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('；')}`);
  return parsed.data;
}

export function relayConfigTemplate(directory: string): string {
  return JSON.stringify({ address: 'http://<服务器IP>:4319', port: 4319, pairCode: randomBytes(3).toString('hex'), dataDirectory: path.resolve(directory, 'relay-data'), deviceToken: randomBytes(24).toString('base64url') }, null, 2);
}
