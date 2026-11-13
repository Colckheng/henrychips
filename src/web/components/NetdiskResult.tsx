import type { ReactNode } from 'react';
import { isRecord } from '../api.js';
import { formatNumber } from '../presentation.js';
import { CopyButton } from './CopyButton.js';
import { DataTable, valueText } from './ResultData.js';

interface NetdiskFile { path: string; name: string; sizeBytes: number | null; isDirectory: boolean; modifiedAt?: string }
interface NetdiskLink { path: string; name: string; sizeBytes: number | null; url: string; headers?: Record<string, string>; rangeSupported?: boolean | null; note?: string }

/**
 * A value of a header or of a name goes into a quoted shell argument, so a
 * double quote inside it has to be escaped, or the command would end early
 * and send a wrong value.
 */
function shellValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/**
 * The command that downloads the file with the headers the platform insists
 * on. Without the Referer and the Cookie the server answers with an error
 * page instead of the file, so the headers travel with the command.
 */
export function curlCommand(link: NetdiskLink): string {
  const headers = Object.entries(link.headers ?? {})
    .map(([key, value]) => `-H "${shellValue(`${key}: ${value}`)}"`);
  return ['curl', '-L', ...headers, '-o', `"${shellValue(link.name)}"`, `"${shellValue(link.url)}"`].join(' ');
}

export function NetdiskResult({ data }: { data: Record<string, unknown> }) {
  const files = Array.isArray(data.files) ? data.files.filter(isRecord) as unknown as NetdiskFile[] : [];
  const links = Array.isArray(data.links) ? data.links.filter(isRecord) as unknown as NetdiskLink[] : [];
  const failures = Array.isArray(data.linkFailures) ? data.linkFailures.filter(isRecord) : [];
  const rows: ReactNode[][] = links.map(link => [
    valueText(link.name),
    formatNumber(link.sizeBytes),
    <code className="stream-url">{valueText(link.url)}</code>,
    <span className={`status-badge ${link.rangeSupported === false ? 'status-neutral' : 'status-success'}`}>
      {link.rangeSupported === false ? '不支持续传' : '支持续传'}</span>,
    <span style={{ display: 'inline-flex', flexDirection: 'column', alignItems: 'flex-start', gap: 6 }}>
      <CopyButton text={link.url} label="复制直链" />
      <CopyButton text={curlCommand(link)} label="复制 curl" />
    </span>,
  ]);
  return <div className="result-sections">
    <section><div className="result-section-heading"><h3>分享文件</h3><span>{files.length} 项</span></div>
      <DataTable label="分享文件列表" headers={['名称', '大小（字节）', '路径', '修改时间']} rows={files.map(file => [
        valueText(file.name), formatNumber(file.sizeBytes), valueText(file.path), valueText(file.modifiedAt),
      ])} />
    </section>
    {rows.length > 0 && <section><div className="result-section-heading"><h3>下载直链</h3><span>{rows.length} 条</span></div>
      <DataTable label="下载直链列表" headers={['名称', '大小（字节）', '直链', '续传', '操作']} rows={rows} />
      <p className="inline-note">直链通常在十几分钟内过期；「复制 curl」会带上 Referer、Cookie 等必须一起发送的请求头。</p>
    </section>}
    {failures.length > 0 && <section><div className="result-section-heading"><h3>取链失败</h3><span>{failures.length} 项</span></div>
      <DataTable label="取链失败列表" headers={['路径', '原因']} rows={failures.map(item => [valueText(item.path), valueText(item.reason)])} />
    </section>}
  </div>;
}
