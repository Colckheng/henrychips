import { isRecord } from '../api.js';
import { formatNumber } from '../presentation.js';
import { DataTable, GenericResult, Metrics, valueText } from './ResultData.js';

function namedRecords(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) return value.filter(isRecord);
  return isRecord(value) ? Object.entries(value).filter(([, item]) => isRecord(item)).map(([name, item]) => ({ name, ...item as Record<string, unknown> })) : [];
}

export function CsvResult({ data }: { data: Record<string, unknown> }) {
  const columns = namedRecords(data.columns);
  const numeric = namedRecords(data.numericColumns ?? data.numericSummary ?? data.numeric);
  const summaries = (numeric.length ? numeric : columns).flatMap(column => {
    const nested = column.numeric ?? column.statistics ?? column.stats;
    const stats = isRecord(nested) ? nested : column;
    return typeof stats.sum === 'number' ? [{ ...column, ...stats }] : [];
  });
  const preview = Array.isArray(data.preview) ? data.preview : [];
  const headers = Array.isArray(data.columnNames) ? data.columnNames.map(String)
    : Array.isArray(data.columns) && data.columns.every(item => typeof item === 'string') ? data.columns as string[]
    : columns.length ? columns.map(column => String(column.name ?? column.column ?? ''))
    : isRecord(preview[0]) ? Object.keys(preview[0]) : [];
  if (!columns.length && !headers.length && !summaries.length && !('rowCount' in data)) return <GenericResult data={data} />;
  return <div className="result-sections"><Metrics data={data} keys={['rowCount', 'columnCount']} />
    <section><div className="result-section-heading"><h3>数值摘要</h3><span>空值不参与计算</span></div>
      {summaries.length ? <DataTable label="数值摘要" headers={['字段', '非空数', '空值数', '最小值', '最大值', '总和', '平均值']}
        rows={summaries.map(column => [valueText(column.name ?? column.column), formatNumber(column.nonEmptyCount ?? column.count), formatNumber(column.emptyCount), formatNumber(column.min), formatNumber(column.max), formatNumber(column.sum), formatNumber(column.mean)])} />
        : <p className="inline-note">未发现可计算的数值列。</p>}
    </section>
    {columns.length > 0 && <details className="result-disclosure"><summary>字段信息 · {columns.length} 列</summary><DataTable label="字段信息" headers={['字段', '空值数', '非空数']}
      rows={columns.map(column => [valueText(column.name ?? column.column), formatNumber(column.emptyCount), formatNumber(typeof data.rowCount === 'number' && typeof column.emptyCount === 'number' ? data.rowCount - column.emptyCount : undefined)])} /></details>}
    <section><div className="result-section-heading"><h3>数据预览</h3><span>展示服务返回的 {preview.length} 行</span></div>
      <DataTable label="数据预览" headers={headers} rows={preview.map(row => headers.map((header, index) => valueText(isRecord(row) ? row[header] : Array.isArray(row) ? row[index] : row)))} />
    </section>
  </div>;
}
