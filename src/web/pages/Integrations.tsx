import { ArrowRight, CheckCircle2, CircleDashed, Code2, FileCode2, FolderOpen, PlugZap, SquareTerminal } from 'lucide-react';
import type { IntegrationInfo } from '../../contracts/tool.js';
import { useApi } from '../api.js';
import { CopyButton } from '../components/CopyButton.js';
import { ErrorNotice, Loading } from '../components/Feedback.js';

export function Integrations() {
  const integration = useApi<IntegrationInfo>('/integrations');
  const info = integration.data;
  return <div className="page integrations-page"><header className="page-header"><div><div className="eyebrow">CONNECT YOUR WORKFLOW</div><h1>AI 接入</h1><p>同一套工具，在网页、AI 客户端和终端中随手调用。</p></div><span className="page-header-icon"><PlugZap size={29} strokeWidth={1.5} aria-hidden="true" /></span></header>
    {integration.loading ? <Loading label="正在读取接入配置…" /> : integration.error ? <ErrorNotice {...integration.error} retry={integration.reload} /> : info && <>
      <div className="integration-overview"><div><FolderOpen size={18} aria-hidden="true" /><span><small>当前工作区</small><code>{info.workspaceRoot}</code></span></div>
        <div><FileCode2 size={18} aria-hidden="true" /><span><small>配置文件</small><code>{info.configPath}</code></span></div><div className="network-state"><span className="status-badge status-neutral">公开网络访问：{info.networkEnabled ? '已启用' : '已禁用'}</span></div>
      </div>
      <div className="integration-layout"><section className="panel mcp-panel" aria-labelledby="mcp-title"><div className="panel-heading"><div className="panel-title"><PlugZap size={19} aria-hidden="true" /><h2 id="mcp-title">MCP 配置</h2></div><span className="panel-step">01 / AI CLIENT</span></div>
        <div className="integration-body"><div className="integration-statuses"><span className={`status-badge ${info.mcp.buildReady ? 'status-success' : 'status-warning'}`}>{info.mcp.buildReady ? <CheckCircle2 size={13} aria-hidden="true" /> : <CircleDashed size={13} aria-hidden="true" />}{info.mcp.buildReady ? '构建产物已就绪' : '构建产物尚未就绪'}</span>
          <span className="status-badge status-neutral">客户端连接尚未验证</span></div>
          <p className="integration-intro">将下方配置添加到支持 MCP 的 AI 客户端。配置来自当前本地服务，可直接复制使用。</p>
          {!info.mcp.buildReady && <p className="inline-note">请先在项目目录完成构建，再启动客户端中的 MCP 服务。</p>}
          <div className="code-window"><div className="code-window-heading"><span><FileCode2 size={14} aria-hidden="true" />mcp.config</span><CopyButton text={JSON.stringify(info.mcp.config, null, 2)} label="复制 MCP 配置" /></div><pre className="code-block" data-testid="mcp-config" tabIndex={0}>{JSON.stringify(info.mcp.config, null, 2)}</pre></div>
          <ol className="connection-steps"><li><span>01</span><div><strong>复制配置</strong><p>使用上方按钮复制完整 JSON。</p></div></li><li><span>02</span><div><strong>添加到客户端</strong><p>在客户端的 MCP 配置中合并此配置，保留你已有的服务。</p></div></li><li><span>03</span><div><strong>在客户端验证</strong><p>重新加载 MCP 服务并查看工具列表。此页面不能确认客户端连接状态。</p></div></li></ol>
        </div></section>
        <div className="integration-side"><section className="panel" aria-labelledby="cli-title"><div className="panel-heading"><div className="panel-title"><SquareTerminal size={18} aria-hidden="true" /><h2 id="cli-title">命令行调用</h2></div><span className="panel-step">02 / CLI</span></div>
          <div className="integration-body"><p className="integration-intro">在项目目录的终端中运行。以下命令由本地服务提供。</p><div className="cli-commands" data-testid="cli-commands">{info.cli.map((command, index) => <div className="cli-command" key={`${index}-${command}`}><span className="terminal-prompt" aria-hidden="true">$</span><code>{command}</code><CopyButton text={command} label={`复制命令 ${index + 1}`} className="icon-button" /></div>)}</div>
            {!info.cli.length && <p className="inline-note">服务尚未提供 CLI 示例。</p>}
          </div></section>
          <section className="extension-note"><Code2 size={24} strokeWidth={1.5} aria-hidden="true" /><h2>让工具箱继续生长</h2><p>添加工具描述、输入规则和执行逻辑，注册后即可共享到网页、CLI 与 MCP。</p><div className="extension-flow"><span>定义</span><ArrowRight size={13} aria-hidden="true" /><span>实现</span><ArrowRight size={13} aria-hidden="true" /><span>注册</span></div><a href="#/tools">查看当前工具 <ArrowRight size={14} aria-hidden="true" /></a></section>
        </div>
      </div>
    </>}
  </div>;
}
