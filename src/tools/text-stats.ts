import { z } from 'zod';
import { defineTool } from '../core/define-tool.js';
import { ToolError } from '../core/errors.js';

export const textStatsTool = defineTool({
  name: 'text_stats', title: '文本统计', category: 'text', capabilities: [],
  description: '统计中英文、字符和行数。按 Unicode 码点计数，支持最多 100,000 个字符。',
  fields: [{ name: 'text', label: '待分析文本', type: 'textarea', placeholder: '粘贴需要统计的文字…' }],
  examples: [{ label: '中英混合文本', input: { text: 'Hello 世界\n第二行' } }],
  inputSchema: z.strictObject({ text: z.string() }),
  outputSchema: z.strictObject({ characters: z.number().int(), charactersWithoutWhitespace: z.number().int(), lines: z.number().int(), hanCharacters: z.number().int(), latinWords: z.number().int() }),
  async execute({ text }, ctx) {
    ctx.signal.throwIfAborted();
    const characters = [...text].length;
    if (characters > 100000) throw new ToolError('LIMIT_EXCEEDED', '文本最多支持 100,000 个 Unicode 字符。');
    const compact = text.replace(/[\p{White_Space}\uFEFF]/gu, '');
    if (!compact) throw new ToolError('INVALID_INPUT', '请输入非空白文本。');
    return {
      characters, charactersWithoutWhitespace: [...compact].length,
      lines: text.replace(/\r\n?/g, '\n').split('\n').length,
      hanCharacters: (text.match(/\p{Script=Han}/gu) ?? []).length,
      latinWords: (text.match(/\p{Script=Latin}+/gu) ?? []).length,
    };
  },
});
