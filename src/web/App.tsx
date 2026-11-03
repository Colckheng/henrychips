import { Component, type ErrorInfo, type ReactNode } from 'react';
import type { ToolDescription } from '../contracts/tool.js';
import { useApi } from './api.js';
import { useRoute } from './router.js';
import { Shell } from './components/Shell.js';
import { EmptyState } from './components/Feedback.js';
import { Catalog } from './pages/Catalog.js';
import { History } from './pages/History.js';
import { Integrations } from './pages/Integrations.js';
import { Servers } from './pages/Servers.js';
import { ToolDetail } from './pages/ToolDetail.js';

class PageBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(_error: Error, _info: ErrorInfo) { /* The fallback keeps navigation usable. */ }
  render() {
    if (this.state.failed) return <div role="alert"><EmptyState title="页面暂时无法显示" action={<button className="button button-secondary" onClick={() => this.setState({ failed: false })}>重新加载页面</button>}>服务返回的数据可能不完整，请重试或返回工具箱。</EmptyState></div>;
    return this.props.children;
  }
}

export default function App() {
  const route = useRoute();
  const catalog = useApi<ToolDescription[]>('/tools');
  const routeKey = route.page === 'tool' ? `tool:${route.name}` : route.page;
  let content: ReactNode;
  if (route.page === 'tools') content = <Catalog tools={catalog.data} loading={catalog.loading} error={catalog.error} reload={catalog.reload} category={route.category} initialQuery={route.query} />;
  else if (route.page === 'tool') content = <ToolDetail key={route.name} name={route.name} example={route.example} />;
  else if (route.page === 'runs') content = <History tools={catalog.data} />;
  else if (route.page === 'integrations') content = <Integrations />;
  else if (route.page === 'servers') content = <Servers />;
  else content = <EmptyState title="没有找到这个页面" action={<a className="button button-primary" href="#/tools">返回工具箱</a>}>这个地址可能已经变化，回到工具箱继续吧。</EmptyState>;
  return <Shell route={route} tools={catalog.data}><PageBoundary key={routeKey}>{content}</PageBoundary></Shell>;
}
