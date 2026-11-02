import { CheckCheck, CheckCircle2, Code2, Download, Eye, FolderOpen, LoaderCircle, SquareDashedBottomCode } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { ToolResult } from '../../contracts/run.js';
import { isRecord, openOutputFolder } from '../api.js';
import type { RunProgress } from '../api.js';
import { formatDuration, formatNumber } from '../presentation.js';
import { CopyButton } from './CopyButton.js';
import { CsvResult } from './CsvResult.js';
import { FilesResult } from './FilesResult.js';
import { EmptyState, ErrorNotice, Warnings } from './Feedback.js';
import { DataTable, GenericResult, Metrics, valueText } from './ResultData.js';

function MediaStreams({ data }: { data: Record<string, unknown> }) {
  const streams = Array.isArray(data.streams) ? data.streams.filter(isRecord) : [];
  if (!streams.length) return null;
  return <section><div className="result-section-heading"><h3>媒体流</h3><span>{streams.length} 条</span></div>
    <DataTable label="媒体流列表" headers={['类型', '名称', '编码', '大小（字节）', '直链']} rows={streams.map(stream => [
      stream.kind === 'audio' ? '音频' : '视频',
      valueText(stream.label),
      valueText(stream.codecs),
      formatNumber(stream.sizeBytes),
      <code className="stream-url">{valueText(stream.url)}</code>,
    ])} />
  </section>;
}

function ResultView({ tool, data }: { tool: string; data: Record<string, unknown> }) {
  if (tool === 'csv_summary') return <CsvResult data={data} />;
  if (tool === 'files_plan') return <FilesResult data={data} />;
  if (tool === 'text_stats') return <><Metrics data={data} keys={['characters', 'charactersWithoutWhitespace', 'lines', 'hanCharacters', 'latinWords']} /><p className="inline-note">字符按 Unicode 码点统计；拉丁词数不代表通用分词结果。</p></>;
  if (tool === 'bilibili_video') return <MediaStreams data={data} />;
  return <GenericResult data={data} />;
}

function ProgressView({ progress }: { progress: RunProgress }) {
  const percent = progress.percent;
  const width = percent === null ? '100%' : `${percent}%`;
  return <div className="progress-view">
    <div className="progress-head" aria-live="polite"><span className="progress-phase">{progress.phase}</span>
      <span className="progress-percent">{percent === null ? '处理中' : `${percent}%`}</span></div>
    <div className="progress-track"><div className={percent === null ? 'progress-fill is-indeterminate' : 'progress-fill'} style={{ width }} /></div>
    {progress.steps.length > 1 && <ol className="progress-steps">{progress.steps.slice(-5).map((step, index) => (
      <li key={`${step.at}-${index}`}><span>{step.phase}</span><span>{step.percent === null ? '' : `${step.percent}%`}</span></li>))}</ol>}
  </div>;
}

function OutputFolderButton() {
  const [state, setState] = useState<'idle' | 'opened' | 'failed'>('idle');
  const [message, setMessage] = useState('');
  async function open() {
    const result = await openOutputFolder();
    if (result.opened) { setState('opened'); setMessage('已在文件管理器中打开输出目录。'); }
    else { setState('failed'); setMessage(result.message ?? '无法打开输出目录。'); }
  }
  return <div className="output-folder">
    <button type="button" className="button button-secondary button-small" onClick={() => void open()}>
      <FolderOpen size={15} aria-hidden="true" />打开输出文件夹
    </button>
    {message && <span className={state === 'opened' ? 'output-folder-note' : 'output-folder-note is-error'} role="status">{message}</span>}
  </div>;
}

export function ResultPanel({ tool, result, status, error, retry, progress, restored, onRestore }: {
  tool: string; result?: ToolResult; status: 'idle' | 'running' | 'done' | 'cancelled';
  error?: { message: string; code?: string }; retry: () => void; progress?: RunProgress;
  restored?: boolean; onRestore?: () => void;
}) {
  const [view, setView] = useState<'preview' | 'json'>('preview');
  const [downloadError, setDownloadError] = useState(false);
  useEffect(() => { setView('preview'); setDownloadError(false); }, [result]);
  const json = result ? JSON.stringify(result, null, 2) : '';
  const extraWarnings = result?.ok && Array.isArray(result.data.warnings) ? result.data.warnings.filter((item): item is string => typeof item === 'string') : [];
  const warnings = [...new Set([...(result?.meta.warnings ?? []), ...extraWarnings])];
  function download() {
    if (!result) return;
    try {
      const url = URL.createObjectURL(new Blob([json], { type: 'application/json;charset=utf-8' }));
      const link = document.createElement('a');
      link.href = url; link.download = `${tool}-${result.meta.runId.replace(/[^a-zA-Z0-9_-]/g, '_')}.json`;
      document.body.appendChild(link); link.click(); link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setDownloadError(false);
    } catch { setDownloadError(true); }
  }
  return <section className="panel result-panel" aria-labelledby="result-title" aria-busy={status === 'running'}>
    <div className="panel-heading"><div className="panel-title"><SquareDashedBottomCode size={18} aria-hidden="true" /><h2 id="result-title">运行结果</h2></div>
      {result?.ok && <span className="status-badge status-success"><CheckCheck size={13} aria-hidden="true" />已完成</span>}
    </div>
    <div className="result-body">
      {status === 'running' && <div className="running-state" role="status">
        {progress ? <ProgressView progress={progress} /> : <><span className="running-orbit"><LoaderCircle size={26} className="spin" aria-hidden="true" /></span><h3>工具正在处理中</h3><p>结果会显示在这里，你也可以随时取消等待。</p></>}
      </div>}
      {status === 'cancelled' && <div role="status"><EmptyState title="已取消等待">当前请求已中止。实际执行状态可在执行记录中查看。</EmptyState></div>}
      {status === 'idle' && <EmptyState title="准备好了，运行看看">填写左侧参数，或从一个示例开始。<br />结果、数据预览和导出都会出现在这里。
        {onRestore && <button className="button button-secondary button-small" onClick={onRestore}>查看上次运行结果</button>}</EmptyState>}
      {error && <ErrorNotice {...error} retry={retry} retryLabel="重试运行" />}
      {result && status !== 'cancelled' && <>
        {result.ok ? <div className="result-success" role="status"><CheckCircle2 size={17} aria-hidden="true" /><strong>执行成功</strong><span>{formatDuration(result.meta.durationMs)}</span>{restored && <em>上次运行的结果</em>}</div>
          : <><ErrorNotice message={result.error.message} code={result.error.code} retry={retry} retryLabel="重试运行" />
            {!!result.error.details?.length && <ul className="validation-list">{result.error.details.map((detail, index) => <li key={index}><code>{detail.path}</code>：{detail.message}</li>)}</ul>}</>}
        <Warnings warnings={warnings} />
        <div className="result-toolbar"><div className="segmented-control" role="group" aria-label="结果显示方式"><button aria-pressed={view === 'preview'} onClick={() => setView('preview')}><Eye size={14} aria-hidden="true" />预览</button><button aria-pressed={view === 'json'} onClick={() => setView('json')} aria-label="JSON 视图"><Code2 size={14} aria-hidden="true" />JSON</button></div>
          <div className="result-actions"><CopyButton text={json} label="复制结果" /><button className="button button-secondary button-small" onClick={download}><Download size={14} aria-hidden="true" />下载 JSON</button></div>
        </div>
        {downloadError && <ErrorNotice message="下载未能开始，请重试，或复制完整 JSON。" retry={download} retryLabel="重试下载" />}
        {view === 'json' ? <pre className="code-block result-json" tabIndex={0} data-testid="result-json">{json}</pre>
          : result.ok ? <ResultView tool={tool} data={result.data} /> : <p className="inline-note">参数已保留，可修改后重试；完整错误信息可在 JSON 视图中查看。</p>}
        <div className="result-meta"><span>RUN ID</span><code>{result.meta.runId}</code><span>{result.meta.source}</span></div>
        <OutputFolderButton />
      </>}
    </div>
  </section>;
}
