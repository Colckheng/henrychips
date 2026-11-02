import { ArrowLeft, ArrowUpRight, FlaskConical, LoaderCircle, Play, RotateCcw, Settings2, ShieldCheck, Square } from 'lucide-react';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { ToolDescription } from '../../contracts/tool.js';
import { useApi } from '../api.js';
import { initialValues, propertiesOf, requiredFields, serializeInput } from '../form.js';
import { categories, capabilityLabels } from '../presentation.js';
import { useToolRun } from '../useToolRun.js';
import { ErrorNotice, Loading } from '../components/Feedback.js';
import { FormField } from '../components/FormField.js';
import { ResultPanel } from '../components/ResultPanel.js';

function ToolWorkbench({ tool, example }: { tool: ToolDescription; example: boolean }) {
  const [values, setValues] = useState(() => initialValues(tool, example ? tool.examples[0]?.input : undefined));
  const appliedExample = useRef(false);
  const [formNote, setFormNote] = useState('');
  const form = useRef<HTMLFormElement>(null);
  const execution = useToolRun(tool.name);
  const category = categories[tool.category];
  const Icon = category.icon;
  const properties = propertiesOf(tool);
  const required = requiredFields(tool);
  const busy = execution.status === 'running';
  useEffect(() => {
    if (example && !appliedExample.current) { appliedExample.current = true; setValues(initialValues(tool, tool.examples[0]?.input)); setFormNote(`已填入示例：${tool.examples[0]?.label ?? '示例'}`); }
  }, [example, tool]);
  const details = execution.result && !execution.result.ok ? execution.result.error.details : undefined;
  const retry = () => form.current?.requestSubmit();
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFormNote('');
    void execution.run(serializeInput(tool, values));
  }
  return <div className="page detail-page">
    <a className="back-link" href="#/tools"><ArrowLeft size={15} aria-hidden="true" />返回工具箱</a>
    <header className="detail-header"><span className={`tool-icon tool-icon-large tone-${category.tone}`}><Icon size={30} strokeWidth={1.5} aria-hidden="true" /></span><div>
      <div className="detail-eyebrow"><span>{category.label}</span><code>{tool.name}</code></div><h1>{tool.title}</h1><p>{tool.description}</p>
    </div></header>
    <div className="detail-layout"><div className="input-column"><section className="panel" aria-labelledby="parameters-title">
      <div className="panel-heading"><div className="panel-title"><Settings2 size={18} aria-hidden="true" /><h2 id="parameters-title">输入参数</h2></div><span className="panel-step">01 / INPUT</span></div>
      <form ref={form} onSubmit={submit} className="tool-form"><fieldset><legend className="sr-only">工具参数</legend>
        {tool.examples.length > 0 && <div className="example-picker"><span><FlaskConical size={15} aria-hidden="true" />从示例开始</span><div>{tool.examples.map((item, index) => <button type="button" className="example-button" key={`${index}-${item.label}`} aria-label={`填入示例：${item.label}`} onClick={() => { setValues(initialValues(tool, item.input)); setFormNote(`已填入示例：${item.label}`); }}>{item.label}<ArrowUpRight size={13} aria-hidden="true" /></button>)}</div></div>}
        <div className="fields-grid">{tool.fields.length ? tool.fields.map(field => <FormField key={field.name} field={field} schema={properties[field.name]} required={required.includes(field.name)} value={values[field.name] ?? ''}
          error={details?.find(detail => detail.path === field.name || detail.path === `input.${field.name}` || detail.path === `/${field.name}`)?.message}
          onChange={value => setValues(previous => ({ ...previous, [field.name]: value }))} />)
          : <p className="no-parameters">这个工具无需填写参数，直接运行即可。</p>}</div>
      </fieldset>
        <div className="form-note" role="status">{formNote}</div>
        <div className="form-actions"><button type="submit" className="button button-primary run-button" disabled={busy}>{busy ? <LoaderCircle size={16} className="spin" aria-hidden="true" /> : <Play size={15} fill="currentColor" aria-hidden="true" />}{busy ? '正在运行…' : '运行工具'}</button>
          {busy ? <button className="button button-secondary" type="button" onClick={execution.cancel}><Square size={13} aria-hidden="true" />取消运行</button>
            : <button className="button button-quiet" type="button" onClick={() => { setValues(initialValues(tool)); setFormNote('已恢复默认参数'); }}><RotateCcw size={15} aria-hidden="true" />重置</button>}
        </div>
      </form>
    </section><aside className="capability-note"><ShieldCheck size={19} aria-hidden="true" /><div><h3>本次工具能力</h3><p>{tool.capabilities.length ? tool.capabilities.map(capability => capabilityLabels[capability] ?? capability).join(' · ') : '无需访问文件、网络或外部进程。'}</p>{tool.fields.some(field => field.type === 'relative-path') && <small>文件路径以已配置的本地工作区为起点。</small>}</div></aside></div>
      <ResultPanel tool={tool.name} result={execution.result} status={execution.status} error={execution.error} retry={retry} progress={execution.progress} restored={execution.restored} onRestore={execution.hasPrevious ? execution.restore : undefined} />
    </div>
  </div>;
}

export function ToolDetail({ name, example }: { name: string; example: boolean }) {
  const metadata = useApi<ToolDescription>(`/tools/${encodeURIComponent(name)}`);
  if (metadata.loading) return <Loading label="正在加载工具参数…" />;
  if (metadata.error) return <div className="page"><a className="back-link" href="#/tools"><ArrowLeft size={15} aria-hidden="true" />返回工具箱</a><ErrorNotice {...metadata.error} retry={metadata.reload} /></div>;
  return metadata.data ? <ToolWorkbench key={metadata.data.name} tool={metadata.data} example={example} /> : null;
}
