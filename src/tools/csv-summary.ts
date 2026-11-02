import path from 'node:path';
import { parse } from 'csv-parse';
import { z } from 'zod';
import { defineTool } from '../core/define-tool.js';
import { ToolError } from '../core/errors.js';

const numericSchema = z.strictObject({ count: z.number().int(), min: z.number(), max: z.number(), sum: z.number(), mean: z.number() });
export const csvSummaryTool = defineTool({
  name: 'csv_summary', title: 'CSV 分析', category: 'data', capabilities: ['files:read'],
  description: '读取 UTF-8 CSV，分析行列、空值与数值摘要，预览前 5 行；首版不读取 XLSX。',
  fields: [
    { name: 'path', label: 'CSV 文件路径', type: 'relative-path', placeholder: 'samples/sales.csv' },
    { name: 'delimiter', label: '分隔符', type: 'select', options: [{ label: '逗号 (,)', value: ',' }, { label: '分号 (;)', value: ';' }, { label: '制表符 (Tab)', value: '\t' }] },
  ],
  examples: [{ label: '销售数据样例', input: { path: 'samples/sales.csv', delimiter: ',' } }],
  inputSchema: z.strictObject({ path: z.string().min(1), delimiter: z.enum([',', ';', '\t']).default(',') }),
  outputSchema: z.strictObject({ rowCount: z.number().int(), columnCount: z.number().int(), columns: z.array(z.strictObject({ name: z.string(), emptyCount: z.number().int(), numeric: numericSchema.nullable() })), preview: z.array(z.record(z.string(), z.string())) }),
  async execute(input, ctx) {
    if (path.extname(input.path).toLowerCase() !== '.csv') throw new ToolError('UNSUPPORTED_FORMAT', '请选择 .csv 文件，暂不支持 Excel 工作簿。');
    ctx.reportProgress?.({ phase: '读取 CSV 文件' });
    const text = await ctx.files!.readText(input.path, ctx.limits.fileBytes);
    ctx.reportProgress?.({ phase: '解析行并统计数值' });
    const parser = parse({ delimiter: input.delimiter, bom: true, skip_empty_lines: true, max_record_size: ctx.limits.fileBytes });
    const abort = () => parser.destroy(new ToolError('CANCELLED', '本次执行已取消。'));
    ctx.signal.throwIfAborted();
    ctx.signal.addEventListener('abort', abort, { once: true });
    parser.end(text);
    let headers: string[] | undefined;
    let rowCount = 0;
    const preview: Record<string, string>[] = [];
    const statistics: Array<{ emptyCount: number; valid: boolean; count: number; min: number; max: number; sum: number }> = [];
    try {
      for await (const record of parser) {
        ctx.signal.throwIfAborted();
        const row = record as string[];
        if (!headers) {
          const normalized = row.map(value => value.trim());
          if (!row.length || normalized.some(value => !value) || new Set(normalized).size !== row.length) throw new ToolError('INVALID_INPUT', 'CSV 表头不能为空或重复。');
          headers = row;
          for (const _header of headers) statistics.push({ emptyCount: 0, valid: true, count: 0, min: Infinity, max: -Infinity, sum: 0 });
          continue;
        }
        rowCount++;
        if (rowCount % 500 === 0) ctx.reportProgress?.({ phase: `已解析 ${rowCount} 行`, percent: Math.min(95, Math.round((rowCount / ctx.limits.csvRows) * 95)) });
        if (rowCount > ctx.limits.csvRows) throw new ToolError('LIMIT_EXCEEDED', 'CSV 数据行数超过处理上限。');
        if (preview.length < 5) preview.push(Object.fromEntries(headers.map((header, index) => [header, row[index]])));
        row.forEach((raw, index) => {
          const stat = statistics[index];
          const value = raw.trim();
          if (!value) { stat.emptyCount++; return; }
          const number = Number(value);
          if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(value) || !Number.isFinite(number)) { stat.valid = false; return; }
          stat.count++; stat.min = Math.min(stat.min, number); stat.max = Math.max(stat.max, number); stat.sum += number;
        });
      }
      if (!headers) throw new ToolError('INVALID_INPUT', 'CSV 文件缺少表头。');
      const columns = headers.map((name, index) => {
        const { emptyCount, valid, count, min, max, sum } = statistics[index];
        if (valid && count && !Number.isFinite(sum)) throw new ToolError('LIMIT_EXCEEDED', '数值合计超出可表示范围。');
        return { name, emptyCount, numeric: valid && count ? { count, min, max, sum, mean: sum / count } : null };
      });
      return { rowCount, columnCount: headers.length, columns, preview };
    } catch (error) {
      if (error instanceof ToolError || ctx.signal.aborted) throw error;
      throw new ToolError('INVALID_INPUT', 'CSV 格式不正确，请检查引号、分隔符及各行字段数。');
    } finally { ctx.signal.removeEventListener('abort', abort); parser.destroy(); }
  },
});
