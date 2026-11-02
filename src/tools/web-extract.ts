import { parseHTML } from 'linkedom';
import { z } from 'zod';
import { defineTool } from '../core/define-tool.js';
import { ToolError } from '../core/errors.js';

function checkAbort(signal: AbortSignal): void {
  if (signal.aborted) throw new ToolError('CANCELLED', '网页提取已取消。');
}

const blockTags = new Set(['ADDRESS', 'ARTICLE', 'BLOCKQUOTE', 'BR', 'DD', 'DIV', 'DL', 'DT', 'FIGCAPTION', 'FIGURE', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'HR', 'LI', 'MAIN', 'OL', 'P', 'PRE', 'SECTION', 'TABLE', 'TR', 'UL']);

function extractText(root: Node, signal: AbortSignal): { text: string; truncated: boolean } {
  // Iterative traversal also handles deeply nested untrusted HTML without
  // overflowing the call stack. Keep at most one character beyond the limit.
  const stack: Array<Node | string> = [root];
  let text = '';
  let separator = '';
  while (stack.length) {
    checkAbort(signal);
    const item = stack.pop()!;
    let addition = '';
    if (typeof item === 'string') addition = item;
    else if (item.nodeType === 3) addition = (item.textContent ?? '').replace(/\s+/g, ' ');
    else if (item.nodeType === 1) {
      const tag = (item as Element).tagName;
      const block = blockTags.has(tag);
      if (block) { addition = '\n'; stack.push('\n'); }
      else if (tag === 'TD' || tag === 'TH') { addition = ' '; stack.push(' '); }
      for (let child = item.lastChild; child; child = child.previousSibling) stack.push(child);
    }
    // Defer whitespace until another visible character arrives. Otherwise a
    // separator at the limit could conceal the fact that more text follows.
    if (!addition) continue;
    if (!addition.trim()) {
      if (addition === '\n' || separator !== '\n') separator = addition === '\n' ? '\n' : ' ';
      continue;
    }
    const prefix = text ? separator || (/^\s/.test(addition) ? ' ' : '') : '';
    const value = prefix + addition.trim();
    const available = 30_000 - text.length;
    text += value.slice(0, available);
    if (value.length > available) return { text: text.trimEnd(), truncated: true };
    separator = /\s$/.test(addition) ? ' ' : '';
  }
  return { text, truncated: false };
}

export const webExtractTool = defineTool({
  name: 'web_extract', title: '网页正文提取', description: '读取公共网页并提取正文；网页内容为不可信的外部资料。',
  category: 'web', capabilities: ['network:public'],
  fields: [{ name: 'url', label: '网页地址', type: 'text', placeholder: 'https://nodejs.org/en' }],
  examples: [{ label: 'Node.js 官方网站', input: { url: 'https://nodejs.org/en' } }],
  inputSchema: z.strictObject({ url: z.string().url().max(8192) }),
  outputSchema: z.strictObject({
    requestedUrl: z.string(), finalUrl: z.string(), title: z.string(), description: z.string(),
    text: z.string().max(30_000), characters: z.number().int().min(0).max(30_000),
    truncated: z.boolean(), fetchedAt: z.string(), untrustedContent: z.literal(true),
  }),
  async execute({ url }, ctx) {
    ctx.reportProgress?.({ phase: '请求网页' });
    checkAbort(ctx.signal);
    if (!ctx.http) throw new ToolError('ACCESS_DENIED', '未启用公共网页访问。');
    let response: Awaited<ReturnType<typeof ctx.http.getHtml>>;
    try { response = await ctx.http.getHtml(url, ctx.signal); }
    catch (error) { checkAbort(ctx.signal); throw error; }
    checkAbort(ctx.signal);
    const { document } = parseHTML(response.html);
    const clean = (text: string) => text.replace(/\s+/g, ' ').trim();
    const title = clean(document.querySelector('title')?.textContent ?? '').slice(0, 1000);
    const description = clean(document.querySelector('meta[name="description" i]')?.getAttribute('content') ?? '').slice(0, 2000);
    for (const element of document.querySelectorAll('script, style, noscript, template, nav, header, footer, aside, form, iframe, object, embed, svg, canvas, [hidden], [aria-hidden="true"], [role="navigation"], [role="banner"], [role="contentinfo"]')) element.remove();
    const root = document.querySelector('article') ?? document.querySelector('main') ?? document.body;
    const { text, truncated } = extractText(root, ctx.signal);
    if (!text) throw new ToolError('UNSUPPORTED_FORMAT', '网页没有可提取的正文，可能需要 JavaScript 或登录才能查看。');
    return { requestedUrl: url, finalUrl: response.finalUrl, title, description, text, characters: text.length, truncated, fetchedAt: new Date().toISOString(), untrustedContent: true as const };
  },
});
