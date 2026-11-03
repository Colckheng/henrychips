import { useEffect, useState } from 'react';
import { CheckCircle2, CircleDashed, Copy, FileCode2, Server, Terminal, Wifi, WifiOff } from 'lucide-react';
import type { RelayStatus } from '../../contracts/relay.js';
import { useApi } from '../api.js';
import { CopyButton } from '../components/CopyButton.js';
import { ErrorNotice, Loading } from '../components/Feedback.js';

function relativeTime(timestamp: number, now: number): string {
  if (!timestamp) return '未知';
  const seconds = Math.round((now - timestamp) / 1000);
  if (seconds < 60) return `${seconds} 秒前`;
  if (seconds < 3600) return `${Math.round(seconds / 60)} 分钟前`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)} 小时前`;
  return `${Math.round(seconds / 86400)} 天前`;
}

export function Servers() {
  const status = useApi<RelayStatus>('/relay/status');
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);
  const info = status.data;
  return <div className="page servers-page">
    <header className="page-header"><div><div className="eyebrow">CONNECT YOUR DEVICES</div><h1>服务器</h1><p>把工作台接入服务器，让手机与其他设备通过它调用同一批工具。</p></div>
      <span className="page-header-icon"><Server size={29} strokeWidth={1.5} aria-hidden="true" /></span></header>
    {status.loading ? <Loading label="正在读取服务器配置…" /> : status.error ? <ErrorNotice {...status.error} retry={status.reload} /> : info && <>
      <div className="relay-status">
        <div className="relay-card">
          <div className="relay-card-head"><Wifi size={18} aria-hidden="true" /><h2>中继连接</h2>
            <span className={`status-badge ${info.connected ? 'status-success' : 'status-warning'}`}>
              {info.connected ? <CheckCircle2 size={13} aria-hidden="true" /> : <CircleDashed size={13} aria-hidden="true" />}
              {info.connected ? '节点在线' : info.configured ? '节点离线' : '未配置'}</span></div>
          {info.configured ? <>
            <dl className="relay-fields">
              <div><dt>中继地址</dt><dd><code>{info.address}</code></dd></div>
              <div><dt>本机设备名</dt><dd>{info.deviceName}</dd></div>
              <div><dt>设备标识</dt><dd><code>{info.deviceId}</code></dd></div>
            </dl>
            {info.connected
              ? <p className="inline-note">节点连接器正在运行，其他设备可以把这台工作站当作执行节点。</p>
              : <p className="inline-note">节点连接器未运行，手机端暂时无法派发任务给这台设备。在项目目录执行 <code>npm run relay:node</code> 即可上线。</p>}
          </> : <p className="inline-note">还没有绑定服务器。在项目目录执行：<code>npm run relay:pair -- &lt;中继地址&gt; &lt;配对码&gt; [设备名]</code>，凭据会写入配置文件。</p>}
        </div>
        <div className="relay-card">
          <div className="relay-card-head"><Terminal size={18} aria-hidden="true" /><h2>快速命令</h2></div>
          <div className="cli-commands">
            <div className="cli-command"><span className="terminal-prompt" aria-hidden="true">$</span><code>npm run relay:pair -- &lt;地址&gt; &lt;配对码&gt;</code><CopyButton text="npm run relay:pair -- <地址> <配对码>" label="复制配对命令" className="icon-button" /></div>
            <div className="cli-command"><span className="terminal-prompt" aria-hidden="true">$</span><code>npm run relay:node</code><CopyButton text="npm run relay:node" label="复制连接命令" className="icon-button" /></div>
            <div className="cli-command"><span className="terminal-prompt" aria-hidden="true">$</span><code>npm run relay:serve -- relay.config.json</code><CopyButton text="npm run relay:serve -- relay.config.json" label="复制服务命令" className="icon-button" /></div>
          </div>
        </div>
      </div>
      <section className="panel" aria-labelledby="devices-title">
        <div className="panel-heading"><div className="panel-title"><Server size={18} aria-hidden="true" /><h2 id="devices-title">已连接设备</h2></div><span className="panel-step">{info.devices.length} 台</span></div>
        {info.devices.length ? <div className="table-scroll" role="region" aria-label="设备列表，可横向滚动" tabIndex={0}><table aria-label="设备列表"><thead><tr>
          {['设备', '状态', '可用工具', '最近在线', '设备标识'].map(label => <th key={label} scope="col">{label}</th>)}</tr></thead>
          <tbody>{info.devices.map(device => <tr key={device.id}>
            <td>{device.name}{device.id === info.deviceId ? <span className="source-badge">本机</span> : null}</td>
            <td><span className={`status-badge ${device.online ? 'status-success' : 'status-neutral'}`}>{device.online ? <Wifi size={12} aria-hidden="true" /> : <WifiOff size={12} aria-hidden="true" />}{device.online ? '在线' : '离线'}</span></td>
            <td className="numeric-cell">{device.tools}</td>
            <td>{relativeTime(device.lastSeen, now)}</td>
            <td><code>{device.id.slice(0, 8)}</code></td>
          </tr>)}</tbody></table></div> : <p className="inline-note">中继还没有登记任何设备。</p>}
      </section>
      {info.runs.length > 0 && <section className="panel" aria-labelledby="runs-title">
        <div className="panel-heading"><div className="panel-title"><FileCode2 size={18} aria-hidden="true" /><h2 id="runs-title">跨设备运行记录</h2></div><span className="panel-step">最近 {info.runs.length} 条</span></div>
        <div className="table-scroll" role="region" aria-label="运行记录，可横向滚动" tabIndex={0}><table aria-label="运行记录"><thead><tr>
          {['工具', '设备', '状态', '时间'].map(label => <th key={label} scope="col">{label}</th>)}</tr></thead>
          <tbody>{info.runs.map(run => <tr key={run.id}>
            <td><code>{run.tool}</code></td><td>{run.deviceName}</td>
            <td><span className={`status-badge ${run.status === 'succeeded' ? 'status-success' : 'status-warning'}`}>{run.status}</span></td>
            <td>{new Date(run.startedAt).toLocaleString('zh-CN')}</td>
          </tr>)}</tbody></table></div>
      </section>}
      <section className="panel" aria-labelledby="ai-title">
        <div className="panel-heading"><div className="panel-title"><Copy size={18} aria-hidden="true" /><h2 id="ai-title">给 AI 的使用说明</h2></div><span className="panel-step">AI ACCESS</span></div>
        <div className="integration-body">
          <p className="integration-intro">这段说明可以直接粘给 AI，让它通过服务器调用你设备上的工具。</p>
          <div className="code-window"><div className="code-window-heading"><span><FileCode2 size={14} aria-hidden="true" />relay-usage</span>
            <CopyButton text={info.aiUsage} label="复制 AI 使用说明" /></div>
            <pre className="code-block" data-testid="relay-ai-usage" tabIndex={0}>{info.aiUsage}</pre></div>
        </div>
      </section>
    </>}
  </div>;
}
