import { z } from 'zod';
import sharp from 'sharp';
import { defineTool } from '../core/define-tool.js';
import { ToolError } from '../core/errors.js';
import { writeUniqueFile } from '../core/file-access.js';

const formatOf = (value: string) => value === 'webp' ? 'webp' : value === 'avif' ? 'avif' : 'jpeg';

export const photoCompressTool = defineTool({
  name: 'photo_compress',
  title: '照片压缩',
  description: '压缩工作区内的照片，可转换 JPEG/WebP/AVIF 并限制最长边，输出文件保存到输出目录，同时给出压缩前后体积对比。',
  category: 'media',
  capabilities: ['files:read', 'files:write'],
  timeoutMs: 120_000,
  fields: [
    { name: 'path', label: '照片路径', type: 'relative-path', description: '工作区内的图片，例如 samples/photo.jpg。' },
    { name: 'format', label: '输出格式', type: 'select', options: [
      { label: 'JPEG', value: 'jpeg' },
      { label: 'WebP', value: 'webp' },
      { label: 'AVIF', value: 'avif' },
    ] },
    { name: 'quality', label: '质量', type: 'number', description: '1 到 100，数值越小体积越小。' },
    { name: 'maxWidth', label: '最大宽度', type: 'number', description: '可选，缩放到不超过该宽度。' },
    { name: 'maxHeight', label: '最大高度', type: 'number', description: '可选，缩放到不超过该高度。' },
    { name: 'keepMetadata', label: '保留 EXIF 信息', type: 'checkbox', description: '默认移除拍摄参数等元数据。' },
  ],
  examples: [
    { label: '压缩示例照片', input: { path: 'samples/photo.jpg', format: 'jpeg', quality: 70 } },
  ],
  inputSchema: z.strictObject({
    path: z.string().min(1).max(4096),
    format: z.enum(['jpeg', 'webp', 'avif']).default('jpeg'),
    quality: z.number().int().min(1).max(100).default(70),
    maxWidth: z.number().int().positive().max(20000).optional(),
    maxHeight: z.number().int().positive().max(20000).optional(),
    keepMetadata: z.boolean().default(false),
  }),
  outputSchema: z.strictObject({
    sourcePath: z.string(),
    format: z.string(),
    originalBytes: z.number().int().nonnegative(),
    compressedBytes: z.number().int().nonnegative(),
    savedBytes: z.number().int(),
    ratio: z.number(),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    savedFile: z.strictObject({ relativePath: z.string(), bytes: z.number() }),
    warnings: z.array(z.string()),
  }),
  async execute({ path, format, quality, maxWidth, maxHeight, keepMetadata }, ctx) {
    if (!/\.(jpe?g|png|webp|avif|tiff?|bmp)$/i.test(path)) throw new ToolError('UNSUPPORTED_FORMAT', '请选择 JPEG、PNG、WebP、AVIF 或 TIFF 图片。');
    if (!ctx.files) throw new ToolError('ACCESS_DENIED', '未启用工作区文件读取。');
    if (!ctx.output) throw new ToolError('ACCESS_DENIED', '未启用文件写入。');
    ctx.reportProgress?.({ phase: '读取图片' });
    const source = await ctx.files.readBytes(path, ctx.limits.fileBytes);
    const target = formatOf(format);
    let pipeline = sharp(source, { failOn: 'none' });
    ctx.reportProgress?.({ phase: '解码图片' });
    const metadata = await pipeline.metadata();
    if (!metadata.width || !metadata.height) throw new ToolError('UNSUPPORTED_FORMAT', '无法读取图片尺寸，文件可能已损坏。');
    if (!keepMetadata) pipeline = pipeline.withMetadata({});
    else pipeline = pipeline.keepMetadata();
    if (maxWidth || maxHeight) {
      pipeline = pipeline.resize({
        width: maxWidth ?? undefined,
        height: maxHeight ?? undefined,
        fit: 'inside',
        withoutEnlargement: true,
      });
    }
    pipeline = target === 'jpeg' ? pipeline.jpeg({ quality, mozjpeg: true }) : target === 'webp' ? pipeline.webp({ quality }) : pipeline.avif({ quality: Math.max(20, quality - 20) });
    ctx.reportProgress?.({ phase: '编码输出', percent: 70 });
    const output = await pipeline.toBuffer();
    const info = await sharp(output).metadata();
    const warnings: string[] = [];
    if (output.byteLength >= source.byteLength) warnings.push('压缩后体积没有变小，请提高质量或降低尺寸。');
    if (target === 'jpeg' && metadata.hasAlpha) warnings.push('JPEG 不支持透明通道，透明区域已按白色填充。');
    const baseName = (path.split('/').pop() ?? 'photo').replace(/\.[^.]+$/, '');
    const saved = await writeUniqueFile(ctx.output, `${baseName}-compressed.${target === 'jpeg' ? 'jpg' : target}`, new Uint8Array(output));
    return {
      sourcePath: path,
      format: target,
      originalBytes: source.byteLength,
      compressedBytes: output.byteLength,
      savedBytes: source.byteLength - output.byteLength,
      ratio: source.byteLength ? Math.round((output.byteLength / source.byteLength) * 1000) / 1000 : 1,
      width: info.width ?? metadata.width,
      height: info.height ?? metadata.height,
      savedFile: saved,
      warnings,
    };
  },
});
