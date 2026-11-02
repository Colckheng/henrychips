import { Clapperboard, Code2, FileText, FolderOpen, Globe2, Table2, Type } from 'lucide-react';
import type { Capability, Category } from '../contracts/tool.js';

export const categories = {
  files: { label: '文件管理', icon: FolderOpen, tone: 'amber' },
  documents: { label: '文档处理', icon: FileText, tone: 'rose' },
  web: { label: '网页提取', icon: Globe2, tone: 'blue' },
  data: { label: '数据处理', icon: Table2, tone: 'green' },
  developer: { label: '开发工具', icon: Code2, tone: 'violet' },
  text: { label: '文本处理', icon: Type, tone: 'orange' },
  media: { label: '影音处理', icon: Clapperboard, tone: 'green' },
} satisfies Record<Category, { label: string; icon: typeof FolderOpen; tone: string }>;

export const categoryEntries = Object.entries(categories) as [Category, typeof categories[Category]][];
export const capabilityLabels: Record<Capability, string> = {
  'files:read': '读取工作区文件', 'files:write': '写入输出目录', 'network:public': '访问公开网页',
  'process:probe': '检查本机环境', 'browser:local': '调用本机浏览器',
};

export function formatNumber(value: unknown): string {
  return typeof value === 'number' ? new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 6 }).format(value) : '—';
}

export function formatDuration(ms: number): string {
  return ms < 1000 ? `${formatNumber(ms)} ms` : `${formatNumber(ms / 1000)} s`;
}

export function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).format(date);
}

export const resultLabels: Record<string, string> = {
  characters: '字符总数', charactersWithoutWhitespace: '不含空白字符', lines: '行数',
  hanCharacters: '汉字数', latinWords: '拉丁词数', rowCount: '数据行数', columnCount: '字段数量',
  scannedFiles: '扫描文件', totalBytes: '文件总大小（字节）', totalPages: '文档总页数',
  textCharacters: '提取字符', truncated: '已截断', platform: '操作系统', architecture: 'CPU 架构',
  node: 'Node.js', git: 'Git', available: '可用', version: '版本', directory: '源目录',
  requestedUrl: '请求地址', finalUrl: '来源地址', title: '标题', description: '描述',
  fetchedAt: '获取时间', untrustedContent: '外部网页内容', count: '数量', emptyCount: '空值数',
  nonEmptyCount: '非空数', min: '最小值', max: '最大值', sum: '总和', mean: '平均值',
  bvid: 'BV 号', owner: 'UP 主', cover: '封面', durationSeconds: '时长（秒）', pageCount: '分P 数',
  streams: '媒体流', kind: '类型', label: '名称', codecs: '编码', url: '直链', sizeBytes: '大小（字节）',
  awemeId: '作品 ID', author: '作者', durationMs: '时长（毫秒）', createdAt: '发布时间',
  videoUrl: '视频地址', watermarkedUrl: '带水印地址', noWatermarkUrl: '无水印地址', candidates: '候选地址',
  imageUrls: '图片地址', sourcePath: '源文件', sourceFormat: '源格式', targetFormat: '目标格式',
  converter: '转换方式', originalBytes: '原始体积（字节）',
  compressedBytes: '压缩后体积（字节）', savedBytes: '节省体积（字节）', ratio: '压缩比',
  width: '宽度', height: '高度', format: '输出格式', savedFile: '输出文件', relativePath: '文件路径',
  bytes: '字节数', warnings: '提示',
};
