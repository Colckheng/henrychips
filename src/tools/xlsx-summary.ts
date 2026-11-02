import { z } from 'zod';
import readXlsxFile from 'read-excel-file/node';
import { defineTool } from '../core/define-tool.js';
import { ToolError } from '../core/errors.js';

type CellKind = 'number' | 'text' | 'date' | 'boolean' | 'empty' | 'mixed';

interface ColumnSummary {
  name: string;
  kind: CellKind;
  filled: number;
  empty: number;
  numeric: { count: number; min: number; max: number; sum: number; mean: number } | null;
  topValues: Array<{ value: string; count: number }>;
}

function kindOf(value: unknown): CellKind {
  if (value === null || value === undefined || value === '') return 'empty';
  if (typeof value === 'number') return 'number';
  if (typeof value === 'boolean') return 'boolean';
  if (value instanceof Date) return 'date';
  return 'text';
}

function textOf(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value);
}

function numericOf(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(value.trim())) {
    const parsed = Number(value.trim());
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

export const xlsxSummaryTool = defineTool({
  name: 'xlsx_summary',
  title: 'XLSX 表格分析',
  description: '读取工作区内的 Excel 工作簿，列出工作表、表头、行数与逐列类型统计（数值列的最小/最大/总和/均值、空值数、高频取值），只读不改写文件。',
  category: 'data',
  capabilities: ['files:read'],
  timeoutMs: 120_000,
  fields: [
    { name: 'path', label: '工作簿路径', type: 'relative-path', description: '工作区内的 .xlsx 文件，例如 samples/sales.xlsx。' },
    { name: 'maxRows', label: '每表最多统计行数', type: 'number', description: '默认 2000 行，避免超大工作簿拖慢。' },
    { name: 'sheet', label: '工作表名称', type: 'text', description: '可选，只分析指定工作表；留空则分析全部。' },
  ],
  examples: [
    { label: '分析示例工作簿', input: { path: 'samples/sales.xlsx', maxRows: 2000 } },
  ],
  inputSchema: z.strictObject({
    path: z.string().min(1).max(4096),
    maxRows: z.number().int().positive().max(50_000).default(2000),
    sheet: z.string().min(1).max(200).optional(),
  }),
  outputSchema: z.strictObject({
    sourcePath: z.string(),
    sheetCount: z.number().int().nonnegative(),
    sheets: z.array(z.strictObject({
      name: z.string(),
      rowCount: z.number().int().nonnegative(),
      columnCount: z.number().int().nonnegative(),
      headers: z.array(z.string()),
      analyzedRows: z.number().int().nonnegative(),
      truncated: z.boolean(),
      columns: z.array(z.strictObject({
        name: z.string(),
        kind: z.string(),
        filled: z.number().int().nonnegative(),
        empty: z.number().int().nonnegative(),
        numeric: z.strictObject({ count: z.number().int().nonnegative(), min: z.number(), max: z.number(), sum: z.number(), mean: z.number() }).nullable(),
        topValues: z.array(z.strictObject({ value: z.string(), count: z.number().int().nonnegative() })),
      })),
    })),
    warnings: z.array(z.string()),
  }),
  async execute({ path, maxRows, sheet }, ctx) {
    if (!ctx.files) throw new ToolError('ACCESS_DENIED', '未启用工作区文件读取。');
    if (!/\.xlsx$/i.test(path)) throw new ToolError('UNSUPPORTED_FORMAT', '请选择 .xlsx 工作簿；旧版 .xls 需要先转换为 .xlsx。');
    ctx.reportProgress?.({ phase: '读取工作簿' });
    const bytes = await ctx.files.readBytes(path, ctx.limits.fileBytes);
    ctx.reportProgress?.({ phase: '解析工作表', percent: 20 });
    let sheets: Array<{ sheet: string; data: unknown[][] }>;
    try {
      sheets = await readXlsxFile(Buffer.from(bytes));
    } catch {
      throw new ToolError('UNSUPPORTED_FORMAT', '无法解析该工作簿，文件可能已损坏或不是有效的 XLSX。');
    }
    const selected = sheet ? sheets.filter(item => item.sheet === sheet) : sheets;
    if (sheet && !selected.length) throw new ToolError('FILE_NOT_FOUND', `工作簿中没有名为 ${sheet} 的工作表。`);
    const warnings: string[] = [];
    const summary: Array<{
      name: string; rowCount: number; columnCount: number; headers: string[]; analyzedRows: number; truncated: boolean;
      columns: Array<{ name: string; kind: CellKind; filled: number; empty: number; numeric: { count: number; min: number; max: number; sum: number; mean: number } | null; topValues: Array<{ value: string; count: number }> }>;
    }> = [];

    for (const [index, worksheet] of selected.entries()) {
      ctx.reportProgress?.({ phase: `分析工作表 ${worksheet.sheet}`, percent: Math.round(30 + (index / Math.max(1, selected.length)) * 60) });
      const rows = worksheet.data ?? [];
      const headerRow = rows[0] ?? [];
      const columnCount = Math.max(headerRow.length, ...rows.map(row => row.length), 0);
      const headers: string[] = [];
      for (let columnIndex = 0; columnIndex < columnCount; columnIndex++) {
        const title = textOf(headerRow[columnIndex]).trim();
        headers.push(title || `列 ${columnIndex + 1}`);
      }
      const dataRows = Math.max(0, rows.length - 1);
      const analyzedRows = Math.min(dataRows, maxRows);
      const truncated = dataRows > analyzedRows;
      if (truncated) warnings.push(`${worksheet.sheet} 共有 ${dataRows} 行，本次只统计前 ${analyzedRows} 行。`);

      const columns: ColumnSummary[] = headers.map(name => ({ name, kind: 'empty', filled: 0, empty: 0, numeric: null, topValues: [] }));
      const counters = headers.map(() => new Map<string, number>());
      const kinds = headers.map(() => new Set<CellKind>());
      const numericValues = headers.map<number[]>(() => []);

      for (let rowIndex = 1; rowIndex <= analyzedRows; rowIndex++) {
        const row = rows[rowIndex] ?? [];
        for (let columnIndex = 0; columnIndex < columnCount; columnIndex++) {
          const value = row[columnIndex];
          kinds[columnIndex].add(kindOf(value));
          const text = textOf(value);
          if (text === '') { columns[columnIndex].empty++; continue; }
          columns[columnIndex].filled++;
          const counter = counters[columnIndex];
          counter.set(text, (counter.get(text) ?? 0) + 1);
          const number = numericOf(value);
          if (number !== null) numericValues[columnIndex].push(number);
        }
      }

      for (let columnIndex = 0; columnIndex < columns.length; columnIndex++) {
        const column = columns[columnIndex];
        const kindsHere = kinds[columnIndex];
        column.kind = kindsHere.size === 1 ? [...kindsHere][0] : 'mixed';
        const top = [...counters[columnIndex].entries()].sort((left, right) => right[1] - left[1]).slice(0, 3);
        column.topValues = top.map(([value, count]) => ({ value: value.length > 40 ? `${value.slice(0, 40)}…` : value, count }));
        const values = numericValues[columnIndex];
        if (values.length) {
          const sum = values.reduce((total, value) => total + value, 0);
          column.numeric = { count: values.length, min: Math.min(...values), max: Math.max(...values), sum, mean: sum / values.length };
        }
      }

      summary.push({
        name: worksheet.sheet,
        rowCount: rows.length,
        columnCount,
        headers,
        analyzedRows,
        truncated,
        columns,
      });
    }
    ctx.reportProgress?.({ phase: '汇总完成', percent: 100 });
    return { sourcePath: path, sheetCount: summary.length, sheets: summary, warnings };
  },
});
