import { ArrowRight, FlaskConical, ShieldCheck } from 'lucide-react';
import type { ToolDescription } from '../../contracts/tool.js';
import { capabilityLabels, categories } from '../presentation.js';

export function ToolCard({ tool }: { tool: ToolDescription }) {
  const category = categories[tool.category];
  const Icon = category.icon;
  const href = `#/tools/${encodeURIComponent(tool.name)}`;
  return <article className="tool-card" data-testid="tool-card">
    <div className="tool-card-top"><span className={`tool-icon tone-${category.tone}`}><Icon size={25} strokeWidth={1.6} aria-hidden="true" /></span><span className="category-tag">{category.label}</span></div>
    <a className="tool-title-link" href={href}><h3>{tool.title}<ArrowRight size={17} aria-hidden="true" /></h3></a>
    <p className="tool-description">{tool.description}</p>
    <div className="tool-capabilities">{tool.capabilities.length ? tool.capabilities.map(capability =>
      <span key={capability}><ShieldCheck size={12} aria-hidden="true" />{capabilityLabels[capability] ?? capability}</span>) : <span><ShieldCheck size={12} aria-hidden="true" />无需外部访问</span>}
    </div>
    <div className="tool-card-bottom"><code>{tool.name}</code>{tool.examples.length > 0
      ? <a href={`${href}?example=1`} aria-label={`填入示例：${tool.title}`}><FlaskConical size={14} aria-hidden="true" />试用示例</a>
      : <a href={href}>打开工具<ArrowRight size={14} aria-hidden="true" /></a>}
    </div>
  </article>;
}
