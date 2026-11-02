import { CheckCircle2, Clock3, History as HistoryIcon, RotateCw, XCircle } from 'lucide-react';
import type { RunList, RunSummary } from '../../contracts/run.js';
import type { ToolDescription } from '../../contracts/tool.js';
import { useApi } from '../api.js';
import { formatDate, formatDuration } from '../presentation.js';
import { EmptyState, ErrorNotice, Loading, Warnings } from '../components/Feedback.js';

const statuses = {
  succeeded: { label: '成功', className: 'status-success', icon: CheckCircle2 },
  failed: { label: '失败', className: 'status-danger', icon: XCircle },
  cancelled: { label: '已取消', className: 'status-neutral', icon: Clock3 },
};
const sources = { web: '网页', cli: 'CLI', mcp: 'MCP' };

function HistoryRow({ run, title }: { run: RunSummary; title?: string }) {
  const status = statuses[run.status];
  const Icon = status.icon;
  return <tr><td><a className="history-tool" href={`#/tools/${encodeURIComponent(run.tool)}`}>{title ?? run.tool}</a><code className="history-tool-id">{run.tool}</code></td>
    <td><span className={`status-badge ${status.className}`}><Icon size={12} aria-hidden="true" />{status.label}</span>{run.errorCode && <code className="history-error-code">{run.errorCode}</code>}</td>
    <td><span className="source-badge">{sources[run.source] ?? run.source}</span></td><td><time dateTime={run.startedAt}>{formatDate(run.startedAt)}</time></td>
    <td className="numeric-cell">{formatDuration(run.durationMs)}</td><td><code className="run-id">{run.runId}</code></td>
  </tr>;
}

export function History({ tools }: { tools?: ToolDescription[] }) {
  const history = useApi<RunList>('/runs?limit=50');
  const runs = history.data?.runs ?? [];
  return <div className="page history-page"><header className="page-header"><div><div className="eyebrow">ACTIVITY LOG</div><h1>执行记录</h1><p>每一次调用，都有迹可循。查看最近 50 次运行摘要。</p></div>
    <button className="button button-secondary" disabled={history.loading} onClick={history.reload}><RotateCw size={16} className={history.loading ? 'spin' : ''} aria-hidden="true" />刷新记录</button></header>
    {history.loading ? <Loading label="正在读取运行记录…" /> : history.error ? <ErrorNotice {...history.error} retry={history.reload} /> : <>
      <div className="history-summary"><div><HistoryIcon size={20} aria-hidden="true" /><span>最近调用<strong>{runs.length}</strong></span></div><div><CheckCircle2 size={20} aria-hidden="true" /><span>执行成功<strong>{runs.filter(run => run.status === 'succeeded').length}</strong></span></div><div><XCircle size={20} aria-hidden="true" /><span>未成功<strong>{runs.filter(run => run.status !== 'succeeded').length}</strong></span></div></div>
      <Warnings warnings={history.data?.warnings ?? []} />
      <section className="panel history-panel"><div className="panel-heading"><div className="panel-title"><HistoryIcon size={18} aria-hidden="true" /><h2>最近运行</h2></div><span className="panel-step">LATEST ACTIVITY</span></div>
        {runs.length ? <div className="table-scroll" role="region" aria-label="运行摘要，可横向滚动" tabIndex={0}><table aria-label="运行摘要"><thead><tr>{['工具', '状态', '来源', '开始时间', '耗时', '运行 ID'].map(label => <th key={label} scope="col">{label}</th>)}</tr></thead><tbody>
          {runs.map(run => <HistoryRow key={run.runId} run={run} title={tools?.find(tool => tool.name === run.tool)?.title} />)}
        </tbody></table></div> : <EmptyState title="还没有执行记录" action={<a className="button button-primary" href="#/tools">去工具箱看看</a>}>运行一个工具后，摘要就会出现在这里。</EmptyState>}
      </section><p className="history-footnote">这里只保存运行摘要，不包含完整输入或结果。需要完整结果时，请在工具运行完成后下载。</p>
    </>}
  </div>;
}
