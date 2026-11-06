# Henry 工作站（henrychips）

> 仓库名是 `henrychips`，但**代码里的产品定位是「个人工作站」**——根 `package.json` 的 `name` 是 `personal-workstation`，Electron 应用名是「Henry 工作站」，MCP server 名是 `personal-workstation`，Web 标题是「Henry 工作站 · 个人工具空间」。下文以代码里的定位为准。

一个**本地优先的个人工具工作站**：把文件、文本、表格、PDF、网页、影音等日常处理能力收敛成**一套工具**，再把这套工具同时接到**网页工作台、命令行、MCP（AI 客户端）**三个入口上。工具永远跑在你自己这台机器上；数据不出本机。

---

## 这是什么 / 解决什么问题

日常的"小工具"通常散落在十几个脚本里：抓网页的、写 Excel 的、转 PDF 的，各写各的，参数各写各的，AI 也接不上。

这个项目想解决三件事：

1. **只实现一次。** 每个工具用 `defineTool`（`src/core/define-tool.ts`）声明严格的 Zod 输入/输出 Schema，登记到 `ToolRegistry`（`src/core/registry.ts`）。执行逻辑只有一份（`ToolExecutor`，`src/core/executor.ts`），网页、CLI、MCP 三个适配器只负责把参数映射成各自的形态。
2. **三种姿势随手切。** 想手动点点就用网页工作台；想进 shell 脚本就用 CLI；想让 AI 帮你干活就把 MCP 配置贴进客户端——**三边拿到的是同一批工具、同样的结果**（`tests/production.test.ts` 就是专门断言这件事的）。
3. **本地优先，边界清楚。** 工作区（`sandbox/`）**只读**、产物目录（`sandbox/downloads/`）**只写**、运行摘要（`.workstation/`）另存；公网请求走一套会拒绝私网地址、固定 DNS 解析结果的自建客户端（`src/core/public-http.ts`）。跨设备用"中继"时，**服务器只做登记和路由，工具永远在设备本地跑，产物也留在设备本地**。

---

## 功能特性

### 工具内核（`src/core/`）

| 能力 | 实现位置 | 说明 |
| --- | --- | --- |
| 工具注册表 | `src/core/registry.ts` `ToolRegistry` | 工具名必须匹配 `^[a-z][a-z0-9_]*$`，重名直接报错；`list()` 输出 JSON Schema |
| 工具定义 | `src/core/define-tool.ts` `defineTool` | 输入/输出都走 Zod `strictObject`，校验失败抛 `INVALID_INPUT`，输出不符约定抛 `TOOL_FAILED` |
| 执行器 | `src/core/executor.ts` `ToolExecutor` | 并发上限 4、超时按 `min(工具声明值, 120s)`、取消、结果在内存保留最近 50 条（最长 12 小时） |
| 运行摘要 | `src/core/run-store.ts` `RunStore` | 每次运行写一份 `<stateDirectory>/runs/<runId>.json`，按文件大小+修改时间缓存解析结果 |
| 运行进度 | `src/core/progress.ts` `ProgressStore` | 工具用 `reportProgress({phase, percent})` 上报，网页端用 SSE 订阅，不可用时降级轮询 |
| 文件边界 | `src/core/file-access.ts` `createFileAccess` / `createFileWriter` | 拒绝绝对路径、`..`、UNC、Windows 设备名；输出禁止符号链接/联接点，默认不覆盖同名文件 |
| 公网客户端 | `src/core/public-http.ts` `createPublicHttp` | 只允许 HTTP/HTTPS 公共地址，解析结果**钉死**在连接器上（防 DNS 重绑定），端口白名单，请求头白名单 |
| 环境探测 | `src/core/process-probe.ts` `createProcessProbe` | 只跑固定的 `git --version`（`shell: false`，3 秒超时），不接收任意命令 |
| 桌面/网页互通 | `src/core/opener.ts` `openDirectory` | 结果面板的「打开输出文件夹」只打开配置里的输出目录 |

### 已注册的 12 个工具（`src/tools/`，注册于 `src/tools/index.ts`）

| 工具 | 文件 | 能力 | 说明 |
| --- | --- | --- | --- |
| `text_stats` | `text-stats.ts` | — | 中英文字符/行数/汉字/拉丁词统计，按 Unicode 码点计数，上限 100,000 字符 |
| `files_plan` | `files-plan.ts` | `files:read` | 文件整理**预览**：按扩展名分 7 类并检测目标冲突，**只预览，不移动不修改** |
| `csv_summary` | `csv-summary.ts` | `files:read` | UTF-8 CSV 行列统计、每列空值数、数值列 `min/max/sum/mean`、前 5 行预览 |
| `pdf_extract` | `pdf-extract.ts` + `pdf-text.ts` / `pdf-worker.ts` | `files:read` | 按页提取 PDF 文字层，单次最多 30 页、10 万字符；在 Worker 里解析，取消/超时终止 Worker |
| `xlsx_summary` | `xlsx-summary.ts` | `files:read` | 读 `.xlsx` 工作簿：工作表、表头、行数、逐列类型与数值统计、高频取值（只读） |
| `doc_convert` | `doc-convert.ts` + `core/html-blocks.ts`、`core/markdown.ts`、`core/docx-build.ts`、`core/pdf-layout.ts`、`core/fonts.ts` | `files:read` `files:write` | PDF / DOCX / Markdown / HTML / TXT / 图片 之间互转，**全部在本进程内完成**，不调用 LibreOffice 或 pandoc；中文 PDF 用 `@pdf-lib/fontkit` 子集内嵌系统 TrueType 中文字体 |
| `photo_compress` | `photo-compress.ts` | `files:read` `files:write` | `sharp` 压缩照片，可转 JPEG/WebP/AVIF、限制最长边、默认移除 EXIF，返回压缩前后体积对比 |
| `web_extract` | `web-extract.ts` | `network:public` | 抓公共网页取正文（`linkedom` 解析），输出带 `untrustedContent: true` 标记 |
| `env_inspect` | `env-inspect.ts` | `process:probe` | 看平台、架构、Node 与 Git 版本 |
| `bilibili_video` | `bilibili-video.ts` | `network:public` `files:write` | 解析 B 站稿件与媒体直链；先取 `buvid3` cookie，再调 `view`/`playurl`；DASH 可分离音轨；CDN 放行 80/443/8080/8082 |
| `douyin_video` | `douyin-video.ts` + `douyin-core.ts` | `network:public` `files:write` `browser:local` | 解析抖音作品：标题、作者、封面、视频/音轨直链，可分别保存 |
| `douyin_nowatermark` | `douyin-nowatermark.ts` | `network:public` `files:write` `browser:local` | 对比平台播放地址（无水印）与下载地址（带 `watermark=1`），可单独保存无水印视频或音轨 |

> 抖音取数靠 `src/core/douyin-session.ts`：用 `playwright-core` 驱动**本机已安装的 Chrome** 做一次性引导，抓到 `uifid` 与签名参数模板后交给 `abogus` 自签名直连接口；会话缓存在状态目录 `douyin-session.json`（约 6 小时）。

### 三个调用入口

| 入口 | 位置 | 形态 |
| --- | --- | --- |
| 网页工作台 | `src/adapters/http/`（Fastify 5）+ `src/web/`（React 19） | `http://127.0.0.1:4318/`，四个页面：工具箱、执行记录、AI 接入、服务器 |
| CLI | `src/adapters/cli/main.ts` | `list` / `inspect` / `run`，输出 JSON；`SIGINT` 取消并以退出码 130 结束 |
| MCP | `src/adapters/mcp/server.ts`、`main.ts` | stdio 传输，把 **全部 12 个工具**注册为 MCP 工具，带 `structuredContent` 与 `readOnlyHint`/`destructiveHint`/`openWorldHint` 注解 |

### HTTP API（`src/adapters/http/routes.ts`）

`GET /api/health`、`GET /api/tools`、`GET /api/tools/:name`、`POST /api/tools/:name/run`、`GET /api/node/identity`、`GET /api/integrations`、`GET /api/runs`、`GET /api/runs/latest`、`GET /api/runs/:runId/result`、`GET /api/runs/:runId/progress`、`GET /api/runs/:runId/events`（SSE）、`POST /api/runs/:runId/cancel`、`POST /api/output/open`、`GET /api/relay/status`。

安全约束在 `src/adapters/http/app.ts`：**只接受本机 Host 与同源 Origin**，生产模式带 CSP（`default-src 'self'`），`/api/*` 一律 `no-store`；错误按 `ErrorCode` 映射成对应 HTTP 状态码。

### 桌面端（`electron/main.mjs`）

Electron 45.2.1 主进程里**直接跑服务**（不 spawn 子进程，打包后代码在 `app.asar` 里也读得到）：

- 托盘菜单：打开工作台 / 打开输出文件夹 / 开机自动启动 / 退出；**关窗口只是隐藏，进程留在托盘继续提供服务**。
- 配置与工作区移到 `%APPDATA%/personal-workstation/`，首次启动自动生成 `workstation.config.json`、`sandbox/`、`sandbox/downloads/`、`state/`。
- 窗口开 `contextIsolation: true`、`nodeIntegration: false`、`sandbox: true`；外部链接交给系统浏览器。
- 启动前会探测 4318 是否已有健康实例，避免抢端口。

### PWA 外壳（`public/`）

`public/manifest.webmanifest` 提供名称、图标与三个快捷方式（工具箱 / 执行记录 / AI 接入）；`public/sw.js` 缓存离线外壳（`/`、`/index.html`、`/manifest.webmanifest`、`/icons/icon.svg`），**`/api/` 请求一律不缓存**。

### 中继（Relay）与跨设备（`src/relay/`、`src/adapters/relay/`）

- **服务器端**：`src/relay/server.ts` `RelayServer` + `src/relay/store.ts` `RelayStore`（用 Node 内置 `node:sqlite`，无原生依赖）。接口：`/relay/health`、`/relay/pair`、`/relay/devices`、`/relay/tasks`（GET/POST）、`/relay/runs`、`/relay/node/register`、`/relay/node/poll`（25 秒长轮询）、`/relay/node/events`（NDJSON 进度流）。
- **设备端**：`src/adapters/relay/main.ts` 节点连接器（**始终由设备主动外连，中继不回调**），`src/adapters/relay/pair.ts` 配对并把凭据写回 `workstation.config.json` 的 `relay` 段。
- **鉴权**：`pairCode` 换设备令牌；可选 `deviceToken` 用 `timingSafeEqual` 做 Bearer 校验。
- **边界**：中继**不执行任何工具**，只登记、路由和回传摘要；产物始终留在设备本地。

### 沙箱隔离

不是容器级沙箱，而是**目录级读写分离 + 网络白名单**：

- `sandbox/` 是 `workspaceRoot`，只读；`sandbox/inbox/`、`sandbox/samples/` 是预置样例。
- `sandbox/downloads/` 是 `outputDirectory`，工具产物的**唯一可写**目录。
- `.workstation/` 存运行摘要等状态。
- 路径越界（`..`、绝对路径、UNC、设备名、符号链接、联接点）一律 `ACCESS_DENIED`。

---

## 技术栈

| 领域 | 依赖 | 版本 |
| --- | --- | --- |
| HTTP 服务 | `fastify` / `@fastify/static` | 5.12.7 / 10.1.8 |
| MCP | `@modelcontextprotocol/sdk` | 1.32.2 |
| 浏览器自动化 | `playwright-core`（运行时）/ `@playwright/test`（测试） | 1.64.1 / 1.64.1 |
| PDF | `pdf-lib` / `@pdf-lib/fontkit` / `pdfjs-dist` | 1.17.1 / ^1.1.1 / 6.5.438 |
| 文档 | `mammoth` / `docx` | 1.13.0 / 9.15.1 |
| 表格 | `read-excel-file` / `csv-parse` | 9.3.14 / 7.0.3 |
| 图像 | `sharp` | 0.35.5 |
| HTML 解析 | `linkedom` | 0.18.15 |
| 反爬签名 | `abogus` | 2.1.1 |
| HTTP 客户端 / IP 判定 | `undici` / `ipaddr.js` | 7.30.1 / 2.5.0 |
| 校验 | `zod` | 4.6.7 |
| 前端 | `react` / `react-dom` / `lucide-react` | 19.3.1 / 19.3.1 / 1.66.0 |
| 桌面 | `electron` / `electron-builder` | 45.2.1 / 26.18.0 |
| 构建 | `typescript` / `vite` / `tailwindcss` / `postcss` / `autoprefixer` | 5.9.3 / 7.3.7 / 3.4.17 / 8.5.32 / 10.6.2 |
| 工具链 | `tsx` / `concurrently` | 4.23.15 / 9.2.5 |

---

## 系统要求

- **Node.js `>= 22.13.0`**（`package.json` 的 `engines` 字段）。这个下限同时是 `pdfjs-dist` 6.5.438 的要求，也是 Node 内置 `node:sqlite`（中继存储）的可用版本。
- **npm**（有 `package-lock.json`，建议 `npm ci`）。
- **桌面端**：随 `npm install` 装上 Electron 45.2.1；**打包目标目前只有 Windows x64**（`electron-builder.json` 的 `win.target = ["nsis"]`，`desktop:dist` 固定 `--win --x64`）。桌面版自带 Node 运行时，**安装后不需要另装 Node**。
- **抖音相关工具**：需要本机已安装 Google Chrome（`playwright-core` 以 `channel: 'chrome'` 启动）。
- **PDF 中文输出**：需要系统里有 TrueType 中文字体（`src/core/fonts.ts` 按 SimHei → 等线 → 微软雅黑 顺序取；CFF/OTF 无法子集化，不作候选）。找不到中文字体时退回 Helvetica 并在结果里提示。
- **中继服务器**：Node 22.13+（见 `deploy/RELAY-DEPLOY.md`）。

---

## 快速开始

### 前置条件

Node.js `>= 22.13.0`；桌面端需要 Windows（打包目标）。

### 1. 安装依赖

```bash
npm install
```

### 2. 准备样例文件

`sandbox/samples/guide.pdf` 与 `sandbox/samples/photo.jpg` 由脚本生成（已存在则保留，不覆盖）：

```bash
npm run samples
```

### 3. 构建

```bash
npm run build
```

产出 `dist/server/`（TypeScript 编译）与 `dist/web/`（Vite 构建）。

### 4. 启动

三个入口的差别很重要，别搞混：

| 命令 | 起什么 | 说明 |
| --- | --- | --- |
| `npm run launch` | 本地服务 + 自动打开浏览器 | `bash scripts/start-workstation.sh`。首次运行会自动 `npm install`、必要时 `npm run build`，然后在 `http://127.0.0.1:4318/` 打开工作台，并把地址写进 `.workstation/port`。**依赖 bash**（Windows 上用 Git Bash 或 WSL） |
| `npm run dev` | 开发模式：API 4318 + 前端 5173 | `concurrently` 同时跑 `tsx watch src/adapters/http/server.ts --dev` 与 `vite --host 127.0.0.1`；前端页面在 `http://127.0.0.1:5173/`，`/api` 由 Vite 代理到 4318 |
| `npm start` | 生产模式（仅服务） | 跑 `node dist/server/adapters/http/server.js`，需先 `npm run build` |
| `npm run cli` | 命令行 | `tsx src/adapters/cli/main.ts`，**开发期**直接跑 CLI；生产用 `node dist/server/adapters/cli/main.js` |
| `npm run mcp` | MCP stdio 服务 | `tsx src/adapters/mcp/main.ts`，**仅用于调试**；给 AI 客户端用时应指向编译产物 `dist/server/adapters/mcp/main.js` |

最简路径：

```bash
npm install && npm run samples && npm run build
npm start          # 然后打开 http://127.0.0.1:4318/
```

或一步到位（需 bash）：

```bash
npm run launch
```

### 5. 命令行试一把

```bash
npm run cli -- list --json
npm run cli -- inspect csv_summary
npm run cli -- run csv_summary --input '{"path":"samples/sales.csv"}'
```

`--input` 传 JSON 字符串；大段输入用 `--input-file <路径>`（两者互斥）。`--config` 必须给**绝对路径**。生产环境：

```bash
node dist/server/adapters/cli/main.js run csv_summary --input-file sandbox/samples/text-input.json
```

### 6. 接给 AI 客户端（MCP）

工作台的「AI 接入」页会生成**当前这台机器真实可用**的 MCP 配置（取自 `GET /api/integrations`，包含真实 Node 路径、编译产物路径与配置文件路径），复制后合并进 MCP 客户端即可。手工配置的形状是：

```json
{
  "mcpServers": {
    "personal-workstation": {
      "command": "<你的 node 可执行文件路径>",
      "args": ["<项目目录>/dist/server/adapters/mcp/main.js", "--config", "<项目目录>/workstation.config.json"]
    }
  }
}
```

客户端会看到全部 **12 个工具**。

### 7. 桌面端

```bash
npm run desktop        # 构建后启动 Electron 外壳
```

---

## 目录结构

| 路径 | 职责 |
| --- | --- |
| `src/contracts/` | 可序列化的公共类型：`tool.ts`（工具描述、字段定义、能力、文件/网络/进程接口）、`run.ts`（运行来源、结果、错误码）、`relay.ts`（中继状态） |
| `src/core/` | 内核：注册、定义、执行器、文件读写边界、公网客户端、进程探测、运行摘要、进度、配置、错误、内置排版与字体 |
| `src/tools/` | 12 个工具的实现与 `index.ts` 注册表 |
| `src/adapters/http/` | Fastify 应用（`app.ts`）、路由（`routes.ts`）、独立启动入口（`server.ts`） |
| `src/adapters/cli/` | CLI 入口（`list`/`inspect`/`run`） |
| `src/adapters/mcp/` | MCP server 构造（`server.ts`）与 stdio 入口（`main.ts`） |
| `src/adapters/relay/` | 节点连接器（`main.ts`）与配对（`pair.ts`） |
| `src/relay/` | 中继服务器（`server.ts`）、SQLite 存储（`store.ts`）、配置与客户端配置 |
| `src/web/` | React 工作台：页面（工具箱/执行记录/AI 接入/服务器）、组件、路由、全局运行状态仓库 |
| `electron/main.mjs` | Electron 主进程：窗口、托盘、开机自启、内嵌服务 |
| `public/` | PWA 清单、Service Worker、图标 |
| `scripts/` | `create-samples.ts`（生成样例 PDF/照片）、`stage-electron.mjs`（准备 Electron 运行时）、`start-workstation.sh`（一键启动） |
| `sandbox/` | 工作区：`inbox/`、`samples/` 样例，`downloads/` 产物输出（运行时创建） |
| `tests/` | `core/`、`tools/`、`adapters/`、`relay/`、`e2e/`（浏览器 + 前端单元）、`electron/`、`production.test.ts` |
| `deploy/` | `henry-relay.service`（systemd 单元）、`RELAY-DEPLOY.md`（服务器部署步骤） |
| `docs/superpowers/plans/` | 架构设计与实施计划（活文档，含各轮实施记录与验证结论） |
| `build/icon.png` | electron-builder 用的应用图标（**不是构建产物**） |
| `dist/` | 构建产物：`dist/server`（TS 编译）、`dist/web`（Vite），已在 `.gitignore` 中 |

---

## 常用脚本

全部来自 `package.json` 的 `scripts`：

| 命令 | 作用 |
| --- | --- |
| `npm run dev` | 开发模式：API（4318）+ 前端（5173）并行启动 |
| `npm run build` | `tsc -p tsconfig.server.json` + `vite build` → `dist/server`、`dist/web` |
| `npm start` | 生产模式运行服务：`node dist/server/adapters/http/server.js` |
| `npm run launch` | `bash scripts/start-workstation.sh`：按需安装/构建后启动并打开浏览器（`--dev` / `--port` 可选） |
| `npm run cli -- <args>` | 运行 CLI（开发期用 tsx 直接跑 TS 源码） |
| `npm run mcp` | 启动 stdio MCP 服务（调试用） |
| `npm run typecheck` | 分别检查后端（`tsconfig.server.json`）、前端（`tsconfig.web.json`）、测试（`tsconfig.tests.json`）类型 |
| `npm test` | 核心 / 工具 / 适配器 / 中继单元与集成测试（Node 内置 test runner） |
| `npm run test:web` | 前端表单序列化与结果渲染的单元检查 |
| `npm run test:production` | 构建产物交叉验证：编译后的 CLI / MCP / HTTP 结果一致、PDF Worker 可用 |
| `npm run test:e2e` | Playwright 驱动真实 Chrome 跑浏览器场景（会先构建并启动本地服务，**不复用已有服务**） |
| `npm run test:desktop` | Playwright 驱动 Electron 外壳，验证窗口、托盘、关窗留驻、开机自启 |
| `npm run samples` | 生成 `sandbox/samples/guide.pdf` 与 `sandbox/samples/photo.jpg`（已存在则不覆盖） |
| `npm run desktop` | `npm run build` 后启动 Electron 外壳 |
| `npm run desktop:stage` | 把 Electron 运行时复制到 `el-stage/`，并剔除 Windows 上被占用的 `resources/default_app.asar` |
| `npm run desktop:dist` | 构建 → 准备运行时 → `electron-builder --win --x64`，产出到 `release/` |
| `npm run relay:serve -- <relay.config.json>` | 在服务器上启动中继服务 |
| `npm run relay:node` | 在设备上启动节点连接器，注册到中继并领取任务 |
| `npm run relay:pair -- <地址> <配对码> [设备名] [--token <令牌>]` | 配对设备，凭据写入配置的 `relay` 段 |

---

## 配置

### `workstation.config.json`

配置由 `src/core/config.ts` 的 `configSchema`（Zod `strictObject`）严格校验；路径相对配置文件所在目录解析。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `workspaceRoot` | string | **只读**工作区根目录，必须是已存在的目录（默认 `./sandbox`） |
| `stateDirectory` | string | 运行摘要与状态目录（默认 `./.workstation`，摘要写在 `<state>/runs/`） |
| `outputDirectory` | string | **唯一可写**的产物目录，不存在会自动创建（默认 `./sandbox/downloads`） |
| `http.host` | `"127.0.0.1"` | 固定为回环地址（Schema 里是字面量，改别的直接报错） |
| `http.port` | number | 端口，默认 4318 |
| `network.enabled` | boolean | 是否允许 `network:public` 类工具联网；关闭后这些工具直接 `ACCESS_DENIED` |
| `limits.fileBytes` | number | 单次文件读取上限，默认 10485760（10 MiB） |
| `limits.csvRows` | number | CSV 数据行上限，默认 10000 |
| `limits.directoryEntries` | number | 目录条目上限，默认 1000 |
| `limits.pdfPages` | number | 单次 PDF 处理页数上限，默认 30 |
| `limits.webBytes` | number | 单次网页响应字节上限，默认 2097152（2 MiB） |
| `limits.downloadBytes` | number | 下载体积上限，默认 209715200（200 MiB） |
| `limits.outputBytes` | number | 单个输出文件体积上限，默认 209715200（200 MiB） |
| `limits.toolTimeoutMs` | number | 工具默认超时，默认 15000；Schema 上限 120000 |
| `relay` | object? | 可选的服务器连接段：`address`、`deviceToken`、`deviceId`、`deviceName`、`relayToken?` |

`relay` 段由 `npm run relay:pair` 自动写入，也可以手写。桌面端读的是 `%APPDATA%/personal-workstation/workstation.config.json`，命令行配对改的是项目目录里的那份——**两者不是同一个文件**。

### 环境变量

| 变量 | 作用 |
| --- | --- |
| `HENRY_RELAY_TOKEN` | `npm run relay:pair` 时作为中继的 Bearer 共享令牌（等价于 `--token`，见 `src/adapters/relay/pair.ts`） |

其余配置全部走 `workstation.config.json`，没有别的环境变量。

---

## 测试

| 命令 | 覆盖范围 | 用例数 |
| --- | --- | --- |
| `npm test` | `tests/core`、`tests/tools`、`tests/adapters`、`tests/relay`：注册表、参数校验、执行器与取消、文件边界、公网地址拦截、CSV/PDF/表格/影音工具、HTTP/CLI/MCP 适配器、中继链路 | 111 |
| `npm run test:web` | `tests/e2e/*.unit.ts(x)`：表单序列化、结果渲染组件 | 10 |
| `npm run test:e2e` | `tests/e2e/*.spec.ts`：Playwright + 真实 Chrome，覆盖目录检索、填示例、跑工具、进度、跨页面保持、关标签页后取回结果、窄屏（375/1440）、键盘可达、错误重试等 | 20 |
| `npm run test:desktop` | `tests/electron/desktop.spec.ts`：窗口渲染工作台、关窗仅隐藏且服务存活、托盘菜单项、开机自启开关 | 4 |
| `npm run test:production` | `tests/production.test.ts`：非项目目录启动**编译产物**，比对 CLI / MCP / HTTP 三条路径结果一致，校验 MCP 暴露 12 个工具、PDF Worker 可用 | 1 |

两个 Playwright 配置是分开的：`playwright.config.ts` 跑浏览器（`testDir: ./tests/e2e`，`webServer` 先 `npm run build && npm start` 再打 `http://127.0.0.1:4318/api/health`，**不复用已在运行的服务**以免测到旧代码）；`playwright.electron.config.ts` 跑 Electron 外壳（`testDir: ./tests/electron`）。

> 用例数按当前代码里的 `test(...)` 声明统计（`tests/e2e/workbench.spec.ts` 里有一处按 375/1440 两个宽度循环生成的用例）。第 19 节记录的一次 Windows 实测结果为 `npm test` 111 项中 110 通过、1 项因 Windows 大小写同名文件限制跳过。

---

## 打包与部署

### 桌面端打包

`electron-builder.json`：`appId` `com.henry.workstation`，`productName`「Henry 工作站」，产物目录 `release/`，Windows 目标为 NSIS 安装包（允许改安装目录、创建桌面快捷方式）。

```bash
npm run desktop:dist     # build → stage → electron-builder --win --x64，产物在 release/
```

打包内容为 `electron/**/*`、`dist/**/*`、`build/icon.png` 与 `package.json`（见 `files` 字段）。`scripts/stage-electron.mjs` 负责把 Electron 运行时复制到 `el-stage/` 并剔除 `default_app.asar`——该文件在 Windows 上解包后被占用，会导致安装包无法替换。

安装后：配置与工作区在 `%APPDATA%/personal-workstation/`；托盘里「打开工作台」「打开输出文件夹」「开机自动启动」「退出」；关窗口只是隐藏，进程留在托盘。

### 中继部署

服务器侧服务只依赖 `dist/server/relay/` 与 `zod`，用 Node 内置 `node:sqlite` 存设备、任务与运行历史。

```bash
npm run build
scp -r dist/server/relay node_modules <服务器>:/opt/henry/relay/
# 服务器上生成 relay.config.json（address / port / pairCode / dataDirectory / deviceToken）
sudo cp deploy/henry-relay.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now henry-relay
sudo ufw allow 4319/tcp
```

`deploy/henry-relay.service` 是 systemd 单元：以 `henry` 用户运行 `dist/server/relay/main.js`，`Restart=always`，`NoNewPrivileges`/`PrivateTmp`/`ProtectSystem=strict`/`ProtectHome`，只对 `/data/henry-relay` 可写。

设备侧：

```bash
npm run relay:pair -- http://<服务器IP>:4319 <配对码> <设备名> --token <deviceToken>
npm run relay:node
```

完整步骤、HTTP 明文的风险提示、以及"公网暴露前必须配置 `deviceToken`、中继目前没有速率限制"等注意事项，见 `deploy/RELAY-DEPLOY.md`。

---

## 相关文档

| 文档 | 内容 |
| --- | --- |
| [`docs/superpowers/plans/2026-11-02-personal-workstation-plan.md`](docs/superpowers/plans/2026-11-02-personal-workstation-plan.md) | 架构设计与实施计划（活文档）：架构选型、目录、工具契约、12 个工具的逐条规格与验收、配置与网络边界、测试矩阵、各轮实施记录与验证证据、桌面端与中继细节 |
| [`deploy/RELAY-DEPLOY.md`](deploy/RELAY-DEPLOY.md) | 中继服务器部署：Node 准备、目录规划、systemd 配置、端口放行、TLS、手机端调用示例、注意事项 |

应用内也有对应入口：工作台的「AI 接入」页给出可复制的 MCP 配置与 CLI 命令，「服务器」页给出设备列表、身份清单、派任务/查结果/查历史的接口说明（内容由 `src/adapters/http/routes.ts` 的 `aiUsageGuide()` 生成）。

---

## License

**未指定。** 根 `package.json` 没有 `license` 字段，且标记为 `"private": true`。使用前请与仓库作者确认授权方式。

> 附带的第三方工具（B 站 / 抖音解析）只处理公开内容，不绕过登录或付费限制；下载第三方平台视频前请自行确认平台服务条款与版权授权范围。
