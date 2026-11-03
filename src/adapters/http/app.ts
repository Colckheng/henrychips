import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { getProjectRoot, type WorkstationConfig } from '../../core/config.js';
import { createRuntime, type Runtime } from '../../core/runtime.js';
import { registerRoutes } from './routes.js';

export async function buildApp(config: WorkstationConfig, options: { dev?: boolean; runtime?: Runtime; assetRoot?: string } = {}) {
  const app = Fastify({ bodyLimit: 1048576, logger: false });
  const hosts = new Set([`127.0.0.1:${config.http.port}`, `localhost:${config.http.port}`]);
  const origins = new Set([...hosts].map(host => `http://${host}`));
  if (options.dev) { origins.add('http://127.0.0.1:5173'); origins.add('http://localhost:5173'); }
  app.addHook('onRequest', async (request, reply) => {
    if (!hosts.has(request.headers.host ?? '') || request.headers.origin !== undefined && !origins.has(request.headers.origin)) {
      return reply.code(403).send({ error: { code: 'ACCESS_DENIED', message: '此服务只允许本机工作台访问。' } });
    }
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'no-referrer');
    if (!options.dev) reply.header('Content-Security-Policy', "default-src 'self'; img-src 'self' data:; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'");
    if (request.url.startsWith('/api/')) reply.header('Cache-Control', 'no-store');
  });
  app.setErrorHandler((error, _request, reply) => {
    const status = (error as { statusCode?: number }).statusCode ?? 500;
    reply.code(status).send({ error: { code: status === 413 ? 'LIMIT_EXCEEDED' : status < 500 ? 'INVALID_INPUT' : 'TOOL_FAILED', message: status === 413 ? '请求内容超过大小限制。' : status < 500 ? '请求格式不正确。' : '请求处理失败，请稍后重试。' } });
  });
  registerRoutes(app, config, options.runtime ?? createRuntime(config), { assetRoot: options.assetRoot });
  const webRoot = path.join(options.assetRoot ?? getProjectRoot(), 'dist/web');
  if (existsSync(path.join(webRoot, 'index.html'))) {
    await app.register(fastifyStatic, { root: webRoot, wildcard: true, list: false, dotfiles: 'deny' });
  }
  app.setNotFoundHandler((_request, reply) => reply.code(404).send({ error: { code: 'TOOL_NOT_FOUND', message: '找不到请求的页面或接口。' } }));
  return app;
}
