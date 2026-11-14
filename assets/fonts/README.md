# 内置字体

中文 PDF 输出用的内置字体，仓库自带，任何系统上都能用。

- **文件**：`NotoSansSC.ttf`（17.7 MB，Noto Sans SC 可变字体，`wght` 轴）
- **来源**：<https://github.com/google/fonts/tree/main/ofl/notosanssc>（上游文件 `NotoSansSC[wght].ttf`，本仓库改名为 `NotoSansSC.ttf`）
- **协议**：SIL Open Font License 1.1，见同目录 `OFL.txt`
- **用途**：`src/core/fonts.ts` 首选候选，PDF 生成时由 `@pdf-lib/fontkit` 子集化嵌入（实测中文 PDF 仅约 4 KB）；系统字体（黑体 / 等线 / 微软雅黑）只作后备

注意：`.ttc` 字体合集（含 Noto CJK）在现有 pdf-lib + `@pdf-lib/fontkit` 下子集化与非子集化都嵌不进去，不要换成 `.ttc`。
