import path from 'node:path';
import { z } from 'zod';
import { defineTool } from '../core/define-tool.js';

const categories: Array<{ name: string; extensions: string[] }> = [
  { name: '文档', extensions: ['txt', 'md', 'pdf', 'doc', 'docx', 'ppt', 'pptx', 'rtf'] },
  { name: '图片', extensions: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'bmp', 'heic'] },
  { name: '表格', extensions: ['csv', 'tsv', 'xls', 'xlsx', 'ods'] },
  { name: '音视频', extensions: ['mp3', 'wav', 'flac', 'm4a', 'mp4', 'mov', 'mkv', 'webm', 'avi'] },
  { name: '压缩包', extensions: ['zip', '7z', 'rar', 'gz', 'tar'] },
  { name: '代码', extensions: ['js', 'ts', 'tsx', 'jsx', 'py', 'java', 'go', 'rs', 'html', 'css', 'json', 'yaml', 'yml', 'sh'] },
  { name: '其他', extensions: [] },
];
const moveSchema = z.strictObject({ source: z.string(), suggestedDestination: z.string(), category: z.string(), conflict: z.boolean() });
export const filesPlanTool = defineTool({
  name: 'files_plan', title: '文件整理预览', category: 'files', capabilities: ['files:read'],
  description: '按文件类型生成分类建议，检查目标冲突。只预览，不移动或修改文件。',
  fields: [{ name: 'directory', label: '工作区内目录', type: 'relative-path', description: '只读取第一层文件，例如 inbox。', placeholder: 'inbox' }],
  examples: [{ label: '示例收件箱', input: { directory: 'inbox' } }],
  inputSchema: z.strictObject({ directory: z.string().min(1).default('inbox') }),
  outputSchema: z.strictObject({ directory: z.string(), scannedFiles: z.number().int(), totalBytes: z.number(), groups: z.array(z.strictObject({ category: z.string(), count: z.number().int(), totalBytes: z.number() })), moves: z.array(moveSchema), skipped: z.array(z.strictObject({ path: z.string(), reason: z.string() })) }),
  async execute(input, ctx) {
    const entries = await ctx.files!.list(input.directory, ctx.limits.directoryEntries);
    const directory = path.posix.normalize(input.directory.replaceAll('\\', '/')).replace(/\/$/, '') || '.';
    const moves: z.infer<typeof moveSchema>[] = [];
    const skipped: Array<{ path: string; reason: string }> = [];
    const counts = new Map<string, { category: string; count: number; totalBytes: number }>();
    let totalBytes = 0;
    for (const entry of entries) {
      ctx.signal.throwIfAborted();
      if (entry.kind !== 'file') { skipped.push({ path: entry.relativePath, reason: entry.kind === 'symlink' ? '跳过链接，不跟随目标。' : '仅处理第一层文件，跳过子目录。' }); continue; }
      const extension = path.extname(entry.name).slice(1).toLowerCase();
      const category = categories.find(group => group.extensions.includes(extension))?.name ?? '其他';
      const destination = path.posix.join(directory, category, entry.name);
      moves.push({ source: entry.relativePath, suggestedDestination: destination, category, conflict: await ctx.files!.exists(destination) });
      const group = counts.get(category) ?? { category, count: 0, totalBytes: 0 };
      group.count++; group.totalBytes += entry.sizeBytes ?? 0;
      counts.set(category, group); totalBytes += entry.sizeBytes ?? 0;
    }
    const targets = new Map<string, number>();
    for (const move of moves) { const key = move.suggestedDestination.toLowerCase(); targets.set(key, (targets.get(key) ?? 0) + 1); }
    for (const move of moves) if ((targets.get(move.suggestedDestination.toLowerCase()) ?? 0) > 1) move.conflict = true;
    return { directory, scannedFiles: moves.length, totalBytes, groups: categories.flatMap(group => counts.has(group.name) ? [counts.get(group.name)!] : []), moves, skipped };
  },
});
