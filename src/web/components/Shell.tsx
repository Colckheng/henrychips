import { ArrowUpRight, Boxes, ChevronRight, Circle, History, LayoutGrid, LoaderCircle, PlugZap, SquareTerminal } from 'lucide-react';
import type { ReactNode } from 'react';
import { useEffect, useRef } from 'react';
import type { ToolDescription } from '../../contracts/tool.js';
import { useApi } from '../api.js';
import { categoryEntries } from '../presentation.js';
import { catalogLink, type Route } from '../router.js';
import { useRunEntries } from '../run-store.js';

const navigation = [
  { page: 'tools', label: '工具箱', icon: LayoutGrid },
  { page: 'runs', label: '执行记录', icon: History },
  { page: 'integrations', label: 'AI 接入', icon: PlugZap },
] as const;

function HealthStatus() {
  const health = useApi<{ status: string; version: string }>('/health');
  const healthy = health.data?.status === 'ok';
  return <div className={`health-status ${healthy ? 'is-healthy' : ''}`} role="status">
    <Circle size={7} fill="currentColor" aria-hidden="true" />
    <span>{health.loading ? '检查本地服务…' : healthy ? '本地服务可用' : '本地服务不可用'}</span>
    {healthy && <span className="health-version">v{health.data?.version}</span>}
    {!health.loading && !healthy && <button onClick={health.reload} className="text-button">重试</button>}
  </div>;
}

function RunningTasks() {
  const entries = useRunEntries();
  const running = entries.filter(entry => entry.status === 'running');
  if (!running.length) return null;
  return <div className="running-tasks" role="status" aria-live="polite">
    {running.map(entry => <a key={entry.requestId} className="running-task" href={`#/tools/${encodeURIComponent(entry.tool)}`}>
      <LoaderCircle size={13} className="spin" aria-hidden="true" />
      <span>{entry.progress?.phase ?? '正在运行'}</span>
      {entry.progress?.percent !== null && entry.progress?.percent !== undefined && <b>{entry.progress.percent}%</b>}
    </a>)}
  </div>;
}

export function Shell({ route, tools, children }: { route: Route; tools?: ToolDescription[]; children: ReactNode }) {
  const section = route.page === 'tool' ? 'tools' : route.page;
  const title = navigation.find(item => item.page === section)?.label ?? '页面未找到';
  const main = useRef<HTMLElement>(null);
  const previous = useRef(route.page === 'tool' ? `tool:${route.name}` : route.page);
  const current = route.page === 'tool' ? `tool:${route.name}` : route.page;
  useEffect(() => {
    document.title = `${title} · Henry 工作台`;
    if (previous.current !== current) { main.current?.focus(); window.scrollTo({ top: 0 }); }
    previous.current = current;
  }, [current, title]);
  return <div className="app-shell">
    <a className="skip-link" href="#main-content" onClick={event => { event.preventDefault(); main.current?.focus(); }}>跳至主要内容</a>
    <aside className="sidebar" aria-label="工作台侧栏">
      <a className="brand" href="#/tools" aria-label="Henry 工作台首页"><span className="brand-symbol"><Boxes size={24} strokeWidth={1.7} aria-hidden="true" /></span>
        <span><strong>Henry<span className="brand-dot">.</span></strong><small>个人工作台</small></span>
      </a>
      <div className="sidebar-section-label">WORKSPACE <span>工作空间</span></div>
      <nav className="main-nav" aria-label="主导航">{navigation.map(({ page, label, icon: Icon }) =>
        <a key={page} href={`#/${page}`} aria-current={section === page ? 'page' : undefined} className={section === page ? 'nav-link active' : 'nav-link'}>
          <Icon size={19} strokeWidth={1.7} aria-hidden="true" /><span>{label}</span>{section === page && <ChevronRight size={15} className="nav-chevron" aria-hidden="true" />}
        </a>)}</nav>
      <div className="sidebar-categories"><div className="sidebar-section-label">COLLECTIONS <span>工具分类</span></div>
        <nav aria-label="工具分类">{categoryEntries.map(([key, { label, icon: Icon }]) =>
          <a className={`category-nav ${route.page === 'tools' && route.category === key ? 'selected' : ''}`} key={key} href={catalogLink(key)}>
            <Icon size={16} strokeWidth={1.6} aria-hidden="true" /><span>{label}</span>
            {tools && <span className="category-count">{tools.filter(tool => tool.category === key).length}</span>}
          </a>)}</nav>
      </div>
      <div className="sidebar-bottom"><div className="sidebar-note"><SquareTerminal size={23} strokeWidth={1.5} aria-hidden="true" />
        <h3>让 AI 也用上你的工具</h3><p>通过 MCP 与命令行，把常用能力带进你的工作流。</p>
        <a href="#/integrations">查看接入方式 <ArrowUpRight size={15} aria-hidden="true" /></a>
      </div><div className="sidebar-footnote"><span className="sidebar-monogram">H</span><span>个人效率，自在掌控<small>PERSONAL WORKSTATION</small></span></div></div>
    </aside>
    <div className="workspace"><header className="topbar"><div className="breadcrumb"><span>工作空间</span><ChevronRight size={13} aria-hidden="true" /><strong>{title}</strong>
      {route.page === 'tool' && <><ChevronRight size={13} aria-hidden="true" /><span className="breadcrumb-detail">工具详情</span></>}
    </div><div className="topbar-actions"><RunningTasks /><HealthStatus /></div></header>
      <main id="main-content" className="main-content" ref={main} tabIndex={-1}>{children}</main>
      <footer className="workspace-footer"><span>Henry 工作台 <span className="footer-divider">/</span> 为专注而留白</span><span>本地工具 · 简单有序</span></footer>
    </div>
  </div>;
}
