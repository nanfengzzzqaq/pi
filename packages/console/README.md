# @pi/console — Pi Web 控制台（第 2 步：能力包框架 + Office 助手包 + 前端增强）

在浏览器里使用 Pi：`node:http` 原生后端 + 纯 HTML/JS/CSS 前端，无新增 npm 依赖、无构建步骤。
默认形态为**纯净原生 Pi**（内置 read/bash/edit/write 工具，官方系统提示词）；能力包通过 `customTools` 注册、
`setActiveToolsByName` 挂载/卸载，未挂载任何包时行为与第 1 步完全一致。

## 安装与启动

```bash
# 仓库根目录
npm install
npm run build          # 构建上游全部包（coding-agent 的入口指向 dist，必须先构建）

# 可选：指定默认模型（格式 provider/model-id，如 deepseek/deepseek-v4-flash）
set PI_CONSOLE_MODEL=deepseek/deepseek-v4-flash
# 对应厂商的 API Key（按所用 provider 设置，也可用 ~/.pi/agent/auth.json）
set DEEPSEEK_API_KEY=...

npx tsx packages/console/src/server.ts
# 浏览器打开 http://127.0.0.1:3200
```

> PowerShell 请用 `$env:PI_CONSOLE_MODEL="..."`，Git Bash 请用 `export PI_CONSOLE_MODEL=...`。

## 环境变量

| 变量 | 说明 |
|---|---|
| `PORT` | 监听端口，默认 `3200`（仅绑定 `127.0.0.1`） |
| `PI_CONSOLE_MODEL` | 可选。`provider/model-id`。未设置时走 Pi 默认解析（settings / 上次选择） |
| `PI_CONSOLE_TOKEN` | 可选。设置后所有 `/api/*` 请求必须带 `Authorization: Bearer <token>`（SSE 额外接受 `?token=`），静态页面放行 |

模型/思考等级选择通过控制台专属 agent 目录（`packages/console/data/agent/settings.json`）持久化，新会话自动沿用，不污染全局 `~/.pi/agent/`。

## HTTP 接口

| 方法与路径 | 说明 |
|---|---|
| `GET /` `/app.js` `/style.css` | 静态页面 |
| `POST /api/sessions` | 创建会话，返回 `{ sessionId }` |
| `GET /api/sessions/:id/stream?since=N` | SSE 事件流；`since` 补发，缓冲不足下发 `resync` |
| `POST /api/sessions/:id/messages` | body `{"text":"...","images":[{"data","mimeType"}]}`；立即回 202，错误走 SSE |
| `POST /api/sessions/:id/files` | body `{"files":[{name,mimeType,dataBase64}]}`；单文件 ≤20MB、总量 ≤50MB，超限 413；写入 `<会话cwd>/uploads/`，重名加后缀 |
| `POST /api/sessions/:id/abort` | 中止当前运行 |
| `GET /api/sessions/:id/history` | 消息快照（含 `model`、`thinkingLevel`、`lastSeq`），刷新恢复 |
| `POST /api/sessions/:id/model` | body `{"provider","modelId"}` → `session.setModel`，SSE 发 `model_changed` |
| `POST /api/sessions/:id/thinking` | body `{"level"}`（off/minimal/low/medium/high/xhigh/max），返回实际生效值 |
| `GET /api/models` | 全部 provider 的模型（`{provider,modelId,label,hasAuth}`） |
| `GET /api/packs` | 已安装能力包 `[{name,displayName,description,version,tools,mounted}]` |
| `POST /api/packs/:name/mount` / `unmount` | 挂载/卸载（全局共享，持久化到 `data/mounted-packs.json`，对所有存活会话立即生效，下一轮起用） |
| `GET /api/officecli/status` | OfficeCLI 安装状态 `{installed,version,latestVersion,latestTag,updateAvailable,path}`（查 latest 失败优雅降级为 null） |
| `POST /api/officecli/download` | 从 iOfficeAI/OfficeCLI 官方 Release 下载当前平台资产，SHA256 校验（asset digest 优先，其次官方 SHA256SUMS），先落临时文件、备份旧版再替换 |
| `GET /api/officecli/progress` | 下载进度（轮询） |

## 能力包

- 包形态：`packs/<name>/pack.json`（name/displayName/description/version）+ `index.ts`（`export default definePack(ctx): { tools }`）
- 后端为**每个会话独立实例化**包工具（`ctx.getWorkspaceRoot()` 返回该会话 cwd），新增包重启服务后生效
- 挂载语义：创建会话时把全部已安装包工具注册进 `createAgentSession` 的 `customTools`；挂载/卸载 = 对全部会话调 `setActiveToolsByName(["read","bash","edit","write", ...包工具])`，不重建会话、不丢历史

### Office 助手包（office-assistant）

通过 OfficeCLI 操作 Word/Excel/PowerPoint，按真实命令树划分 13 个工具（`office_create` / `office_view` / `office_get` / `office_query` / `office_add` / `office_set` / `office_remove` / `office_move` / `office_swap` / `office_batch` / `office_import` / `office_merge` / `office_help`），参数用 TypeBox 明确声明，execFile 数组传参（禁 shell 拼接），cwd = 会话工作目录，超时 120 秒，输出截断 8000 字符，**不注入提示词**。二进制缺失时工具返回"OfficeCLI 未安装，请在页面点击下载"。

二进制位置：`packages/console/data/bin/officecli.exe`（版本记录在 `data/bin/officecli.json`）。只检查、不自动下载；页面上"能力包 → Office 助手 → 下载/更新"按钮一键安装（33MB 带进度条与 SHA256 校验）。

## 前端

- 顶栏：模型选择器（已配置 Key 的完整列出，未配置的按 provider 折叠）、思考等级选择器
- 左侧：可折叠"能力包"面板（开关 + OfficeCLI 状态行 + 下载进度条）
- 输入区：📎 附件（多文件芯片、可移除）；图片同时作为 `images` 传给模型，所有附件先存 `uploads/` 并在消息末尾追加 `[附件: ...]` 行；历史快照中图片显示为 `[图片]`
- SSE 断线自动重连（`since` 补发 + seq 去重 + `resync` 全量重建兜底）

## 验收清单

1. 第 1 步功能零回归：纯净对话、工具块、停止、刷新恢复
2. 不挂任何包时模型不能调用 office 工具
3. 挂载/卸载后同一会话立即获得/失去 office 工具（不刷新、不重建）
4. OfficeCLI 未安装时工具返回引导错误；下载后 SHA256 校验通过、工具可用
5. 上传图片/文本：图片进模型上下文（历史显示 `[图片]`），附件落盘 `uploads/` 且模型可读取
6. 切换模型/思考等级新一轮生效，重启后保留
7. `npm run build` 与 `npx tsx packages/console/src/server.ts` 无报错
