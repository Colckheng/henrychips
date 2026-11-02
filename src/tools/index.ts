import { textStatsTool } from './text-stats.js';
import { filesPlanTool } from './files-plan.js';
import { csvSummaryTool } from './csv-summary.js';
import { pdfExtractTool } from './pdf-extract.js';
import { webExtractTool } from './web-extract.js';
import { envInspectTool } from './env-inspect.js';
import { bilibiliVideoTool } from './bilibili-video.js';
import { douyinVideoTool } from './douyin-video.js';
import { douyinNoWatermarkTool } from './douyin-nowatermark.js';
import { docConvertTool } from './doc-convert.js';
import { photoCompressTool } from './photo-compress.js';
import { ToolRegistry } from '../core/registry.js';

export function createRegistry() {
  return new ToolRegistry([
    filesPlanTool, textStatsTool, csvSummaryTool, pdfExtractTool, webExtractTool, envInspectTool,
    bilibiliVideoTool, douyinVideoTool, douyinNoWatermarkTool, docConvertTool, photoCompressTool,
  ]);
}
