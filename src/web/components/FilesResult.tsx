import { ShieldCheck } from 'lucide-react';
import { isRecord } from '../api.js';
import { DataTable, GenericResult, Metrics, valueText } from './ResultData.js';

export function FilesResult({ data }: { data: Record<string, unknown> }) {
  if (!Array.isArray(data.moves)) return <GenericResult data={data} />;
  const moves = data.moves.filter(isRecord);
  const skipped = Array.isArray(data.skipped) ? data.skipped : [];
  return <div className="result-sections"><div className="readonly-note"><ShieldCheck size={17} aria-hidden="true" />这是整理建议，未移动或修改任何文件。</div>
    <Metrics data={data} keys={['scannedFiles', 'totalBytes']} />
    <section><div className="result-section-heading"><h3>整理计划</h3><span>{moves.length} 项建议</span></div>
      <DataTable label="文件整理计划" headers={['原路径', '建议目标路径', '分类', '状态']} rows={moves.map(move => [
        <code>{valueText(move.source)}</code>, <code>{valueText(move.suggestedDestination)}</code>, valueText(move.category),
        <span className={`status-badge ${move.conflict ? 'status-warning' : 'status-neutral'}`}>{move.conflict ? '目标冲突' : '可整理'}</span>,
      ])} />
    </section>
    {skipped.length > 0 && <details className="result-disclosure"><summary>已跳过 {skipped.length} 项</summary>
      <ul className="skipped-list">{skipped.map((item, index) => <li key={index}>{isRecord(item) ? `${valueText(item.path ?? item.name ?? item.source ?? item.relativePath)} · ${valueText(item.reason)}` : valueText(item)}</li>)}</ul>
    </details>}
  </div>;
}
