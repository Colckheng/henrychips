import { ArrowUpRight, Braces, LayoutGrid, Search, SlidersHorizontal, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { ToolDescription } from '../../contracts/tool.js';
import { categoryEntries, categories } from '../presentation.js';
import { catalogLink } from '../router.js';
import { EmptyState, ErrorNotice, Loading } from '../components/Feedback.js';
import { ToolCard } from '../components/ToolCard.js';

export function Catalog({ tools, loading, error, reload, category, initialQuery }: {
  tools?: ToolDescription[]; loading: boolean; error?: { message: string; code?: string };
  reload: () => void; category: string; initialQuery: string;
}) {
  const [query, setQuery] = useState(initialQuery);
  useEffect(() => setQuery(initialQuery), [initialQuery]);
  const categoryKey = category in categories ? category : 'all';
  const needle = query.trim().toLocaleLowerCase();
  const filtered = (tools ?? []).filter(tool => (categoryKey === 'all' || tool.category === categoryKey)
    && `${tool.title} ${tool.name} ${tool.description} ${categories[tool.category].label}`.toLocaleLowerCase().includes(needle));
  const categoryCount = new Set(tools?.map(tool => tool.category)).size;
  const reset = () => { setQuery(''); window.location.hash = '/tools'; };
  return <div className="page catalog-page">
    <section className="catalog-hero" aria-labelledby="catalog-title"><div className="hero-copy"><div className="eyebrow"><span />YOUR EVERYDAY TOOLKIT</div>
      <h1 id="catalog-title">把琐事交给工具，<br /><span>把时间留给自己。</span></h1>
      <p>文件、文本、数据，以及更多。<br className="mobile-break" />常用能力，一个工作台就够了。</p>
      <div className="hero-facts"><span><strong>{tools ? String(tools.length).padStart(2, '0') : '—'}</strong> 个实用工具</span><i /><span><strong>{tools ? String(categoryCount).padStart(2, '0') : '—'}</strong> 类工作场景</span><i /><span className="hero-local">你的本地工作空间</span></div>
    </div><div className="hero-index" aria-hidden="true"><div className="index-heading"><Braces size={18} /><span>TOOL INDEX</span><small>01 — {tools ? String(tools.length).padStart(2, '0') : '…'}</small></div>
      <div className="index-grid">{categoryEntries.map(([key, { icon: Icon, label }], index) => <div key={key}><span className="index-number">0{index + 1}</span><Icon size={24} strokeWidth={1.3} /><span>{label}</span></div>)}</div>
      <div className="index-footer"><span>LESS FRICTION. MORE FOCUS.</span><ArrowUpRight size={17} /></div>
    </div></section>
    <section className="catalog-content" aria-labelledby="tool-list-title"><div className="section-heading"><div><span className="section-kicker">THE COLLECTION</span><h2 id="tool-list-title">工具箱 <span className="count-pill">{tools?.length ?? '—'}</span></h2></div>
      <div className="search-field"><Search size={17} aria-hidden="true" /><label className="sr-only" htmlFor="tool-search">搜索工具</label>
        <input id="tool-search" type="search" placeholder="搜索工具名称、功能…" value={query} onChange={event => setQuery(event.target.value)} />
        {query && <button aria-label="清空搜索" onClick={() => setQuery('')}><X size={16} aria-hidden="true" /></button>}
      </div>
    </div>
      <div className="catalog-toolbar"><div className="category-filters" role="group" aria-label="按分类筛选"><button aria-pressed={categoryKey === 'all'} onClick={() => { window.location.hash = catalogLink('all', query); }}><LayoutGrid size={14} aria-hidden="true" />全部工具</button>
        {categoryEntries.map(([key, { label }]) => <button key={key} aria-pressed={categoryKey === key} onClick={() => { window.location.hash = catalogLink(key, query); }}>{label}</button>)}
      </div><span className="filter-note"><SlidersHorizontal size={14} aria-hidden="true" />按工作场景</span></div>
      {loading ? <Loading label="正在读取工具目录…" /> : error ? <ErrorNotice {...error} retry={reload} /> : <>
        <p className="results-count" role="status">{needle || categoryKey !== 'all' ? `找到 ${filtered.length} 个工具` : '选一个工具，开始高效的一天。'}<span>{tools ? `${filtered.length} / ${tools.length}` : ''}</span></p>
        {filtered.length ? <div className="tools-grid">{filtered.map(tool => <ToolCard key={tool.name} tool={tool} />)}</div>
          : <EmptyState title={tools?.length ? '没有找到匹配的工具' : '暂时还没有可用工具'} action={<button className="button button-secondary" onClick={tools?.length ? reset : reload}>{tools?.length ? '清除筛选' : '重新加载'}</button>}>{tools?.length ? '换个关键词，或清除分类筛选再试试。' : '服务尚未返回工具，稍后刷新试试。'}</EmptyState>}
      </>}
    </section>
    <a className="integration-banner" href="#/integrations"><span className="banner-icon"><Braces size={23} strokeWidth={1.5} aria-hidden="true" /></span><span><strong>你的工具，也可以成为 AI 的能力。</strong><small>通过 MCP 接入 AI 客户端，或使用 CLI 在终端中直接调用。</small></span><span className="banner-action">探索 AI 接入 <ArrowUpRight size={17} aria-hidden="true" /></span></a>
  </div>;
}
