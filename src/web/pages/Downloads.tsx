import { Download, FolderOpen, Pause, Play, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { fetchDownloads, openOutputFolder, pauseDownload, removeDownload, resumeDownload, subscribeDownloads, type DownloadTaskView } from '../api.js';
import { EmptyState, ErrorNotice, Loading } from '../components/Feedback.js';
import { DataTable } from '../components/ResultData.js';
import { formatDate, formatNumber } from '../presentation.js';

const statusLabels: Record<string, string> = {
  queued: '排队中', preparing: '准备中', downloading: '下载中', verifying: '校验中',
  completed: '已完成', paused: '已暂停', failed: '失败', cancelled: '已取消', handed_off: '已交给下载器',
};

/** The tasks that are still moving; the finished ones wait in the table. */
const activeStatuses = new Set(['queued', 'preparing', 'downloading', 'verifying']);
/** The tasks that can be picked up again; the manager accepts these two only. */
const resumableStatuses = new Set(['paused', 'failed']);

function progressText(task: DownloadTaskView): string {
  if (!task.totalBytes) return '—';
  return `${Math.min(100, Math.round((task.bytesWritten / task.totalBytes) * 100))}%`;
}

export function Downloads() {
  const [tasks, setTasks] = useState<DownloadTaskView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [note, setNote] = useState('');
  useEffect(() => {
    let active = true;
    // The first list arrives on its own, so the page shows the tasks even
    // when the event stream is not available.
    void fetchDownloads().then(next => {
      if (!active) return;
      setTasks(next);
      setLoading(false);
    }).catch((cause: unknown) => {
      if (!active) return;
      setError(cause instanceof Error ? cause.message : '无法读取下载任务。');
      setLoading(false);
    });
    const stop = subscribeDownloads(next => {
      if (!active) return;
      setTasks(next);
      setLoading(false);
      setError(undefined);
    });
    return () => { active = false; stop(); };
  }, []);
  async function act(action: () => Promise<boolean>, message: string) {
    setNote('');
    try {
      const done = await action();
      setNote(done ? message : '这个任务现在不接受该操作。');
    } catch (cause) { setError(cause instanceof Error ? cause.message : '操作没有生效，请稍后重试。'); }
  }
  if (loading) return <Loading label="正在读取下载任务" />;
  return <div className="page downloads-page">
    <header className="page-header"><div><div className="eyebrow">DOWNLOAD QUEUE</div><h1>下载任务</h1><p>网盘直链的下载在这里排队、续传与收尾。</p></div>
      <button type="button" className="button button-secondary" onClick={() => void openOutputFolder()}>
        <FolderOpen size={16} aria-hidden="true" />打开输出文件夹
      </button></header>
    <section className="panel">
      <div className="panel-heading"><div className="panel-title"><Download size={18} aria-hidden="true" /><h2>任务列表</h2></div>
        <span className="panel-step">{tasks.length} 个任务</span></div>
      {error && <ErrorNotice message={error} />}
      {note && <p className="inline-note" role="status">{note}</p>}
      {!error && !tasks.length && <EmptyState title="还没有下载任务">在网盘解析结果里选择文件后即可开始下载。</EmptyState>}
      {tasks.length > 0 && <DataTable label="下载任务列表" headers={['文件', '平台', '状态', '进度', '速度', '更新时间', '操作']} rows={tasks.map(task => [
        <span className="download-task-name">{task.fileName}<code className="history-tool-id">{task.filePath}</code></span>,
        task.platform,
        <span className={`status-badge ${task.status === 'completed' ? 'status-success' : task.status === 'failed' ? 'status-danger' : 'status-neutral'}`}>
          {statusLabels[task.status] ?? task.status}</span>,
        progressText(task),
        task.speedBytesPerSecond ? <span className="numeric-cell">{formatNumber(task.speedBytesPerSecond)} B/s</span> : '—',
        <time dateTime={task.updatedAt}>{formatDate(task.updatedAt)}</time>,
        <span style={{ display: 'inline-flex', gap: 6 }}>
          {activeStatuses.has(task.status)
            ? <button type="button" className="button button-secondary button-small" onClick={() => void act(() => pauseDownload(task.id), '任务已暂停。')}><Pause size={14} aria-hidden="true" />暂停</button>
            : resumableStatuses.has(task.status)
              ? <button type="button" className="button button-secondary button-small" onClick={() => void act(() => resumeDownload(task.id), '任务已重新排队。')}><Play size={14} aria-hidden="true" />继续</button>
              : null}
          <button type="button" className="button button-secondary button-small" onClick={() => void act(() => removeDownload(task.id), '任务已删除。')}><Trash2 size={14} aria-hidden="true" />删除</button>
        </span>,
      ])} />}
      {tasks.some(task => task.error) && <p className="inline-note">{tasks.filter(task => task.error).map(task => `${task.fileName}：${task.error?.message}`).join(' ')}</p>}
    </section>
  </div>;
}
