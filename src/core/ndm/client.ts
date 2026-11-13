import { ToolError } from '../errors.js';

export interface NdmTarget {
  url: string;
  fileName: string;
  headers?: Record<string, string>;
}

const NDM_SUBPROTOCOL = 'neatextension.v1';

/**
 * Builds the message of the extension protocol of the download manager. The
 * protocol is a bare request text with numbered keys, and the answer of the
 * manager only says whether the link was taken.
 */
export function buildNdmMessage(target: NdmTarget): string {
  const headers = target.headers ?? {};
  // A value with a line break would end the field and start another one, so
  // a header of the caller could smuggle a field into the request.
  for (const [key, value] of Object.entries(headers)) {
    if (/[\r\n]/.test(key) || /[\r\n]/.test(value)) {
      throw new ToolError('INVALID_INPUT', `请求头 ${key} 含有非法字符。`);
    }
  }
  let message = '1: GET\r\n';
  message += `2: ${target.url}\r\n`;
  message += `4: ${target.fileName}\r\n`;
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === 'referer') message += `Referer: ${value}\r\n`;
    else if (key.toLowerCase() === 'cookie') message += `Cookie: ${value}\r\n`;
    else if (key.toLowerCase() === 'origin') message += `Origin: ${value}\r\n`;
    else if (key.toLowerCase() === 'user-agent') message += `9: ${value}\r\n`;
    else message += `${key}: ${value}\r\n`;
  }
  message += 'Content-Disposition: attachment; filename="' + target.fileName.replace(/["\\]/g, '_') + '"\r\n';
  message += '\r\n';
  return message;
}

/**
 * The client of the local download manager. The manager runs a websocket
 * server of its own, which the browser extension of the manager uses to hand
 * a link over. The protocol only says that the link was taken, so the client
 * cannot tell whether the download finished.
 */
export class NdmClient {
  private readonly host: string;
  private readonly port: number;
  private readonly timeoutMs: number;

  constructor(options?: { port?: number; host?: string; timeoutMs?: number }) {
    this.host = options?.host ?? '127.0.0.1';
    this.port = options?.port ?? 10007;
    this.timeoutMs = options?.timeoutMs ?? 10_000;
  }

  async send(target: NdmTarget): Promise<void> {
    const message = buildNdmMessage(target);
    await new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(`ws://${this.host}:${this.port}/download`, NDM_SUBPROTOCOL);
      const timer = setTimeout(() => {
        try { socket.close(); } catch { /* already closed */ }
        reject(new ToolError('ACCESS_DENIED', '连接本机 Neat Download Manager 超时，请确认它已启动。'));
      }, this.timeoutMs);
      socket.addEventListener('open', () => { socket.send(message); });
      socket.addEventListener('message', () => { clearTimeout(timer); socket.close(); resolve(); });
      socket.addEventListener('error', () => {
        clearTimeout(timer);
        reject(new ToolError('ACCESS_DENIED', '未检测到本机 Neat Download Manager，请先启动它再使用该后端。'));
      });
      socket.addEventListener('close', () => { clearTimeout(timer); });
    });
  }
}
