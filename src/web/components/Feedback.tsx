import { AlertCircle, Inbox, LoaderCircle, RotateCw, TriangleAlert } from 'lucide-react';
import type { ReactNode } from 'react';

export function Loading({ label = '正在加载…' }: { label?: string }) {
  return <div className="loading-state" role="status"><LoaderCircle className="spin" size={22} aria-hidden="true" /><span>{label}</span></div>;
}

export function ErrorNotice({ message, code, retry, retryLabel = '重试加载' }: {
  message: string; code?: string; retry?: () => void; retryLabel?: string;
}) {
  return <div className="notice notice-danger" role="alert">
    <AlertCircle size={19} aria-hidden="true" />
    <div className="notice-content"><strong>这次没能完成</strong><p>{message}</p>{code && <code className="error-code">{code}</code>}
      {retry && <button className="button button-small button-secondary" onClick={retry}><RotateCw size={14} aria-hidden="true" />{retryLabel}</button>}
    </div>
  </div>;
}

export function Warnings({ warnings }: { warnings: string[] }) {
  if (!warnings.length) return null;
  return <div className="notice notice-warning" role="status">
    <TriangleAlert size={18} aria-hidden="true" /><div className="notice-content"><strong>请留意</strong>
      <ul>{warnings.map((warning, index) => <li key={`${index}-${warning}`}>{warning}</li>)}</ul>
    </div>
  </div>;
}

export function EmptyState({ title, children, action }: { title: string; children: ReactNode; action?: ReactNode }) {
  return <div className="empty-state"><span className="empty-icon"><Inbox size={28} strokeWidth={1.5} aria-hidden="true" /></span>
    <h3>{title}</h3><p>{children}</p>{action}
  </div>;
}
