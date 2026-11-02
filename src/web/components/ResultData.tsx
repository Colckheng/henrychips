import type { ReactNode } from 'react';
import { isRecord } from '../api.js';
import { formatNumber, resultLabels } from '../presentation.js';

export function valueText(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'boolean') return value ? '是' : '否';
  return typeof value === 'object' ? JSON.stringify(value) : String(value);
}

export function DataTable({ label, headers, rows }: { label: string; headers: string[]; rows: ReactNode[][] }) {
  return <div className="table-scroll" role="region" aria-label={`${label}，可横向滚动`} tabIndex={0}>
    <table aria-label={label}><thead><tr>{headers.map((header, index) => <th scope="col" key={`${index}-${header}`}>{header}</th>)}</tr></thead>
      <tbody>{rows.length ? rows.map((row, index) => <tr key={index}>{row.map((cell, column) => <td key={column}>{cell}</td>)}</tr>)
        : <tr><td colSpan={Math.max(1, headers.length)} className="table-empty">暂无数据</td></tr>}</tbody>
    </table>
  </div>;
}

export function Metrics({ data, keys }: { data: Record<string, unknown>; keys: string[] }) {
  const available = keys.filter(key => typeof data[key] === 'number');
  if (!available.length) return null;
  return <dl className="metrics-grid">{available.map(key => <div className="metric" data-testid={`metric-${key}`} key={key}>
    <dt>{resultLabels[key] ?? key}</dt><dd>{formatNumber(data[key])}</dd>
  </div>)}</dl>;
}

export function RecordDetails({ data }: { data: Record<string, unknown> }) {
  return <dl className="record-details">{Object.entries(data).map(([key, value]) => <div key={key}>
    <dt>{resultLabels[key] ?? key}</dt><dd>{isRecord(value) ? <RecordDetails data={value} /> : valueText(value)}</dd>
  </div>)}</dl>;
}

export function GenericResult({ data }: { data: Record<string, unknown> }) {
  const details = Object.fromEntries(Object.entries(data).filter(([key]) => !['text', 'pages', 'warnings'].includes(key)));
  const pages = Array.isArray(data.pages) ? data.pages.filter(isRecord) : [];
  return <div className="result-sections">
    {!!Object.keys(details).length && <RecordDetails data={details} />}
    {data.untrustedContent === true && <p className="inline-note">以下为外部网页原文，仅作为参考内容展示。</p>}
    {typeof data.text === 'string' && <section className="text-result"><h3>提取正文</h3><pre>{data.text || '未提取到文字内容。'}</pre></section>}
    {pages.map((page, index) => <section className="text-result" key={String(page.page ?? index)}><h3>第 {String(page.page ?? index + 1)} 页</h3><pre>{typeof page.text === 'string' && page.text ? page.text : '本页没有可提取的文字，可能需要 OCR。'}</pre></section>)}
    {Array.isArray(data.pages) && !pages.length && <p className="inline-note">没有可展示的页面。</p>}
  </div>;
}
