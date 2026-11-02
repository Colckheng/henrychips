# 个人工作站：架构设计与详细实施计划

> 状态：2026-11-02 首版框架与六个示例工具已完成；第二轮影音与文档工具（B 站、抖音、去水印、格式转换、照片压缩）已实现并验证。第 19 节记录证据、未覆盖范围和实际启动方式。
>
> 实施方式：按本文的任务依次交付，每个任务经过验证后继续；使用 `superpowers:executing-plans` 协调，独立模块可交给子代理。当前目录不是 Git 仓库，按已确认的项目位置直接实施，不初始化或提交 Git，也不发布远程服务。

**目标：** 建立一个本地优先、持续扩展的个人工具工作站，让人在网页中操作工具，让 AI 通过 MCP 调用同一套能力，让脚本通过 CLI 自动化执行。

**架构：** 一个 TypeScript 项目，共享工具注册表、参数校验、执行器和本地运行记录；网页通过本地 HTTP API 调用，CLI 与 MCP 直接调用共享执行器。首版采用显式注册的内置工具，不引入动态插件加载、账号体系或云端基础设施。

**技术栈：** Node.js 22 LTS 或兼容版本、TypeScript、React、Vite、Fastify、Zod、官方 MCP TypeScript SDK；使用 Node 测试运行器和浏览器端到端测试。

**设计依据：** 用户已确认“先搭框架，使用文件、PDF、网页、表格和开发环境等工具作为示例”，随后要求先交付详细计划。本文同时承担设计说明与实施计划，不另建重复规格文件。

**计划日期：** 2026-11-02。

---

## 1. 已确认事实与默认选择

### 1.1 当前环境

| 项目 | 已核实状态 |
| --- | --- |
| 项目位置 | `D:/HenryChips` |
| 初始内容 | 检查时为空目录 |
| 版本管理 | 当前不是 Git 仓库 |
| 系统 | Windows，工具命令通过 Git Bash 执行 |
| 终端 Node.js | 实测 `v22.23.4` |
| 终端 npm | 实测 `10.9.2` |
| 当前交付 | 首版已完成；运行方式、验证和限制见第 19 节 |

实现开始前重新检查目录，避免覆盖用户在计划审阅期间添加的文件。默认直接使用现有项目目录，不再嵌套创建同名应用。

### 1.2 本计划采用的默认选择

1. 个人、单机使用，界面语言为中文。
2. 网页运行于回环地址，仅服务本机；默认端口 `4318`。
3. 前端开发服务器默认端口 `5173`，将 `/api` 代理至后端。
4. 不要求模型 API Key；AI 能力由外部 MCP 客户端提供。
5. MCP 首版使用本地 `stdio` 传输，不提供远程 MCP 服务。
6. 首版提供六个真实可运行的示例工具，全部不修改用户输入文件。
7. 文件整理先提供分类预览；实际移动文件作为后续独立功能。
8. 表格工具首版明确支持 UTF-8 CSV；XLSX 列为后续扩展，不把 CSV 支持宣传为完整 Excel 支持。
9. PDF 首版处理有文字层的 PDF；扫描件 OCR 列为后续扩展。
10. 所有新增工具通过同一注册表接入，不在三个入口中分别实现业务逻辑。

这些默认值用于形成可执行方案，不代表用户已单独确认每项产品选择；审阅时可以直接调整对应章节。

## 2. 产品边界与成功标准

### 2.1 用户最终能完成的事情

- 打开工作台，按类别查找工具、查看用途、填写参数并运行。
- 一键填入示例参数，看到真实结果，而不是静态演示卡片。
- 查看成功、失败、耗时和最近执行摘要。
- 从 AI 接入页复制本项目实际生成的 MCP 配置。
- 在支持本地 MCP 的客户端中发现工具，并用自然语言触发调用。
- 用 CLI 列出工具、查看工具参数、输出机器可读 JSON。
- 开发一个新工具时，只添加工具定义、实现、测试和注册项，自动出现在三个入口。

### 2.2 首版包含与不包含

| 首版包含 | 后续考虑 |
| --- | --- |
| 工具目录、搜索、分类、参数表单、执行结果 | 任意第三方插件自动安装 |
| MCP、CLI、本地 HTTP API | 远程 MCP、公共 API、多人共享 |
| 六个只读示例工具 | 自动移动、删除、批量覆盖文件 |
| 受限输出目录写入（第二轮新增） | 工作区外的任意写入、自动覆盖 |
| 本地执行摘要 | 云端同步、团队审计、企业权限 |
| 本地 JSON 配置与可复制接入示例 | 在线编辑敏感配置、OAuth、密钥托管 |
| 可取消的运行与明确超时 | 常驻任务队列、分布式执行、复杂工作流 |
| 外部 AI 调用工具 | 内置聊天产品、自建 Agent 平台 |

### 2.3 总体验收标准

1. 按交付脚本安装并启动后，工作台可访问，全部已注册工具都可操作。
2. 同一参数经网页、CLI、MCP 调用，业务结果相同；运行 ID、耗时等元数据允许不同。
3. 非法参数、越界路径、损坏文件、网络失败都有结构化错误。
4. 文件工具不读取允许目录之外的内容，不修改示例源文件；写入只发生在输出目录内。
5. MCP 输出遵守协议，不被普通日志污染。
6. 网页正常路径、失败路径、取消、空结果和窄屏布局经过浏览器检查。
7. 构建、类型检查、单元测试和协议集成测试通过；未验证部分明确标注。

## 3. 架构选择

### 3.1 方案比较

| 方案 | 优点 | 代价 | 本项目选择 |
| --- | --- | --- | --- |
| 单项目，共享执行器，三个入口 | 结构清楚、安装简单、工具只实现一次 | 多进程运行记录需要避免覆盖 | 首版采用 |
| 独立插件平台与多个服务 | 可独立部署、适合团队扩展 | 插件协议、服务发现、版本管理成本高 | 暂不采用 |
| 桌面壳包裹网页 | 原生文件选择与安装体验好 | 增加打包、签名、升级与系统兼容工作 | 网页稳定后再评估 |

首版的扩展点是“工具定义”，而不是插件市场。开发者在代码中显式注册可信工具；工具的权限声明由执行器落实到文件、网络和进程能力。

### 3.2 调用关系

```text
人 → React 工作台 → 本地 HTTP API ─┐
脚本 → CLI ──────────────────────┼→ 工具执行器 → 内置工具
AI → MCP stdio 服务 ─────────────┘       │             │
                                       │             ├→ 受限文件读取
                                       │             ├→ 受限公网请求
                                       │             └→ 固定环境探测
                                       └→ 本地运行摘要
```

CLI、MCP 不依赖网页服务在线。三者加载同一个配置文件，使用同一批工具定义和执行逻辑。生产模式的 HTTP 服务同时提供静态前端和 API。

### 3.3 分层责任

| 层 | 职责 | 不承担的事情 |
| --- | --- | --- |
| `src/contracts` | 可序列化公共类型、结果结构、表单字段描述 | 文件系统、网络、进程操作 |
| `src/core` | 注册、校验、权限、执行、取消、运行摘要 | 页面布局、MCP 传输细节 |
| `src/tools` | 单个工具的输入输出 Schema 与业务逻辑 | 自己启动 HTTP 服务或读取全局配置 |
| `src/adapters` | HTTP、CLI、MCP 参数与错误映射 | 复制工具算法 |
| `src/web` | 工具列表、表单、结果、历史、AI 接入 | 直接读本地文件或导入后端模块 |

禁止前端打包器把 Node 文件系统、进程模块或本地配置打进浏览器产物。

## 4. 技术选型与依赖原则

| 用途 | 选择 | 说明 |
| --- | --- | --- |
| 语言与模块 | TypeScript、ESM | 后端使用 NodeNext 编译；前端由 Vite 构建 |
| 服务端 | Fastify 5.x | 应用构造与端口监听分离，方便注入请求测试 |
| 前端 | React 19.x、Vite 7.x | 项目 Node 最低要求为 22.13+，同时满足 PDF.js 要求 |
| 表单与校验 | Zod 4.x | 输入、输出、JSON Schema 来自同一工具定义 |
| 样式 | CSS 变量与原生 CSS；保留 Tailwind CSS 3.4 配置 | 当前界面使用语义样式类，颜色、间距、字体、焦点状态由变量统一管理 |
| 图标 | lucide-react | 本地矢量图标，无远程图像依赖 |
| AI 接口 | `@modelcontextprotocol/sdk` 1.x | 使用已查阅的 v1 API；实施时锁定兼容的具体版本 |
| CSV | `csv-parse` | 正确处理引号、BOM、换行和字段内逗号 |
| PDF | `pdfjs-dist` | 使用 Node 兼容入口提取文字，隔离到 Worker |
| HTML | `linkedom` | 解析 HTML，提取标题和正文，不执行脚本 |
| HTTP 出站 | `undici` | 支持对实际连接目标实施网络限制 |
| 开发运行 | `tsx`、`concurrently` | 分别运行 TypeScript 入口与并行开发服务 |
| 测试 | `node:test`、`@playwright/test` | 核心行为、协议集成、网页端到端 |

版本约定：已核对兼容性并将实际版本固定于 `package.json` 与锁文件。PDF 的 Node 入口、Worker 退出方式及 MCP 的 Zod 输入输出兼容性均经过实际编译与协议测试；版本摘要见第 19 节。

首版不用 Docker、数据库服务、Python 环境或全局 npm 安装。PDF 解析依赖若需要额外系统组件，应先评估纯 JavaScript 路径，不静默安装系统级软件。

## 5. 目录与交付物

以下为实施后核对的主要目录；运行产物与临时验证文件单独标注。

```text
D:/HenryChips/
├─ package.json
├─ package-lock.json
├─ tsconfig.json
├─ tsconfig.server.json
├─ tsconfig.web.json
├─ tsconfig.tests.json
├─ playwright.config.ts
├─ vite.config.ts
├─ tailwind.config.ts
├─ postcss.config.cjs
├─ index.html
├─ workstation.config.json
├─ .gitignore
├─ src/
│  ├─ contracts/
│  │  ├─ tool.ts
│  │  └─ run.ts
│  ├─ core/
│  │  ├─ config.ts
│  │  ├─ converter.ts
│  │  ├─ errors.ts
│  │  ├─ define-tool.ts
│  │  ├─ registry.ts
│  │  ├─ executor.ts
│  │  ├─ file-access.ts
│  │  ├─ public-http.ts
│  │  ├─ process-probe.ts
│  │  ├─ runtime.ts
│  │  └─ run-store.ts
│  ├─ tools/
│  │  ├─ index.ts
│  │  ├─ text-stats.ts
│  │  ├─ files-plan.ts
│  │  ├─ csv-summary.ts
│  │  ├─ pdf-extract.ts
│  │  ├─ pdf-text.ts
│  │  ├─ pdf-worker.ts
│  │  ├─ web-extract.ts
│  │  ├─ env-inspect.ts
│  │  ├─ bilibili-video.ts
│  │  ├─ douyin-core.ts
│  │  ├─ douyin-video.ts
│  │  ├─ douyin-nowatermark.ts
│  │  ├─ doc-convert.ts
│  │  ├─ doc-convert-helpers.ts
│  │  └─ photo-compress.ts
│  ├─ adapters/
│  │  ├─ http/app.ts
│  │  ├─ http/server.ts
│  │  ├─ http/routes.ts
│  │  ├─ cli/main.ts
│  │  ├─ mcp/server.ts
│  │  └─ mcp/main.ts
│  └─ web/
│     ├─ main.tsx
│     ├─ App.tsx
│     ├─ api.ts
│     ├─ form.ts
│     ├─ presentation.ts
│     ├─ router.ts
│     ├─ useToolRun.ts
│     ├─ styles.css
│     ├─ components/
│     │  ├─ Shell.tsx
│     │  ├─ ToolCard.tsx
│     │  ├─ FormField.tsx
│     │  ├─ ResultPanel.tsx
│     │  ├─ ResultData.tsx
│     │  ├─ CsvResult.tsx
│     │  ├─ FilesResult.tsx
│     │  ├─ CopyButton.tsx
│     │  └─ Feedback.tsx
│     └─ pages/
│        ├─ Catalog.tsx
│        ├─ ToolDetail.tsx
│        ├─ History.tsx
│        └─ Integrations.tsx
├─ tests/
│  ├─ core/
│  ├─ tools/
│  ├─ adapters/
│  ├─ e2e/                       浏览器场景与前端单元测试
│  ├─ fixtures/                  夹具在测试中动态生成，目录当前为空
│  └─ production.test.ts
├─ scripts/create-samples.ts
├─ test-results/                 临时浏览器报告与生产验收配置
├─ sandbox/
│  ├─ inbox/
│  └─ samples/
├─ docs/
│  └─ superpowers/plans/
│     └─ 2026-11-02-personal-workstation-plan.md
├─ .workstation/runs/             运行时生成，忽略版本管理
└─ dist/
   ├─ server/                    TypeScript 编译产物
   └─ web/                       Vite 构建产物
```

实现时允许根据实际职责合并很短的模块，但不把工具实现、三种适配器和页面状态集中在一个文件。计划之外的文档不自动创建；接入说明优先放入应用的“AI 接入”页面和 CLI 帮助。

## 6. 工具契约与执行机制

### 6.1 工具必须声明的信息

| 字段 | 约定 |
| --- | --- |
| `name` | 全局唯一、稳定的 snake_case 名称，例如 `files_plan` |
| `title` | 中文显示名称，例如“文件整理预览” |
| `description` | 用途、适用输入、限制；给用户和 AI 使用 |
| `category` | `files`、`documents`、`web`、`data`、`developer`、`text` |
| `capabilities` | 所需能力：`files:read`、`files:write`、`network:public`、`process:probe`、`process:convert`、`browser:local` |
| `inputSchema` | 严格对象 Schema，拒绝未知字段，不隐式改变参数类型 |
| `outputSchema` | 成功结果 Schema；执行后校验 |
| `fields` | 表单元数据：标签、控件、说明、示例 |
| `examples` | 至少一个能实际运行的输入；网络工具另标记需要联网 |
| `execute` | 接收已校验参数和运行上下文，返回结构化对象 |

表单控件只支持 `text`、`textarea`、`number`、`select`、`checkbox`、`relative-path` 六种，足够覆盖首版工具。字段是否必填、数值限制和枚举合法性以 Schema 为准；元数据不能替代后端校验。

### 6.2 公共结果结构

```ts
export type RunSource = 'web' | 'cli' | 'mcp';

export type ErrorCode =
  | 'TOOL_NOT_FOUND'
  | 'INVALID_INPUT'
  | 'ACCESS_DENIED'
  | 'FILE_NOT_FOUND'
  | 'UNSUPPORTED_FORMAT'
  | 'LIMIT_EXCEEDED'
  | 'BUSY'
  | 'NETWORK_ERROR'
  | 'TIMEOUT'
  | 'CANCELLED'
  | 'TOOL_FAILED';

export interface RunMeta {
  runId: string;
  tool: string;
  source: RunSource;
  startedAt: string;
  durationMs: number;
  warnings: string[];
}

export type ToolResult<T extends Record<string, unknown>> =
  | { ok: true; data: T; meta: RunMeta }
  | {
      ok: false;
      error: {
        code: ErrorCode;
        message: string;
        details?: Array<{ path: string; message: string }>;
      };
      meta: RunMeta;
    };
```

`details` 仅包含清理过的参数位置和错误说明，不返回堆栈、完整配置、环境变量值或文件正文。工具输出错误映射为 `TOOL_FAILED`；不能把未经校验的结果当成成功返回。

### 6.3 执行器对外接口

```ts
export interface RunOptions {
  source: RunSource;
  signal?: AbortSignal;
}

export interface ToolExecutor {
  run(
    name: string,
    input: unknown,
    options: RunOptions,
  ): Promise<ToolResult<Record<string, unknown>>>;
}
```

内部采用 `defineTool({ inputSchema, outputSchema, execute, ...metadata })` 泛型工厂，在定义处保持输入输出类型推断；异构注册表保存包装后的工具，不把所有业务参数强制转换成 `any`。

运行上下文仅提供该工具申请且配置允许的能力：

```ts
export interface ToolContext {
  signal: AbortSignal;
  limits: Readonly<Limits>;
  files?: FileAccess;
  http?: PublicHttp;
  probes?: ProcessProbe;
}

export interface FileAccess {
  readBytes(relativePath: string, maxBytes: number): Promise<Uint8Array>;
  readText(relativePath: string, maxBytes: number): Promise<string>;
  list(relativeDirectory: string, maxEntries: number): Promise<FileEntry[]>;
  exists(relativePath: string): Promise<boolean>;
}

export interface FileEntry {
  name: string;
  relativePath: string;
  kind: 'file' | 'directory' | 'symlink';
  sizeBytes: number | null;
}

export interface PublicHttp {
  getHtml(url: string, signal: AbortSignal): Promise<{
    finalUrl: string;
    html: string;
    status: number;
  }>;
}

export interface ProcessProbe {
  inspect(signal: AbortSignal): Promise<EnvironmentReport>;
}

export interface EnvironmentReport {
  platform: string;
  architecture: string;
  node: { available: true; version: string };
  git: { available: boolean; version: string | null };
}
```

内置工具是可信应用代码，能力对象减少误用，但不构成恶意第三方 JavaScript 的安全沙箱。首版不接受从外部目录自动导入代码。

### 6.4 一次调用的流程

1. 创建运行 ID 和起始时间。
2. 查找工具并严格校验输入。
3. 检查工具能力是否允许，创建受限上下文。
4. 合并调用方取消信号与工具超时。
5. 执行业务逻辑；文件循环检查信号，HTTP 请求传递信号，PDF Worker 可终止。
6. 校验成功输出并形成统一结果。
7. 写入本地摘要，再返回结果。

摘要写入失败时，不把已完成的工具处理伪装成失败；在 `meta.warnings` 中加入“本次运行记录未保存”，并向诊断日志报告。取消后必须停止实际工作，不能只用 `Promise.race` 提前返回而让进程继续消耗资源。

### 6.5 并发与取消

- HTTP 每进程最多同时运行 4 个任务；超过时返回 `429`，不偷偷建立无界队列。
- CLI 默认每次进程只执行一次工具。
- MCP 每进程最多同时运行 4 个任务；超出时返回有意义的工具错误。
- 首版不宣称跨进程全局限流；每个 MCP 客户端启动的服务进程独立计数。
- 前端“取消”使用 `AbortController` 终止请求；后端根据请求断开及响应未完成状态传播取消，须做集成测试。
- MCP 将 SDK 提供的调用取消信号传给执行器；CLI 将 `SIGINT` 转成取消。

## 7. 配置、文件与网络边界

### 7.1 配置文件

首版只需要一个显式配置文件：

```json
{
  "workspaceRoot": "./sandbox",
  "stateDirectory": "./.workstation",
  "http": {
    "host": "127.0.0.1",
    "port": 4318
  },
  "network": {
    "enabled": true
  },
  "limits": {
    "fileBytes": 10485760,
    "csvRows": 10000,
    "directoryEntries": 1000,
    "pdfPages": 30,
    "webBytes": 2097152,
    "toolTimeoutMs": 15000
  }
}
```

规则：

- 配置文件路径由 `--config <absolute-path>` 显式指定；未传入时定位项目根下的配置，不依赖 MCP 客户端的当前工作目录。
- 所有相对路径相对于配置文件所在目录解析。
- 项目根通过源文件/编译后入口位置定位；源码与编译产物两种运行方式各有测试。
- 非法配置启动失败并给出字段说明，不悄悄换回默认值。
- `workspaceRoot` 必须存在且为目录；首次初始化由项目样例准备步骤建立。
- 网络开关关闭后，网页工具仍显示，但运行给出 `ACCESS_DENIED` 和关闭原因。
- 首版设置页只展示有效配置及修改说明，不在网页中任意修改权限。

### 7.2 本地文件访问

- 工具只接受相对于 `workspaceRoot` 的路径，例如 `samples/sales.csv`。
- 拒绝绝对路径、Windows 驱动器路径、UNC 路径、设备路径、NTFS 备用数据流语法和空字节。
- 规范化后检查路径边界，再用 `realpath` 检查真实路径，防止符号链接和目录联接绕过。
- 路径包含关系必须基于分段与 `path.relative`，不能用字符串 `startsWith(root)`。
- 目录枚举不递归跟随符号链接；输出中明确标记跳过项。
- 只读普通文件，拒绝设备、管道及目录当作文件。
- 大小检查与读取上限结合，不仅依赖读取前的 `stat`。
- 配置目录、运行摘要目录不默认属于用户工作区。

这些限制适用于本机可信使用场景；不把路径检查描述成可以抵御同权限恶意进程持续修改文件系统的隔离机制。

### 7.3 公网网页抓取

网页工具只处理用户明确提供的公网 HTTP/HTTPS 地址：

1. 禁止 `file:`、`data:`、`ftp:`，禁止 URL 中的用户名密码。
2. 禁止 localhost、回环、私有、链路本地、组播、保留地址与 IPv4 映射 IPv6 的私网形式。
3. 使用成熟 IP 地址解析判断，不靠少数前缀字符串匹配。
4. DNS 返回的每个候选地址都检查；实际连接使用已验证的地址，避免验证后再次解析导致重绑定。
5. 每次重定向都重新验证，最多跟随 3 次。
6. 只接受默认 HTTP/HTTPS 端口；不允许任意端口扫描。
7. 限制响应体为 2 MiB、超时为 15 秒、正文输出为最多 30,000 字符。
8. 只接受 HTML 文本响应，不执行 JavaScript、不使用登录态、不携带浏览器 Cookie。
9. 提取结果保留来源 URL，并标记 `untrustedContent: true`；网页内容不能改变工具权限或系统指令。
10. 测试使用受控的解析器和网络传输注入；生产环境没有允许访问私网的绕过参数。

### 7.4 本地 HTTP 入口

- 只绑定 `127.0.0.1`；首版拒绝配置为 `0.0.0.0`。
- 检查 `Host`，限制为本地有效主机与端口，避免 DNS 重绑定。
- 有 `Origin` 的请求仅接受生产本地源，以及开发模式明确列出的 `127.0.0.1:5173` 和 `localhost:5173` 源。
- 不返回通配 CORS 允许头。
- 执行接口仅接受 `application/json`，并限制请求体大小为 1 MiB。
- 无 `Origin` 的本地 CLI/调试请求允许访问；这不是面向远程用户的认证系统。
- 浏览器展示结果使用文本或安全组件，不把抓取到的 HTML 注入 DOM。

## 8. 六个示例工具

### 8.1 文件整理预览：`files_plan`

**用途：** 查看一个目录中的文件，按类型给出整理建议；验证文件能力、表格结果与只读工作流。

**输入：** `{ "directory": "inbox" }`。

**行为：** 仅枚举指定目录第一层；扩展名不区分大小写；目录和符号链接跳过；不读取文件内容、不创建文件夹、不移动文件。

**分类：** 文档、图片、表格、音视频、压缩包、代码、其他；无扩展名归“其他”。分类规则使用明确扩展名表，未知扩展名不猜测。

**输出：** `directory`、`scannedFiles`、`totalBytes`、`groups`、`moves`、`skipped`。每个建议包含 `source`、`suggestedDestination`、`category`、`conflict`。目标已存在或同一批目标冲突时标记 `conflict: true`，不覆盖。

**验收：** 混合文件返回正确分组；空目录返回零项；只读前后目录内容相同；越界路径被拒绝。

### 8.2 文本统计：`text_stats`

**用途：** 提供最简单、无文件权限的扩展示范，适合首先接通三个入口。

**输入：** `{ "text": "Hello 世界\n第二行" }`，最多 100,000 个 Unicode 码点；拒绝空白文本。

**输出定义：**

- `characters`：Unicode 码点数量，包含换行和空白。
- `charactersWithoutWhitespace`：移除 Unicode 空白后的码点数量。
- `lines`：统一 CRLF/CR 为 LF 后的行数，保留末尾空行。
- `hanCharacters`：Unicode Han 字符数量。
- `latinWords`：按明确规则统计拉丁字母词，不宣称是通用分词。

固定例子 `"Hello 世界\n第二行"` 返回 `characters: 12`、`charactersWithoutWhitespace: 10`、`lines: 2`、`hanCharacters: 5`、`latinWords: 1`。

**验收：** 中文、英文、Emoji、CRLF、末尾换行、空白输入都按规则处理；Emoji 不按 UTF-16 两个代理项计数。

### 8.3 CSV 分析：`csv_summary`

**用途：** 读取本地 CSV，返回字段信息、样例和数值摘要。

**输入：** `{ "path": "samples/sales.csv", "delimiter": "," }`；分隔符只允许逗号、分号或制表符。

**行为：** UTF-8，可带 BOM；第一条记录为表头；保留字段原始文本；忽略全空物理行；支持带引号的分隔符及字段内换行；重复或空表头返回 `INVALID_INPUT`；字段数不一致返回解析错误。

**数值规则：** 非空字段去掉首尾空白后，必须匹配普通十进制整数/小数规则；不自动转换货币、千分位、日期、百分比和科学计数法。某列所有非空值符合规则才标记为数值列；空值不参与平均值。全空列没有数值摘要。

**输出：** 行数、列数、列名、每列空值数、数值列 `min/max/sum/mean`、最多 5 行预览。达到行数或字节上限时返回 `LIMIT_EXCEEDED`，不把部分结果冒充完整统计。

**验收样例：** `amount` 列为 `12.5, 7.5, 空值` 时，非空数 2、空值数 1、总和 20、平均值 10。

### 8.4 PDF 文本提取：`pdf_extract`

**用途：** 从有文字层的 PDF 提取指定页的文本，展示较重文件处理的隔离方式。

**输入：** `{ "path": "samples/guide.pdf", "startPage": 1, "endPage": 3 }`。`startPage` 默认 1；不填 `endPage` 时处理到文档末页，但总页数超过单次 30 页限制则要求用户缩小范围。

**行为：** 1-based 闭区间；检查区间顺序、实际页数及字节限制；使用 Worker 解析，取消或超时终止 Worker；最多输出 100,000 字符，达到上限标记 `truncated: true`。

**输出：** `totalPages`、`pages: [{ page, text }]`、`textCharacters`、`truncated`、`warnings`。空文字层返回空文本和“可能是扫描件，需要 OCR”的提示。

**限制：** 不保证还原复杂多栏阅读顺序，不破解加密 PDF，不做 OCR，不转换为 Word。

**验收：** 已知两页样例能按页提取；指定不存在的页返回错误；扫描件提示清楚；损坏、加密和超时均不使主服务崩溃。

### 8.5 网页正文提取：`web_extract`

**用途：** 获取公网网页标题、描述和正文，为 AI 提供带来源的文本。

**输入：** `{ "url": "<用户提供的公开网页地址>" }`。

**行为：** 使用第 7.3 节的网络策略；解析标题和 description，优先 `article`、其次 `main`、最后 `body`；去除脚本、样式和导航等非正文节点，合并空白。

**输出：** `requestedUrl`、`finalUrl`、`title`、`description`、`text`、`characters`、`truncated`、`fetchedAt`、`untrustedContent: true`。

**限制：** 不保证所有站点的正文识别质量；不渲染 SPA、不绕过登录或反爬机制。动态站点返回“未提取到可用正文”的明确提示。

**验收：** 静态 HTML 正常提取；重定向保留最终来源；私网地址和重定向至私网被拒绝；超时和大响应可终止；输出只作为文本展示。

### 8.6 开发环境检查：`env_inspect`

**用途：** 查看当前运行环境，展示有限进程能力。

**输入：** `{}`，拒绝其他字段。

**输出：** 操作系统、CPU 架构、当前 Node 版本、Git 是否可用及版本。

**行为：** Node 版本直接读取 `process.version`；Git 使用固定命令 `git --version`，禁止 `shell: true`，不接收任意命令与参数；每次探测最多 3 秒。

**限制：** 不输出环境变量全集、用户名、令牌、完整 PATH，不安装或升级软件。缺少 Git 是正常检查结果，不导致整个工具失败。

**验收：** 有 Git 和缺少 Git 都能返回稳定结构；使用包含 shell 字符的非法参数无法触发命令执行。

### 8.7 影音与文档扩展（第二轮）

用户于 2026-11-02 提出五项需求：B 站视频提取、抖音视频提取、抖音去水印、PDF/Word 等格式转换、照片压缩。研究结论与实现如下。

**B 站视频提取 `bilibili_video`**

- 研究：`api.bilibili.com` 的 view / playurl 接口无需登录即可调用，但必须先取 `buvid3` cookie（`x/frontend/finger/spi`），否则返回 412。CDN 直链需要 `Referer` 与桌面 UA，否则 403。
- 实现：取 cookie → 读稿件信息 → 取 `platform=html5` 的单个 MP4 直链（`quality: 'mp4'`）或 DASH 音视频分离流（`quality: 'dash'`）；勾选下载时按 `Referer + UA` 下载并写入输出目录。
- 输出：`bvid`、`title`、`owner`、`cover`、`durationSeconds`、`pageCount`、`streams[]`、`savedFile`、`warnings`。
- 限制：只处理公开稿件；需要登录或已限制下载的稿件返回明确错误；DASH 模式只保存第一条视频流。

**抖音视频提取 `douyin_video` 与去水印 `douyin_nowatermark`**

- 研究：抖音 web 接口带 `a_bogus` 签名与 `uifid` 校验。`abogus` 等纯签名库在本机实测始终被 `ArgusSecurityPlugin` 拒绝（`Validate Error`），匿名调用 `aweme/detail` 返回空 body；同一网络下由真实 Chrome 发出的 `aweme/detail` 请求返回完整 `aweme_detail`。
- 实现：使用本机 Chrome（`playwright-core`，`channel: 'chrome'`，无头）打开作品页，拦截页面自身的 `aweme/detail` 响应读取官方数据；不自行复刻签名算法。
- 去水印依据：`play_addr` 为平台播放地址（无水印），`download_addr` 带 `watermark=1`（水印版）。实测同一作品无水印文件 2,577,862 字节、水印版 4,058,760 字节。
- 输出：标题、作者、封面、时长、发布时间、直链、候选地址、可选保存文件。
- 限制：依赖本机已安装 Chrome；作品下架、需登录或触发风控时返回明确错误，不返回猜测数据；短链接先解析跳转再取 ID。

**文档格式转换 `doc_convert`**

- 研究：本机已安装 LibreOffice、pandoc 与 Word COM；纯 JS 方案（`pdfjs` 读 PDF、`docx` 写 Word、`mammoth` 读 Word、`pdf-lib` 写 PDF）可覆盖大部分组合。
- 实现（第二轮已改为全程内置）：`src/core/html-blocks.ts` 把 HTML 解析成统一块模型，`src/core/markdown.ts` 负责 Markdown→HTML，`src/core/docx-build.ts` 用 `docx` 生成 Word，`src/core/pdf-layout.ts` 自写排版引擎输出 PDF（标题/段落/列表/引用/代码/表格、分页、中文断行、页脚页码）。
- 中文输出：`src/core/fonts.ts` 按 SimHei → 等线 → 微软雅黑顺序取系统 TrueType 中文字体，用 `@pdf-lib/fontkit` 子集内嵌；CFF/OTF 字体无法被子集化，因此不作为候选。找不到中文字体时退回 Helvetica 并由调用方提示。
- 覆盖：PDF→DOCX/Markdown/TXT/HTML、DOCX→Markdown/TXT/HTML/PDF、Markdown/TXT/HTML→DOCX/PDF/HTML、图片→PDF，全部在进程内完成，不再调用 LibreOffice 或 pandoc。
- 输出：`sourceFormat`、`targetFormat`、`converter`、`characters`、文本预览（最多 2000 字符）、`savedFile`、`warnings`。
- 限制：PDF→Word 与 DOCX→PDF 只保留文本与基础结构，不还原原始排版；中文字体依赖本机字体（未打包进仓库）。

**照片压缩 `photo_compress`**

- 研究：`sharp` 提供预编译 Windows 二进制（libvips 8.18.7），支持 JPEG/WebP/AVIF 与 EXIF 处理，优于纯 JS 方案。
- 实现：可选输出格式与质量、最长边限制、默认移除 EXIF；输出体积对比与输出尺寸。
- 输出：`originalBytes`、`compressedBytes`、`savedBytes`、`ratio`、`width`、`height`、`savedFile`、`warnings`。
- 限制：不处理 HEIC 等冷门格式；压缩后更大时给出提示而不是隐藏结果。

**输出目录与写入边界**

新增 `files:write` 能力与 `outputDirectory` 配置（默认 `sandbox/downloads`）。写入器只接受输出目录内的相对路径，拒绝绝对路径、`..`、设备名与 Windows 保留名，限制单文件体积，默认不覆盖同名文件（同名时自动追加序号，工具也可显式勾选覆盖）。输入工作区仍为只读。

**运行进度与可视化（第四轮新增）**

- 契约：工具上下文新增 `reportProgress({ phase, percent })`，工具只报告阶段与真实进度，不猜测剩余时间。
- 运行时：`ProgressStore` 按运行号维护阶段、百分比与步骤时间线；执行器在运行开始、结束与每次上报时更新状态。
- 接口：客户端可在运行请求里带 `requestId`（网页端自动生成），随后用 `GET /api/runs/:runId/progress` 轮询，或用 `GET /api/runs/:runId/events` 订阅 SSE 事件流；运行结束时服务端主动关闭事件流。
- 界面：运行中显示进度条、当前阶段与最近步骤；完成或失败后恢复结果展示。
- 已接入：PDF 文本提取按页报进度，CSV 按行数，文档转换按读取/解析/排版，压缩按解码/编码，影音工具按取元数据/下载阶段。
- 边界：进度只覆盖本次运行，结束后仅保留 5 分钟；SSE 不可用时网页自动降级为轮询。

**XLSX 表格分析 `xlsx_summary`**

- 用 `read-excel-file` 在进程内读取工作簿，列出工作表、表头、行数与逐列类型统计（数值列的最小/最大/总和/均值、空值数、高频取值），可指定单个工作表与最多统计行数。
- 只读不改写；旧版 `.xls` 需先转换为 `.xlsx`；超大工作簿按 `maxRows` 截断并在提示中说明。

**去水印开关（第五轮新增）**

- 抖音：平台同时提供两个源，`play_addr` 为无水印播放地址、`download_addr` 带 `watermark=1`（画面右下角有水印）。工具的「水印处理」开关在“去除水印（用无水印源）”与“保留水印（用平台下载源）”之间切换，输出里同时给出 `noWatermarkUrl`、`watermarkedUrl` 与本次实际使用的 `source`。
- B 站：实测同一稿件的 html5 单文件 MP4 与 DASH 原始流画面完全一致（B 站接口不提供“水印版/无水印版”两套源，也不会在文件里烧制水印；可见水印是 UP 主自己烧进画面的）。因此开关的语义是“去除水印＝改用 DASH 原始视频流（社区‘无水印下载’的通行做法），保留＝用单文件转码 MP4”，并在结果中说明：若水印已烧录在源片里，需要重编码裁剪才能去除，本工具不做图像处理。
- 配套修复：B 站 CDN 端口不固定（默认端口与 8080/8082 都可能出现），公网客户端按已知端口白名单放行；下载失败时自动改用备用镜像地址。

**打开输出文件夹（第五轮新增）**

- 结果面板新增「打开输出文件夹」按钮，调用 `POST /api/output/open`，服务端只打开配置里的输出目录（不接受任意路径），在系统文件管理器中定位产物目录。

**跨页面进度保持（第六轮新增）**

- 问题：切换页面会卸载工具页组件，原先的请求被一并中断，后端随之取消任务，进度与结果都丢失。
- 修正：运行状态提升到前端全局运行仓库（`src/web/run-store.ts`），请求与进度订阅不再随组件卸载而销毁；只有显式点击「取消」或对同一工具重新运行时才会中止。
- 表现：顶栏出现运行中任务指示（阶段文字与百分比，点击回到对应工具页）；返回工具页时进度条与结果继续显示；整页刷新后用 `sessionStorage` 里保存的运行号重新查询服务端进度并接回事件流。
- 边界：关闭浏览器标签仍会中断请求（服务端按断开取消任务），属于预期行为。

**关掉页面任务继续跑（第七轮新增）**

- 目标：关闭标签页后任务不再被取消，结果可以回来再看。
- 服务端接管取消语义：HTTP 断开不再取消工具；执行器为每次运行持有自己的取消控制器，取消改由显式接口 `POST /api/runs/:runId/cancel` 触发（CLI 的 SIGINT、MCP 的取消信号仍按原路径生效）。
- 结果留存：执行器在内存中保留最近 50 个运行结果（最长 12 小时），`GET /api/runs/:runId/result` 可取回；`GET /api/runs/latest?tool=…` 给出某个工具最近一次运行。
- 前端行为：打开工具页时若该工具仍有运行中的任务，自动接管进度并接回事件流，运行结束后自动取回结果；若已经结束，则显示「查看上次运行结果」按钮，由用户主动载入，不会在新页面上冒充刚跑出来的结果。
- 边界：结果只在内存里，服务重启后不再保留；运行摘要仍照旧写入 `.workstation/runs`。

**音轨分离（第三轮新增）**

- B 站：DASH 播放信息自带独立音频流，工具新增 `parts` 选项（`video` / `audio` / `both`）。`audio` 只取 DASH 音频流保存为 `.m4a`；`both` 保存合并 MP4 与独立 `.m4a`；`video` 仍是单个 MP4。实测同一稿件输出 5,492,083 字节 MP4 与 2,576,587 字节 M4A。
- 抖音：作品详情里的 `music.play_url` 就是原声的纯音频地址（MP3），工具同样提供 `parts` 选项，音频单独保存为 `.mp3`。实测原声音频 17,616,087 字节可下载。
- 抖音的音频是作品“原声/音乐”，对少数后期配音作品可能与最终混音不同。

**抖音解析改为内置自签名（第三轮）**

- 第一次调用用本机 Chrome 打开官方作品页，抓取它自己发出的签名请求参数模板与 cookie，写入状态目录 `douyin-session.json`（有效期 6 小时）。
- 之后的查询由工作站自己用 `abogus` 计算 `a_bogus` 与 `x-secsdk-web-signature`，用自带的公网客户端直连接口，无需再启动浏览器；实测两次不同作品均返回完整 `aweme_detail` 与无水印播放地址。
- 平台拒绝自签名时会重新引导一次会话，并可退回使用浏览器实际收到的响应体，保证不会返回猜测数据。
- 限制：`uifid` 与签名参数必须来自同一次页面会话，纯 HTTP 无法自行签发；平台对本机频繁匿名访问会限流，此时工具返回明确错误而不是空结果。

## 9. 三种调用入口

### 9.1 本地 HTTP API

| 方法与路径 | 用途 | 结果 |
| --- | --- | --- |
| `GET /api/health` | 服务存活与版本 | `{ status, version }` |
| `GET /api/tools` | 工具发现 | 元数据、JSON Schema、表单描述、示例 |
| `GET /api/tools/:name` | 单工具详情 | 一份工具描述；未知返回 404 |
| `POST /api/tools/:name/run` | 执行 | 请求 `{ input: {...} }`，返回统一 `ToolResult` |
| `GET /api/runs?limit=50` | 最近执行摘要 | 按开始时间倒序，限制为 1–100 |
| `GET /api/integrations` | 本机接入说明 | 由真实项目路径生成的 MCP/CLI 示例与能力状态 |

运行接口状态映射：非法输入 400、拒绝访问 403、工具或输入文件不存在 404、输入规模超限 413、并发已满 429、超时 504、工具内部失败 500、成功 200。远端内容不支持或不可解析映射为 422；网络失败映射为 502。请求断开后的取消记录为 `CANCELLED`，不再向已关闭响应写数据。

API 外层请求结构同样使用严格校验。结果封装的 `ok` 与 HTTP 状态一致，不把工具错误全部包装成 200。

### 9.2 CLI

开发阶段命令约定：

```bash
npm run cli -- list --json
npm run cli -- inspect text_stats --json
npm run cli -- run text_stats --input '{"text":"Hello 世界"}'
npm run cli -- run csv_summary --input '{"path":"samples/sales.csv","delimiter":","}'
npm run cli -- run text_stats --input-file "D:/HenryChips/sandbox/samples/text-input.json"
```

- `--input` 与 `--input-file` 互斥。
- 输入 JSON 文件是 CLI 的显式参数载体，由用户指定；工具自身的文件参数仍受工作目录限制。
- `run` 的 stdout 始终输出一个 JSON 对象；帮助和非 JSON 列表可输出人类可读文本。
- 诊断信息写 stderr。
- 退出码：成功 0、运行失败 1、命令语法或输入 JSON 格式错误 2、用户中断 130。
- stdout 不包含 npm 横幅的要求针对实际 CLI 进程；自动化应直接运行编译入口，或使用 `npm --silent run cli -- ...`。
- Windows PowerShell 与 Git Bash 对内联 JSON 的引号规则不同；AI 接入页使用不包含内联 JSON 的 `--input-file` 示例，可在这两种 Shell 中运行。

### 9.3 MCP

使用官方 SDK 的 `McpServer`、`registerTool`、`StdioServerTransport`。

- 每个注册工具作为一个 MCP tool 暴露，名称不变。
- 使用相同输入 Schema；SDK 预校验后，核心执行器仍执行统一边界校验。
- 输出 Schema 描述完整 `ToolResult` 对象，包含可选 data/error 和必需 meta；受 SDK 对顶层对象 Schema 的要求约束，成功/失败字段关联由运行时校验保证。
- 每次返回 `structuredContent`，并在 `content` 中提供 JSON 文本，兼容只读取文本内容的客户端。
- 工具失败设置 `isError: true`；未知工具、格式错误等协议级问题交由 SDK 处理。
- 首版六个工具的 `readOnlyHint` 为 true，`destructiveHint` 为 false；公网网页工具 `openWorldHint` 为 true。
- 注解只是客户端提示，不能替代后端权限校验；本地运行摘要仍会持久化。
- stdout 仅写 MCP 协议消息，所有日志写 stderr。

构建后生成的配置示例：

```json
{
  "mcpServers": {
    "personal-workstation": {
      "command": "node",
      "args": [
        "D:/HenryChips/dist/server/adapters/mcp/main.js",
        "--config",
        "D:/HenryChips/workstation.config.json"
      ]
    }
  }
}
```

这是通用客户端配置形状，不保证所有客户端字段完全一致。AI 接入页使用实际 Node 可执行路径与项目路径，显示“构建产物已就绪”和“客户端连接尚未验证”；协议自测证据保存在第 19 节，不将其伪装为客户端连接状态。未自动写入用户的 Qoder 或其他客户端配置。

## 10. 本地运行记录

### 10.1 保存内容

每次调用保存一个独立 JSON 文件，以 UUID 为文件名，先写临时文件再在同目录重命名，避免 CLI、MCP、HTTP 同时写入时覆盖同一个数组文件。

```ts
export interface RunSummary {
  runId: string;
  tool: string;
  source: 'web' | 'cli' | 'mcp';
  status: 'succeeded' | 'failed' | 'cancelled';
  startedAt: string;
  durationMs: number;
  errorCode: string | null;
}
```

不默认保存输入正文、输出正文、网页查询参数、本地绝对路径或环境变量。完整结果只在当前调用和浏览器当前会话中展示，可由用户显式下载 JSON。

### 10.2 历史界面限制

- 历史页面展示摘要，不显示一个无法实现的“重新运行”按钮。
- 当前工具页面允许用仍在内存里的参数重新运行。
- 应用重启后，历史摘要保留，完整输入输出不恢复。
- 损坏的摘要文件被跳过，并计入读取警告，不使整个列表失败。
- 首版没有自动清理和跨进程全局锁；当记录量明显影响读取时，再增加索引或迁移 SQLite。

## 11. 网页工作台

### 11.1 信息结构

| 页面 | 内容与行为 |
| --- | --- |
| 工具箱 | 搜索、分类、六张工具卡、工具能力标签、示例入口 |
| 工具详情 | 说明、参数表单、填入示例、运行/取消、结果、错误 |
| 执行记录 | 最近运行摘要、来源、状态、耗时、刷新 |
| AI 接入 | MCP 配置、CLI 用法、复制按钮、扩展工具步骤、实际能力状态 |

顶层布局采用左侧导航与主内容区；小屏切换为顶部导航或可展开菜单。首版不增加收藏、登录、主题切换、拖拽工作流等与核心目标无关的功能。

### 11.2 核心交互

1. 用户打开工具箱，选择“CSV 分析”。
2. 点击“填入示例”，表单填入 `samples/sales.csv`。
3. 点击运行，按钮变为执行中并出现取消按钮。
4. 成功后展示行列统计、数值摘要和前 5 行预览。
5. 可以切换到 JSON 视图、复制结果、下载结果。
6. 切换执行记录，看到刚才运行的成功摘要。
7. 输入不存在路径再次执行，页面保留参数并显示可理解的错误。

复制和下载必须真实可用；复制失败给出可手动选择的文本。工具切换或组件卸载时取消旧请求；旧请求结果不得覆盖新工具页面。

### 11.3 视觉与可访问性

- 风格：紧凑但不拥挤的生产力工作台，主操作清楚，减少装饰。
- 颜色：中性背景、单一强调色，成功和错误使用语义色。
- 建立 `--background`、`--foreground`、`--muted`、`--primary`、`--border`、`--success`、`--danger` 等 CSS 变量。
- 使用统一间距、圆角、字号和焦点样式，不在组件中散落硬编码颜色。
- 表单 label 与控件关联，错误用 `aria-describedby`，运行状态使用适当的 live region。
- 搜索、导航、表单和复制按钮支持键盘操作，焦点可见。
- 长路径、长文本和 JSON 不撑破布局；窄屏只在表格或代码块内部横向滚动。
- 用户开启减少动画时减少过渡效果。
- 功能界面采用图标与排版，不依赖装饰性图片或第三方字体网络请求。

## 12. 如何增加一个新工具

约定新增流程只有以下步骤：

1. 在 `src/tools/` 新建工具模块，声明名称、描述、能力、输入输出 Schema、表单和示例。
2. 编写能证明真实行为的测试。
3. 实现 `execute`，通过受限上下文访问外部资源。
4. 在 `src/tools/index.ts` 导入并注册。
5. 运行发现和跨入口测试，确认网页、CLI、MCP 同时出现。

不需要修改三个适配器。若新工具需要首版没有的输入控件或输出展示，可以增加可选的展示组件；JSON 结果视图始终可用。

新增写入工具必须另行设计预览、明确确认、冲突处理和失败恢复；不能把 `files_plan` 悄悄改为执行移动。工具名称或参数发生不兼容变更时，必须同时更新示例、Schema、测试和接入页面。

## 13. 实施任务与验证步骤

任务按依赖排序，方括号根据实际实现与验证证据勾选。第 19 节记录当前轮次结果，尚未验证的步骤保持未勾选。

### 任务 1：建立可运行骨架与固定工具契约

**文件：** 根配置、`src/contracts/*`、`src/core/config.ts`、`src/core/errors.ts`、`src/core/define-tool.ts`、`src/core/registry.ts`、对应 `tests/core/*`。

**输入：** 本文第 4–7 节。

**产出：** 可加载的配置、可注册与发现工具的注册表、可序列化元数据；前后端类型边界建立。

- [x] 检查目录并保留已有文件；核对 Node/npm 与依赖版本，初始化单个 npm 项目。
- [x] 创建 TS、Vite、Tailwind 配置，明确服务端与前端构建目录。
- [x] 为配置相对路径解析、非法配置、工具重名写失败测试。
- [x] 运行测试，确认失败源于未实现的业务行为。
- [x] 实现配置解析、`defineTool` 和注册表；重复工具名称启动时报错。
- [x] 输出 JSON Schema 与前端元数据，不暴露函数、Zod 实例或本地内部对象。
- [x] 运行类型检查、测试和完整构建，确认网页仅导入公共类型与前端模块。

**核心断言：** 在另一个当前工作目录启动，显式配置仍解析至配置文件旁的 `sandbox`；重复 `text_stats` 注册被拒绝；包含未知配置字段时明确失败。

**预计工作量：** 0.5–1 个开发日。

### 任务 2：接通执行器、文本工具与运行摘要

**文件：** `src/core/executor.ts`、`src/core/run-store.ts`、`src/tools/text-stats.ts`、`src/tools/index.ts`、`tests/core/executor.test.ts`、`tests/tools/basic.test.ts`、`tests/core/run-store.test.ts`。

**消费接口：** 任务 1 的工具定义与注册表。

**产出接口：** 第 6.3 节 `ToolExecutor.run`，以及 `RunStore.append(summary)`、`RunStore.list(limit)`；后两者分别返回 `Promise<void>` 和 `Promise<{ runs: RunSummary[]; warnings: string[] }>`。

- [x] 为 Unicode 计数、严格输入校验、未知工具、取消和摘要保存写失败测试。
- [x] 实现文本工具并对输入输出双向校验。
- [x] 实现统一执行器、错误映射、超时和能力注入。
- [x] 实现独立文件摘要，测试并发写入不会互相覆盖。
- [x] 测试摘要故障只产生警告，不改变工具业务成功结果。
- [x] 运行相关测试，检查摘要不包含用户原文。

**文本行为测试骨架：**

```ts
import assert from 'node:assert/strict';
import test from 'node:test';
import { textStatsTool } from '../../src/tools/text-stats.js';

test('counts Unicode code points and Han characters', async () => {
  const output = await textStatsTool.execute(
    { text: 'Hello 世界\n第二行' },
    { signal: new AbortController().signal, limits: { fileBytes: 10485760, csvRows: 10000, directoryEntries: 1000, pdfPages: 30, webBytes: 2097152, toolTimeoutMs: 15000 } },
  );
  assert.deepEqual(output, {
    characters: 12,
    charactersWithoutWhitespace: 10,
    lines: 2,
    hanCharacters: 5,
    latinWords: 1,
  });
});

test('does not count an emoji as two UTF-16 code units', async () => {
  const output = await textStatsTool.execute(
    { text: '\u{1F600}A' },
    { signal: new AbortController().signal, limits: { fileBytes: 10485760, csvRows: 10000, directoryEntries: 1000, pdfPages: 30, webBytes: 2097152, toolTimeoutMs: 15000 } },
  );
  assert.equal(output.characters, 2);
});
```

测试 import 与最终工厂导出类型保持一致；不为让测试通过而跳过执行器集成验证。

**预计工作量：** 0.5–1 个开发日。

### 任务 3：实现文件访问、整理预览与 CSV 分析

**文件：** `src/core/file-access.ts`、`src/tools/files-plan.ts`、`src/tools/csv-summary.ts`、`tests/core/file-access.test.ts`、`tests/tools/basic.test.ts`、样例目录与 CSV。

**消费接口：** 第 6.3 节 `FileAccess`、任务 2 执行器。

**产出：** 两个真实文件工具，受限路径访问，稳定表格结果。

- [x] 建立隔离临时目录，创建普通文件、子目录和工作区外文件作为测试夹具。
- [x] 写绝对路径、`..`、相邻前缀目录、大小写、Windows 路径和链接越界测试（大小写同名冲突在当前文件系统跳过，其他路径用例已通过）。
- [x] 实现真实路径校验、普通文件检查和有上限的读取。
- [x] 写整理预览测试：分类、空目录、冲突、跳过子目录、不修改源文件。
- [x] 实现 `files_plan`。
- [x] 写 CSV 测试：BOM、引号、字段内换行、空值、重复表头、行数上限、数值摘要。
- [x] 实现 `csv_summary`，注册两个工具并验证发现结果。
- [x] 在 Windows 实测目录联接；测试环境不支持建立链接时明确报告未覆盖，不静默算通过。

**CSV 固定样例：**

```csv
item,amount,note
A,12.5,"first, order"
B,7.5,second
C,,pending
```

**独立期望：** 3 行、3 列；`amount` 的 min 7.5、max 12.5、sum 20、mean 10、emptyCount 1；预览保留 `first, order` 为一个字段。

**预计工作量：** 1–1.5 个开发日。

### 任务 4：完成 CLI 与 MCP，提前打通 AI 调用

**文件：** `src/adapters/cli/main.ts`、`src/adapters/mcp/server.ts`、`src/adapters/mcp/main.ts`、`tests/adapters/cli.test.ts`、`tests/adapters/mcp.test.ts`。

**消费接口：** 注册表与 `ToolExecutor.run`。

**产出：** 第 9.2、9.3 节的调用入口；无需启动网页即可使用当前已注册工具。

- [x] 写 CLI 子进程测试：列出工具、合法 JSON、无效 JSON、未知工具、输入文件、退出码。
- [x] 实现 CLI 参数解析，严格区分 stdout 与 stderr。
- [x] 使用官方 MCP Client 和 stdio transport 写握手、`listTools`、`callTool` 测试。
- [x] 实现 MCP 注册与结果映射，确保实际返回通过输出 Schema。
- [x] 从与项目无关的工作目录启动编译后 MCP 入口，验证显式配置仍有效。
- [x] 文本结果分别与独立期望对照；编译 CLI、HTTP、MCP 对同一 CSV 输入执行深度结果一致性检查。
- [x] 测试核心并发上限、HTTP/MCP 调用取消以及正常 stdio 连接关闭。
- [ ] 专门验证运行中的 CLI 收到真实 SIGINT，以及 stdio 意外断开时的资源回收；当前未进行操作系统级中断测试，不能以正常关闭测试替代。

**验收调用示例：**

```json
{
  "name": "text_stats",
  "arguments": {
    "text": "Hello 世界\n第二行"
  }
}
```

MCP 测试必须真的启动项目进程并完成协议交互，不能只检查配置文件中存在某段文本。

**预计工作量：** 0.5–1 个开发日。

### 任务 5：实现 HTTP API 与浏览器工作台

**文件：** `src/adapters/http/*`、`src/web/*`、`tests/adapters/http.test.ts`、`tests/e2e/workbench.spec.ts`。

**消费接口：** 工具描述、`ToolExecutor.run`、运行摘要存储。

**产出：** 可运行网页、表单、结果、历史、接入页面；工具增减由目录数据驱动。

- [x] 写 API 测试：发现、执行、错误状态码、非法 Origin/Host、请求体限制。
- [x] 实现 `buildApp`，将应用构造与 `listen` 分离，使用 Fastify `inject` 验证路由。
- [x] 建立 CSS 变量和基础组件，完成响应式布局。
- [x] 实现工具目录与受限字段集表单，所有参数仍由后端最终校验。
- [x] 实现执行中、取消、成功、错误、空结果状态；防止旧响应覆盖当前页面。
- [x] 实现表格/文本结果和 JSON 视图、真实复制与下载。
- [x] 实现运行摘要和接入配置生成，状态标签只反映已知事实。
- [x] 启动开发服务器，真实浏览器走完 CSV 正常路径与不存在文件路径。
- [x] 验证键盘导航、错误 alert、窄屏、10 万字符、页面刷新与取消；未使用真人屏幕阅读器验证语音播报。

**网页验收脚本：** 打开工具箱 → 搜索 CSV → 进入详情 → 填示例 → 运行 → 检查统计总和 20 → 下载 JSON → 查看运行记录 → 输入不存在文件 → 检查错误与参数保留。

**预计工作量：** 1.5–2 个开发日。

### 任务 6：加入 PDF、网页与环境检查示例

**文件：** `src/tools/pdf-extract.ts`、`src/tools/pdf-worker.ts`、`src/tools/web-extract.ts`、`src/tools/env-inspect.ts`、`src/core/public-http.ts`、`src/core/process-probe.ts`、对应测试和夹具。

**消费接口：** `FileAccess`、`PublicHttp`、`ProcessProbe`、执行器取消机制。

**产出：** 完整六工具目录；重任务、联网工具和有限进程调用的参考实现。

- [x] 为 PDF 页范围、损坏文件、空文字层和 Worker 取消写失败测试。
- [x] 实现 Node 兼容 PDF 解析，并验证编译后 Worker 路径。
- [x] 为公网请求地址检查、实际连接固定、重定向、超时和字节上限写失败测试。
- [x] 实现受限 HTTP 客户端，再实现 HTML 标题与正文提取。
- [x] 为 Git 可用/缺失、固定参数和超时写测试，实现环境检查。
- [x] 注册三个工具，验证它们自动出现在网页、CLI 和 MCP。
- [x] 在浏览器验证 PDF、环境检查；开发与编译入口及生产网页均已对 Node.js 官网成功提取正文，生产浏览器实测 2,357 字符。
- [x] 已完成真实公网提取，保留受控传输测试验证边界。

**预计工作量：** 1.5–2.5 个开发日，网络边界与 PDF 平台兼容性是主要变动来源。

### 任务 7：生产构建、扩展验证与交付

**文件：** 构建脚本、集成测试、AI 接入页；只修正前述任务涉及的实现。

**产出：** 可从源码安装运行、可构建运行、可接入 MCP 的完整首版。

- [x] 运行完整类型检查、构建、核心测试、适配器测试和网页端到端测试。
- [x] 用生产 HTTP 服务提供 `dist/web`，确认不依赖 Vite 开发服务器；本轮在独立 4319 端口运行编译服务，启用生产 CSP。
- [x] 直接运行编译后 CLI 和 MCP，确认不依赖 `tsx` 或特定当前工作目录。
- [x] 从冷启动读取已有摘要，并验证三种入口的 CSV 结果一致性。
- [x] 临时测试工具验证注册表、HTTP、MCP 自动发现；CLI 以真实六工具目录子进程验证，并复核使用同一 `registry.list()`；不保留测试工具到业务目录。
- [x] 检查浏览器控制台和失败网络请求；生产 PDF、环境、文件预览完整流程无页面异常、控制台错误和失败请求。
- [x] 主线程完成文件路径、网络访问、日志、取消、协议输出与界面检查；独立审查工具连接/平台错误，未获得独立审查结论。
- [x] 在第 19 节交付运行命令、MCP 配置生成位置、扩展入口与已知限制。

**预计工作量：** 0.5–1 个开发日。

### 任务 8：影音与文档工具扩展

**文件：** `src/tools/bilibili-video.ts`、`src/tools/douyin-core.ts`、`src/tools/douyin-video.ts`、`src/tools/douyin-nowatermark.ts`、`src/tools/doc-convert.ts`、`src/tools/photo-compress.ts`、`src/core/converter.ts`、扩展后的 `src/core/public-http.ts`、`src/core/file-access.ts`、`src/core/executor.ts`，以及 `tests/tools/media.test.ts`。

**消费接口：** 公网请求能力、受限输出目录写入能力、本机转换程序与本机浏览器。

**产出：** 第 8.7 节的五个工具，网页、CLI、MCP 三处自动可发现。

- [x] 研究各平台可行路径并记录结论（B 站 cookie 与 Referer 要求；抖音签名与风控现状）。
- [x] 扩展共享能力：`files:write`、`process:convert`、`browser:local`；JSON/二进制请求与请求头白名单。
- [x] 写失败测试：输出写入边界、压缩体积下降、PDF→DOCX 文本往返、图片→PDF、B 站解析结构、抖音链接解析。
- [x] 实现 B 站解析与下载，实测 5.49 MB MP4 落盘。
- [x] 实现抖音解析与去水印，实测无水印 2.58 MB 与水印版 4.06 MB 对照。
- [x] 实现文档格式转换与照片压缩，接入本机 LibreOffice、pandoc 与 sharp。
- [x] 在网页验证新工具可见、可运行，并在生产模式下跑通端到端用例。
- [ ] 未覆盖：抖音登录后可见的作品、平台风控升级后的稳定时长、LibreOffice/pandoc 缺失时的完整降级矩阵。

**预计工作量：** 1–2 个开发日；抖音部分的不确定性主要来自平台风控。

## 14. 脚本与命令约定

以下脚本已写入项目配置；各项实际运行验证见第 19 节：

| 命令 | 预期作用 |
| --- | --- |
| `npm install` | 根据锁文件安装本地依赖 |
| `npm run dev` | 同时启动回环 API 与前端开发服务器 |
| `npm run typecheck` | 分别检查前端、后端、测试类型 |
| `npm test` | 运行核心、六工具和适配器测试，不依赖外网 |
| `npm run test:web` | 表单序列化与结果渲染单元检查 |
| `npm run test:production` | 构建后检查 CLI/MCP/HTTP 结果一致性和 PDF Worker |
| `npm run test:e2e` | 启动或复用本地服务，执行 16 项 Chrome 浏览器测试 |
| `npm run samples` | 生成可提取文本的两页 PDF 样例，保留已有文件 |
| `npm run build` | 生成 `dist/server` 与 `dist/web` |
| `npm start` | 生产模式提供网页与 HTTP API |
| `npm run cli -- ...` | 开发阶段运行 CLI |
| `npm run mcp` | 开发阶段启动 stdio MCP，仅用于调试 |

构建后的直接调用：

```bash
node "D:/HenryChips/dist/server/adapters/cli/main.js" list --json
node "D:/HenryChips/dist/server/adapters/mcp/main.js" --config "D:/HenryChips/workstation.config.json"
```

验证时不自动向当前用户的 MCP 设置写入内容；提供可复制配置即可。用户要求接入某个客户端后，再按该客户端实际配置格式操作。

## 15. 测试矩阵

| 领域 | 必测正常情况 | 必测边界/失败情况 |
| --- | --- | --- |
| 配置 | 源码与编译入口加载同一配置 | 非法字段、不同 cwd、根目录缺失 |
| 注册表 | 工具发现与 Schema 输出 | 重名、未知工具 |
| 执行器 | 输入输出校验、摘要 | 取消、超时、输出不符合 Schema、摘要保存失败 |
| 文件边界 | 相对路径普通文件 | `..`、绝对路径、UNC、联接越界、设备、超限 |
| 文本 | 中英混合、Unicode 码点 | Emoji、CRLF、末尾换行、空白 |
| 整理预览 | 扩展名分类与总大小 | 空目录、大小写、同名目标、源文件不变 |
| CSV | 引号、BOM、空值和数值统计 | 重复表头、字段数不符、超行数、超字节 |
| PDF | 指定页文本 | 扫描件、损坏、加密、页越界、Worker 终止 |
| 网页 | 静态 HTML、允许的重定向 | 私网、DNS 重绑定、重定向至私网、大响应、超时 |
| 环境 | Node 与 Git 版本 | Git 缺失、探测超时、未知输入 |
| HTTP | 发现、运行、历史 | Origin/Host、JSON 类型、并发上限、断开取消 |
| CLI | list、inspect、run、输入文件 | 非法 JSON、互斥参数、退出码、SIGINT |
| MCP | 握手、发现、成功输出 | 工具失败、取消、日志污染、非项目 cwd |
| 网页 | 表单到结果到历史 | 空状态、错误、连续点击、切换工具、窄屏、键盘 |

测试用实际临时文件与真实子进程验证本项目行为；不以实现生成的期望值再次对照实现。外网测试不成为普通单元测试的前提，第三方协议的内部机制也不重复测试。

## 16. 交付节奏与后续扩展

### 16.1 可独立使用的里程碑

| 里程碑 | 包含任务 | 可以实际使用的能力 |
| --- | --- | --- |
| M1：AI 可调用的工具核心 | 1–4 | 文本、文件预览、CSV；CLI 与 MCP 可用 |
| M2：可视化工作台 | 5 | 网页运行工具、看结果和历史、复制接入配置 |
| M3：完整示例与交付 | 6–7 | 六工具齐全，生产构建和完整验证 |

预计总量约 6–10 个专注开发日，仅用于排序和范围评估，不是交付承诺；第一轮骨架和依赖兼容验证后应重新估算。优先交付 M1，尽早验证用户最关心的 AI 调用方式。

### 16.2 首版之后的候选项

按实际使用反馈选择，不预先开发：

1. 文件整理执行：预览计划、明确确认、冲突处理、操作记录和恢复策略。
2. XLSX 分析：工作表选择、日期/数值类型、公式缓存值说明、大文件上限。
3. OCR：明确本地模型或第三方服务，以及语言、性能与数据流向。
4. 工具组合：先做少量固定配方，再判断是否需要通用工作流。
5. 长任务：可恢复任务记录与进度，而不是维持超长 HTTP 请求。
6. SQLite 历史：在摘要查询规模确实需要时替换存储实现。
7. 桌面包装：原生选择目录、托盘、自启动和安装包。
8. 远程访问：单独设计身份认证、密钥管理、传输保护和访问权限。

## 17. 文档检查与实施前确认点

### 17.1 本文自检清单

以下勾选只表示文档层面的一致性检查，不表示应用已实现或测试通过。

- [x] 六个工具都有明确输入、输出、限制与验收行为。
- [x] 网页、CLI、MCP 共享同一执行器，没有重复实现要求。
- [x] 文件根目录、配置相对路径、生产入口和运行记录位置一致。
- [x] PDF/CSV 能力边界明确，没有承诺 OCR 或完整 Excel 功能。
- [x] stdout、取消、超时、错误码与历史持久化规则一致。
- [x] 每个里程碑均定义了独立可演示的能力。
- [x] 计划中的代码块是契约或测试示例，没有把未实现代码描述为现成文件。
- [x] 计划阶段与实施阶段已明确分开，当前实现进度在第 19 节持续记录。

### 17.2 用户审阅时最值得调整的三项

- **工具优先级：** 当前先接通文本、文件预览、CSV，再加入 PDF、网页和环境检查。
- **使用形态：** 当前选择本机网页与本地 MCP；如必须跨设备使用，需要调整部署和认证设计。
- **文件操作深度：** 当前全部只读；实际整理、修改和导出写回需要单独明确范围。

## 18. 已核对的接口资料

- MCP TypeScript SDK v1 服务端工具注册与传输说明：
  https://github.com/modelcontextprotocol/typescript-sdk/blob/v1.x/docs/server.md
- MCP TypeScript SDK v1 安装与 Zod 兼容说明：
  https://github.com/modelcontextprotocol/typescript-sdk/blob/v1.x/README.md
- Fastify 应用构造与测试注入：
  https://github.com/fastify/fastify/blob/v5.12.7/docs/Guides/Testing.md
- Fastify 请求生命周期钩子：
  https://github.com/fastify/fastify/blob/v5.12.7/docs/Reference/Hooks.md

资料通过 Context7 核对，用来确定接口方向。最终安装版本、PDF 和 HTML 解析库的具体调用方式，在实施任务 1 和任务 6 中按实际依赖验证并锁定。

## 19. 实施记录

### 2026-11-02：开工

- 用户已明确要求“按计划开始搭建框架”。工作前已重读计划与文档同步偏好，重新核对目录仅含计划文档、Node v22.23.4 / npm 10.9.2。
- 实施顺序：工具契约与核心 → 示例工具及 CLI/MCP → HTTP 与网页 → 完整验证与文档回填。
- 阶段记录：先通过配置、注册表、文件能力与执行器测试，再完成 CLI/MCP/HTTP 和网页集成；最终验证结果以下方交付表为准。
- 接口补充：运行上下文提供只读 `limits`；文件能力增加受路径边界约束的 `exists(relativePath)`，供整理预览检查目标冲突；不增加文件写入能力。
- 执行适配：这是用户指定的非 Git 目录，原地实施；不创建 Git 仓库、提交或额外 worktree。任务状态与证据保存在本节，子代理使用当前会话模型，不启用嵌套代理；仅将所有权互不重叠的网页和工具文件并行开发。
- 兼容性修正：Windows Node `--import` 需要 file URL，子进程测试使用 `pathToFileURL`；PDF.js 6.5.438 要求 Node 22.13+，最低版本相应提高。
- 依赖核查：初次安装报告 static/CSV 依赖告警，已升级 `@fastify/static` 至 10.1.8、`csv-parse` 至 7.0.3；将传递依赖 glob/minimatch 固定为已修补版本 14.0.3/11.0.4，安装审计报告 0 个已知漏洞，静态资源行为仍须随生产构建验证。
- 子任务恢复：基础工具子代理连接中断，仅留下测试；主线程检查后接手实现文本、文件预览和 CSV，保留其行为测试作为验收依据。
- 验证范围：先自动测试核心与真实 CLI/MCP 子进程，再运行生产构建和浏览器端到端检查；未完成的实际客户端接入不冒称已连接。
- 浏览器验收调整：首次页面检查发现 4310 端口由本机 QQ 占用，已核对进程身份并确认 4318 空闲。将默认 API 端口、开发代理、端到端入口和相关测试同步为 4318，保留 QQ 进程；补充前端单元测试脚本与 TSX 测试类型检查，再执行回归验证。
- 页面收尾：14 项端到端测试已通过。复核发现 CSV 字段信息引用了输出契约不存在的 `nonEmptyCount`，将增加独立预期断言后，改用总行数减空值数；补验 PDF、环境、文件预览、键盘焦点、长文本和生产 CSP 下的浏览器错误。Tailwind 颜色映射改为匹配现有十六进制 CSS 变量。

| 检查项 | 最终状态 | 证据 |
| --- | --- | --- |
| 类型检查与构建 | 通过 | `npm run typecheck` 包含前端、后端、TS/TSX 测试；`npm run build` 成功生成两个 dist 目录 |
| 依赖审计 | 通过 | `npm audit --omit=dev`：0 个已知漏洞 |
| 核心、工具与适配器 | 通过 | `npm test`：101 项，100 通过、1 跳过、0 失败；跳过 Windows 大小写同名文件 |
| 前端单元检查 | 通过 | `npm run test:web`：10/10，含 CSV 非空字段数量修复、媒体流表格渲染 |
| 生产协议交叉验证 | 通过 | `npm run test:production`：1/1；非项目 cwd 启动编译 CLI/MCP，与编译 HTTP 比较同一 CSV 完整 data；PDF Worker 提取两页；MCP 暴露 11 个工具 |
| 浏览器端到端 | 通过 | 编译生产服务 20/20，启用 CSP，覆盖真实 API、下载内容、复制/降级、取消/切换竞态、重试、375/1440px、键盘、10 万字符、PDF/环境/文件预览、影音与文档工具 |
| 手动浏览器检查 | 通过 | 开发 CSV 合计 20、不存在文件报错并保留参数；PDF 两页 616 字符；生产网页提取 Node.js 官网 2,357 字符 |
| 控制台与网络 | 通过 | 生产 PDF/环境/文件预览流程采集 pageerror、console error、requestfailed，均为空 |
| 只读代码审查 | 主线程复核完成 | 核心边界、执行器、PDF、公网固定 DNS、进程探测、适配器与前端结果/状态均已检查；独立子代理因连接及 Windows 元数据路径错误未返回审查结论 |

### 2026-11-02：交付与运行

- 已注册 11 个工具：`files_plan`、`text_stats`、`csv_summary`、`pdf_extract`、`web_extract`、`env_inspect`、`bilibili_video`、`douyin_video`、`douyin_nowatermark`、`doc_convert`、`photo_compress`。
- 当前可访问工作台：`http://127.0.0.1:4318/`；开发页面为 `http://127.0.0.1:5173/`。本轮额外使用 `http://127.0.0.1:4319/` 验证编译生产模式，不改动正式配置。
- 首次安装/新终端：在项目目录运行 `npm ci` → `npm run samples` → `npm run build` → `npm start`。依赖和样例已在本机准备完成，再次启动通常只需 `npm start`；当前服务已运行时无需重复启动。
- 修改代码时使用 `npm run dev`，前端访问 5173，API 使用 4318。若端口已被已有实例占用，先使用该实例或在所属终端正常停止后再启动；不要终止不明进程。初始默认 4310 与 QQ 冲突，因此改为 4318。
- 本轮进程清理的自动审批拒绝了 `Stop-Process`，理由为未确认进程归属；未重试终止或影响 QQ，保留临时开发服务，并用独立端口完成生产验证。
- 验收临时配置 `test-results/production.config.ts` 及截图保存在忽略目录中；桌面/窄屏画面为 `test-results/catalog-desktop.png`、`test-results/catalog-mobile.png`。
- 文件工作区为 `sandbox`，配置是 `workstation.config.json`；样例包括 `samples/sales.csv`、`samples/guide.pdf`、`samples/photo.jpg`、`samples/text-input.json` 和 `inbox` 中的三个文件。工具产物写入 `sandbox/downloads`；运行记录仅在 `.workstation/runs` 保存元数据摘要。
- AI 接入：打开“AI 接入”页面，复制由实际 Node 路径、MCP 编译入口和配置路径生成的 JSON。真实 SDK 握手/调用自测通过；尚未修改或验证任何外部 AI 客户端的实际连接。
- CLI 示例：`node dist/server/adapters/cli/main.js list --json`；`node dist/server/adapters/cli/main.js run csv_summary --input '{"path":"samples/sales.csv"}'`（后一条适用于 Git Bash；PowerShell 可使用 `--input-file`）。
- 增加工具：在 `src/tools` 用 `defineTool` 声明严格输入输出、字段、示例与能力，在 `src/tools/index.ts` 注册，添加行为测试；目录/CLI/MCP 共用注册表，无需复制业务逻辑。

### 已知限制与下一步

- 工作区仍保持只读：整理工具仅生成计划，下载与转换产物只写入受限输出目录；CSV 不支持 XLSX；PDF 不做 OCR；网页提取不运行脚本、不访问登录页面；环境工具只检查 Node/Git。
- 验证环境为 Windows；大小写同名目标冲突用例被文件系统限制跳过。CLI 真实 SIGINT 和运行中 stdio 意外断开尚未做操作系统级测试；核心及 HTTP/MCP 调用取消、PDF Worker 终止已验证。
- 未进行真人屏幕阅读器检查、跨平台验收或恶意同权限进程并发替换文件的攻防验证；该工具是可信用户的本地工作站，不是第三方代码沙箱。
- 独立审查未获得结论，以上审查属于主线程复核。未初始化 Git、未发布远程服务、未修改 AI 客户端设置。
- 当前框架已可本机试用；后续按实际需求选择客户端接入、XLSX、OCR或经过确认的文件移动能力，不自动扩大本轮范围。

### 2026-11-02：第二轮影音与文档工具

- 用户提出 B 站视频提取、抖音视频提取、抖音去水印、PDF/Word 格式转换、照片压缩五项需求，先给候选方案清单再实现。
- 研究结论：B 站 view/playurl 接口可用，但必须先取 `buvid3` cookie 并在下载时带 `Referer`；抖音匿名签名（a_bogus）在本机被风控拒绝，改用本机 Chrome 捕获官方 `aweme/detail` 响应；本机已具备 LibreOffice、pandoc 与 Word COM，文档转换可混合使用；`sharp` 预编译二进制可用。
- 实现：新增 `bilibili_video`、`douyin_video`、`douyin_nowatermark`、`doc_convert`、`photo_compress` 五个工具；新增 `files:write` 能力与 `outputDirectory`（默认 `sandbox/downloads`）、`process:convert`、`browser:local` 能力声明；公网客户端新增 JSON 与二进制请求并对请求头做白名单过滤。
- 真实调用：B 站示例稿件解析成功并下载 5,492,083 字节 MP4；抖音示例作品解析成功，无水印文件 2,577,862 字节、带水印文件 4,058,760 字节；PDF→Word 618 字符、DOCX→Markdown 回读一致；图片→PDF 成功；照片压缩 73,463 → 8,640 字节。
- 回归：`npm test` 88 项（87 通过、1 跳过）、`npm run test:web` 10 项、`npm run test:e2e` 17 项（生产模式）、`npm run test:production` 1 项全部通过；`npm audit --omit=dev` 0 漏洞；类型检查与构建通过。
- 未覆盖：抖音登录后可见作品、平台风控升级后的稳定性、缺少 LibreOffice/pandoc 时的完整降级矩阵、浏览器连接器在本轮后段多次超时（该段以 Playwright 用例代替手动验收）。
- 合规提醒：下载第三方平台视频前请自行确认平台服务条款与版权授权范围；本工具只处理公开内容，不绕过登录或付费限制。

| 检查项 | 最终状态 | 证据 |
| --- | --- | --- |
| 五个新工具的单元与集成测试 | 通过 | `tests/tools/media.test.ts` 16 项：压缩体积下降、PDF→DOCX 文本往返、图片→PDF、B 站解析与音轨分离、抖音链接解析、写入边界与体积上限、内置排版引擎中文回读 |
| 真实平台调用 | 通过 | B 站 5,492,083 字节 MP4 + 2,576,587 字节独立 M4A 落盘；抖音无水印 2,577,862 字节与水印版 4,058,760 字节对照；抖音原声音频 17,616,087 字节 MP3 可下载 |
| 内置文档转换链路 | 通过 | 不再调用 LibreOffice/pandoc：DOCX→PDF 由内置排版引擎输出 3,706 字节（此前经 LibreOffice 需 38 秒），中文 PDF 10,539 字节且文本可回读 |
| 抖音自签名直连 | 通过（平台限流待复验） | 自签名直连两次返回完整 `aweme_detail` 与无水印播放地址；随后平台对本机匿名访问限流，引导请求不再下发 detail，工具改为明确报错 |
| 网页端到端 | 通过 | 生产模式下 17 项用例，含新工具目录分类、照片压缩与 PDF→Markdown 的页面执行 |
| 依赖与审计 | 通过 | 运行时依赖新增 `sharp`、`docx`、`mammoth`、`playwright-core`、`abogus`、`@pdf-lib/fontkit`；审计 0 漏洞 |

### 2026-11-02：第三轮内置化与音轨分离

- 用户要求把能力内置到工作站进程内，而不是调用外部程序，并希望每项功能给出多种实现方法。
- 方案对比结论：B 站保留官方接口方案（补 WBI 签名可作后续增强，自研 DASH 合并器工作量过大）；抖音采用自签名直连 + 浏览器一次性引导（自造 uifid 会被拒，复刻其 JS 等同逆向维护）；格式转换采用自写排版引擎（外部程序保真高但违背要求）；照片压缩沿用进程内 `sharp`。
- 已移除对 LibreOffice 与 pandoc 的调用，`src/core/converter.ts` 删除，新增 `src/core/html-blocks.ts`、`markdown.ts`、`docx-build.ts`、`pdf-layout.ts`、`fonts.ts`；`process:convert` 能力随之取消。
- 排版引擎排障：字体必须内嵌到目标文档，否则跨文档引用导致文字全部丢失；CFF/OTF 字体无法被 fontkit 子集化，改为优先 TrueType 中文字体并按候选回退。
- 音轨分离：B 站新增 `parts` 选项（视频 / 音频 / 两者），抖音新增同名选项并取作品原声 MP3。
- 公网客户端新增受控端口白名单（B 站音频 CDN 使用 8082），私网地址与 DNS 固定策略不变。
- 回归：`npm test` 92 项（91 通过、1 跳过）、`npm run test:web` 10 项、`npm run test:e2e` 17 项、`npm run test:production` 1 项全部通过；类型检查与构建通过。
- 未覆盖：抖音被限流期间的端到端复验、缺少系统中文字体时的 PDF 中文输出、其他平台的 CJK 字体嵌入。

### 2026-11-02：第五轮 去水印开关与打开输出目录

- 用户要求给 B 站与抖音视频提取加“去水印”开关，并新增“打开处理后文件所在文件夹”的按钮。
- 实证结论（用 ffmpeg 抽帧对比）：B 站同一稿件的 html5 MP4 与 DASH 原始流画面逐像素一致，接口也不存在水印相关字段——可见水印是 UP 主自己烧进画面的，平台不额外加水印；抖音才是真正同时提供无水印源与带水印源。
- 实现：抖音开关在 `play_addr`（无水印）与 `download_addr`（带水印）之间切换并输出 `source`；B 站开关在 DASH 原始流与单文件转码 MP4 之间切换，并在结果里说明源片自带水印需重编码裁剪（不做图像处理）。新增 `POST /api/output/open` 与结果面板的「打开输出文件夹」按钮，服务端只允许打开配置的输出目录。
- 配套：B 站 CDN 端口白名单扩到 8080/8082，下载失败自动改用备用镜像；抖音接口返回非 JSON 时给出“平台风控限流”的明确提示。
- 回归：`npm test` 99 项（98 通过、1 跳过）、`npm run test:web` 10 项、`npm run test:e2e` 18 项、`npm run test:production` 1 项全部通过；类型检查、构建与依赖审计通过。
- 未覆盖：抖音本轮仍被平台限流，去水印开关的真实链路待限流解除后复验；开关逻辑已用单元测试覆盖。

### 2026-11-02：第六轮 跨页面进度保持

- 用户反馈：处理中切换页面会导致进度丢失。根因是工具页组件卸载时中止了请求，后端随之取消任务。
- 修正：新增前端全局运行仓库，运行状态、请求与进度订阅不再随页面卸载销毁；只有显式取消或对同一工具重新运行才会中止。顶栏新增运行中任务指示，返回工具页时进度与结果继续显示；整页刷新后用 sessionStorage 保存的运行号重新查询服务端进度并接回事件流。
- 回归：`npm test` 99 项、`npm run test:web` 10 项、`npm run test:e2e` 19 项、`npm run test:production` 1 项全部通过；新增端到端用例覆盖“运行中切到 AI 接入页 → 顶栏仍显示运行中 → 回到工具页看到完成结果”。

### 2026-11-02：第七轮 关掉页面任务继续跑

- 用户确认要“关掉页面任务继续跑、结果可回看”。这改变了取消语义：HTTP 断开不再等于取消。
- 服务端：执行器为每次运行持有自己的取消控制器；取消改由 `POST /api/runs/:runId/cancel` 显式触发，CLI 的 SIGINT 与 MCP 取消信号保持原样。结果在内存中保留（最多 50 条、12 小时），新增 `GET /api/runs/:runId/result` 与 `GET /api/runs/latest?tool=…`。
- 前端：取消改为调用服务端接口；工具页打开时自动接管仍在运行的任务（进度接回事件流，结束后自动取回结果），已结束的历史结果改为「查看上次运行结果」按钮按需载入，避免新页面上出现“刚跑出来的”错觉。
- 回归：`npm test` 101 项（100 通过、1 跳过）、`npm run test:web` 10 项、`npm run test:e2e` 20 项、`npm run test:production` 1 项全部通过；新增接口层用例覆盖“客户端断开后任务跑完并可取回结果”与“显式取消仍然生效”，新增端到端用例覆盖“关掉标签页后回来仍能取回结果”。

### 2026-11-02：第四轮 Git 版本记录、运行进度与 XLSX 分析

- 按用户要求初始化 Git（`main` 分支），并把此前的工作按阶段整理成可读的历史：工程骨架 → 核心执行器与基础工具 → 三个调用入口 → 网页工作台 → 内置转换与影音工具 → 样例与生产验证。未配置远程仓库，未推送任何内容。
- 新增运行进度通道：工具通过 `reportProgress` 上报阶段与真实进度，`ProgressStore` 按运行号维护状态，网页端用 SSE 订阅（不可用时降级轮询），界面显示进度条、当前阶段与步骤时间线。
- 新增 `xlsx_summary` 工具：用 ExcelJS 读取工作簿，输出工作表清单、表头、行数与逐列类型与数值统计，只读不改写。
- 排障记录：PDF 工作线程原本用 `once('message')` 接收结果，改为进度消息后第一条消息被占用导致结果丢失，改为持续监听并区分进度帧；SSE 在没有进行中的任务时不推送首帧会让客户端一直等待，改为总是先推一帧；服务端在运行结束时主动关闭事件流，避免客户端中断被记为失败请求。
- 回归：`npm test` 97 项、`npm run test:web` 10 项、`npm run test:e2e` 18 项、`npm run test:production` 1 项全部通过；类型检查、构建与依赖审计通过。


## 20. 三端扩展的架构调研（2026-11-03）

用户目标：工作站扩到桌面端与手机端，三端共享同一套工具与数据；手机端本轮不实现，用户会提供一个服务器，手机端通过链接服务器使用功能。本节记录调研结论与候选方案，实施前需用户确认服务器条件。

### 20.1 关键判断：执行面留在设备，服务器只做协调

现有工具都绑定在“运行它们的那台机器”上：文件工具要读本地工作区，抖音解析要本机 Chrome，PDF 输出要本机中文字体，网页抓取受该网络出口影响。因此**执行节点必须是用户自己的设备**，服务器不执行工具，只承担三件事：设备注册与鉴权、任务队列与路由、共享状态（工具目录、运行摘要、产物引用）。

由此确定“三端同步”的语义：

| 同步对象 | 方向 | 说明 |
| --- | --- | --- |
| 工具目录与能力 | 节点 → 服务器 → 各端 | 各节点能力不同（有 Chrome、有本地文件），客户端按目标节点的能力渲染表单 |
| 任务与进度 | 客户端 → 服务器 → 节点 → 回传 | 手机端下发任务，节点执行，进度实时回传并在各端显示 |
| 运行摘要历史 | 节点 → 服务器 | 追加型数据，天然可合并，不产生写冲突 |
| 产物文件 | 留在节点本地 | 服务器只存元数据与下载请求，不中转大文件，避免带宽与隐私成本 |

### 20.2 桌面端形态候选

| 方案 | 做法 | 优点 | 代价 |
| --- | --- | --- | --- |
| A PWA（推荐起步） | 现有 `dist/web` 加 manifest、service worker 与启动器 | 零新增运行时，前端代码全部复用，Windows/macOS/Linux 通用，手机也能“添加到主屏幕” | 没有系统托盘与开机自启；受浏览器沙箱限制 |
| B Electron | 壳内嵌现有 Fastify 服务与窗口 | Node 运行时现成（工具本身就是 Node），可做托盘、自启、原生文件对话框 | 安装包约 150MB，内存占用高 |
| C Tauri | Rust 壳拉起 Node 服务 | 体积小（5–10MB） | 需要 Rust 工具链；仍要随包分发 Node 服务 |
| D Neutralino / Electrobun 等轻壳 | 更小体积 | 体积与内存都低 | 生态与原生能力有限 |

选择 A 起步：核心资产是 Node 后端，PWA 零成本复用同一份 `src/web`；等确实需要托盘、开机自启或原生对话框时再上 B（Electron 自带 Node，迁移成本最低，Tauri 反而要额外引入 Rust 工具链）。

### 20.3 手机端接入路径候选

| 方案 | 做法 | 优点 | 代价 |
| --- | --- | --- | --- |
| A 服务器中继 + 节点出站长连接（推荐） | 桌面节点主动与服务器保持 WebSocket/SSE，手机只与服务器对话 | 不用给桌面节点开公网端口，规避 NAT 与打洞；手机端实现最简单 | 需自建中转服务与鉴权 |
| B 服务器反向轮询节点 | 服务器定期问节点要任务 | 无长连接实现 | 延迟高；桌面在 NAT 后时服务器也连不上，仍需节点出站 |
| C 组网直连（Tailscale / NetBird） | 手机与桌面组同一 WireGuard 网络 | 零中转代码 | 手机要装 VPN 客户端，且与“提供服务器”的思路不符 |
| D Cloudflare Tunnel 暴露桌面节点 | 直接把节点挂到公网域名 | 配置最省事 | 把执行面直接暴露到公网，风险最高 |

选择 A：把桌面节点放在“主动出站”的位置，服务器不直接暴露执行面；公网上只存在带鉴权的元数据与任务接口。

### 20.4 服务器形态

- 用户的 VPS 上跑一个容器：Node 服务 + SQLite（任务、摘要、节点注册）+ 可选对象存储（产物）。
- 反代用 Caddy/Nginx 自动签 TLS；节点与手机端各自持一枚设备令牌，服务器只接受已注册令牌的请求。
- 服务器不做工具执行，不中转媒体文件；需要产物时由节点按请求上传或提供一次性下载。

### 20.5 现有代码需要补的部分

1. 节点身份与鉴权：设备 ID + Bearer 令牌中间件，覆盖现有全部 `/api/*`。
2. 节点能力清单：`GET /api/node/identity` 返回版本、能力（是否有 Chrome、能否写文件）与可用工具列表，供服务器缓存与路由。
3. 服务器触达节点的任务入口：复用现有 `POST /api/tools/:name/run`，由服务器按节点路由调用（不经公网直接暴露给手机端）。
4. 进度与结果转发：现有 SSE `/api/runs/:runId/events` 与 `/api/runs/:runId/result` 可被服务器订阅与代理。
5. 摘要落盘策略：目前只在节点内存与 `.workstation/runs`；多端共享需要节点把摘要推给服务器（或服务器定期拉取）。
6. 桌面端外壳：PWA manifest + service worker + 启动器脚本；可选 Electron 托盘版。
7. 前端复用：现有界面已通过 375px 与 1440px 布局验证，天然可在手机浏览器使用，这是“手机端不做原生 App”的前提。

### 20.6 待用户确认的服务器条件

1. 服务器形态与地域：自有 VPS / 云主机 / NAS？是否已有域名与证书？
2. 是否接受用 Docker 部署中继服务（推荐），还是希望直接跑 Node 进程？
3. 节点与手机端的鉴权方式：设备令牌 + 扫码配对是否可接受？
4. 产物是否需要经服务器中转，还是保留在节点本地按需下载？
5. 桌面端是否需要开机自启与托盘（决定 PWA 还是 Electron）？

