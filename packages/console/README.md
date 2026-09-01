# @pi/console — Pi 桌面控制台（按需能力包 + Windows 安装包）

在浏览器里使用 Pi：`node:http` 原生后端 + 纯 HTML/JS/CSS 前端，无新增 npm 依赖、无构建步骤。
默认形态为**纯净原生 Pi**（内置 read/bash/edit/write 工具，官方系统提示词）；能力包通过 `customTools` 注册、
`setActiveToolsByName` 挂载/卸载，未挂载任何包时行为与纯净版完全一致。

## 安装与启动（开发模式）

```bash
# 仓库根目录
npm install
npm run build          # 构建上游全部包（coding-agent 的入口指向 dist，必须先构建）

# 可选：指定默认模型（格式 provider/model-id，如 deepseek/deepseek-v4-flash）
set PI_CONSOLE_MODEL=deepseek/deepseek-v4-flash
# 对应厂商的 API Key（按所用 provider 设置，也可用 ~/.pi/agent/auth.json）
set DEEPSEEK_API_KEY=...

npx tsx packages/console/src/server.ts
# 或直接 node packages/console/src/server.ts（Node >= 22.18 原生 type-stripping）
# 浏览器打开 http://127.0.0.1:3200
```

> PowerShell 请用 `$env:PI_CONSOLE_MODEL="..."`，Git Bash 请用 `export PI_CONSOLE_MODEL=...`。

## 新特性（v0.2.x）：

- **三栏桌面式布局**（参考 ZCode/Claude 风格）：左栏「助手 / 技能 / 文件」，中间聊天区，右栏「上下文」面板
- **助手（原能力包）**：左栏列出助手卡片（如 Office 助手），点「在对话中使用」启用，点「能力详情」查看其全部工具；未来可安装更多助手
- **技能**：左栏预留技能区，未来新增的技能可在对话中选用
- **工作区自定义**：设置 → 工作区，或左栏「文件」浏览到目标目录点「设为工作区」。会话的工作目录（Agent 读写文件的位置）即该目录；留空则用默认工作区。
- **本地资源管理器**：左栏「文件」浏览工作区/数据目录（可配 `PI_CONSOLE_FS_ROOT` 扩展根目录），点击文件预览（图片/文本），「＋添加到对话」直接作为附件；也可拖拽文件或 Ctrl+V 粘贴
- **Claude 风格渲染**：Markdown（标题/列表/表格/引用/链接）、代码块语法高亮、思考过程折叠滚动显示、工具调用块折叠、消息/代码块一键复制（⧉）
- **回复与过程分离**：工具调用前的“我先检查……”等过程播报自动归入可折叠「执行活动」，最终答复只显示结论、分点和表格；原文仍完整保留，不改变模型输出内容
- **历史消息折叠**：消息区顶部常驻「折叠历史消息」按钮（不随滚动消失），一键收起较早对话，避免长对话撑满页面
- **模型/思考等级选择器**移到输入框右下角；右栏「上下文」面板展示已启用能力，MCP 服务为占位设计（后续版本开放）
- 模型 Key 与自定义 OpenAI 兼容模型管理（设置 → 模型服务）、应用内更新、Edge App 独立窗口、拖拽/粘贴附件（见下）

- **设置（顶栏 ⚙）→ 模型服务**：选择厂商 + 粘贴 API Key 即可添加（存 `%APPDATA%pi-consoledataagentauth.json`，也可删除）；环境变量配置的会标注环境变量。也可添加 vLLM、Ollama、LM Studio 等 OpenAI 兼容地址，自动读取模型列表，并配置上下文、最大输出、图片能力和可选的 `low / medium / xhigh` 推理等级。
- **客户端窗口**：快捷方式以 Edge App 模式打开独立窗口（无地址栏/标签页），找不到 Edge 时回退默认浏览器
- **应用内更新**：设置 → 关于与更新 → 检查更新 / 立即更新（从 GitHub Release 拉取最新 Setup，校验 SHA256 后静默重装，并从用户实际安装位置自动重启；私有仓库需在设置里填写 GitHub Token）
- **附件**：📎 选择、拖拽文件到窗口、粘贴（Ctrl+V）截图/文件三种方式。用户消息保存不可变原始快照，智能体只修改工作区副本，修改结果作为新的产物文件展示。
- **代码开发插件**：工具页只有一个“代码开发（code-development）”入口，内部统一提供 Monaco 编辑器、私有 Git/GitHub 工作流，以及按项目安装的 Node.js、Python、Java、Go、Rust、.NET 环境。组件都保存在 Pi 数据目录，不修改 Windows 系统 PATH，也不覆盖电脑已有环境。

## 客户端形态

- **v0.3.0 起为 Electron 桌面客户端**（独立窗口、自带运行时、数据目录不变）。旧版（vbs + Edge 模式）点击更新后会自动进入 Electron，无需额外操作。
- 更新链路：设置 → 关于与更新 → 立即更新（从 GitHub Release 拉取 Setup，校验后静默重装，并支持从自定义安装目录自动重启）。
- 新增：会话删除（左侧对话列表 ×）、主题切换（顶栏 🌙/☀️，亮/暗双主题）。

## Windows 安装包（installer/）

给没有 Node/开发环境的普通用户：双击 Setup exe 安装，桌面图标点开即用。

```powershell
# 在打包机（Windows x64 + Node/npm）上执行：
cd packages/console/installer
powershell -ExecutionPolicy Bypass -File build.ps1
# 产物：installer/out/Pi控制台-Setup-<version>.exe（约 68 MB）
```

构建脚本自动完成：下载官方 Node 绿色版（写死 v24.19.0，SHA256 校验）→ 组装 staging
（app 源码 + npm registry 生产依赖 + 预置 OfficeCLI）→ 下载 NSIS 3.11 便携版 → 编译安装包。
`.tools/`（工具链缓存）、`staging/`、`out/` 均不入库，二次构建直接复用缓存。

安装与使用：

- 装到 `%LOCALAPPDATA%\Programs\pi-console`（无需管理员权限），桌面 + 开始菜单快捷方式
- 快捷方式指向 `Pi控制台.vbs`：隐藏窗口启动服务、轮询就绪后自动打开浏览器；重复双击只开新标签不起第二个服务（`Pi控制台.bat` 为可见窗口的调试启动器）
- 数据目录外置在 `%APPDATA%\pi-console\data`（环境变量 `PI_CONSOLE_DATA` 控制，卸载/重装不丢数据；服务启动时会自动把安装包预置的 OfficeCLI 复制过去）
- 卸载删除程序文件并保留数据目录（卸载向导会提示数据位置）

## 环境变量

| 变量 | 说明 |
|---|---|
| `PORT` | 监听端口，默认 `3200`（仅绑定 `127.0.0.1`） |
| `PI_CONSOLE_MODEL` | 可选。`provider/model-id`。未设置时走 Pi 默认解析（settings / 上次选择） |
| `PI_CONSOLE_DATA` | 可选。数据目录外置（默认 `<包>/data`；Electron 安装版由主进程读取保存位置并设置） |
| `PI_CONSOLE_TOKEN` | 可选。设置后所有 `/api/*` 请求必须带 `Authorization: Bearer <token>`（SSE 额外接受 `?token=`），静态页面放行 |

模型/思考等级选择通过控制台专属 agent 目录（`packages/console/data/agent/settings.json`）持久化，新会话自动沿用，不污染全局 `~/.pi/agent/`。

## HTTP 接口

| 方法与路径 | 说明 |
|---|---|
| `GET /` `/app.js` `/style.css` | 静态页面 |
| `POST /api/sessions` | 创建会话，返回 `{ sessionId }` |
| `GET /api/sessions/:id/stream?since=N` | SSE 事件流；`since` 补发，缓冲不足下发 `resync` |
| `POST /api/sessions/:id/messages` | body `{"text":"...","images":[{"data","mimeType"}]}`；立即回 202，错误走 SSE |
| `POST /api/sessions/:id/files` | body `{"files":[{name,mimeType,dataBase64}]}`；单文件 ≤20MB、总量 ≤50MB，超限 413；返回模型工作副本 `files` 与消息原始快照 `messageFiles` |
| `POST /api/sessions/:id/abort` | 中止当前运行 |
| `GET /api/sessions/:id/history` | 消息快照（含 `model`、`thinkingLevel`、`lastSeq`），刷新恢复 |
| `POST /api/sessions/:id/model` | body `{"provider","modelId"}` → `session.setModel`，SSE 发 `model_changed` |
| `POST /api/sessions/:id/thinking` | body `{"level"}`（off/minimal/low/medium/high/xhigh/max），返回实际生效值 |
| `GET /api/models` | 全部 provider 的模型（`{provider,modelId,label,hasAuth}`） |
| `GET` / `POST /api/custom-models` | 列出或保存自定义 OpenAI 兼容模型；API Key 单独存入 `auth.json` |
| `POST /api/custom-models/discover` | 从兼容服务的 `/models` 读取可用模型 ID |
| `DELETE /api/custom-models/:providerId` | 删除自定义模型及其保存的 API Key |
| `GET /api/packs` | 已安装能力包 `[{name,displayName,description,version,tools,mounted}]` |
| `POST /api/packs/:name/mount` / `unmount` | 挂载/卸载（全局共享，持久化到 `data/mounted-packs.json`，对所有存活会话立即生效，下一轮起用） |
| `GET /api/officecli/status` | OfficeCLI 安装状态 `{installed,version,latestVersion,latestTag,updateAvailable,path}`（查 latest 失败优雅降级为 null） |
| `POST /api/officecli/download` | 从 iOfficeAI/OfficeCLI 官方 Release 下载当前平台资产，SHA256 校验（asset digest 优先，其次官方 SHA256SUMS），先落临时文件、备份旧版再替换 |
| `GET /api/officecli/progress` | 下载进度（轮询） |
| `POST /api/tools/code-development/install` | 安装并校验代码开发插件核心（mise、GitHub CLI、Monaco） |
| `GET /api/tools/code-development/github` | 读取插件私有 GitHub 登录状态；`POST .../login` 浏览器登录，`DELETE` 退出 |
| `POST /api/tools/code-development/components/:id/install` | 按需安装 `node/python/java/go/rust/dotnet` 环境，进度见同路径 `/progress` |
| `GET /api/tools/code-development/repository` | 返回当前工作区 Git 状态与暂存/未暂存差异 |
| `PUT /api/fs/text` | 用打开时的 SHA256 防并发覆盖，保存 UTF-8/UTF-16 代码文件 |

## 能力包

- 包形态：`packs/<name>/pack.json`（name/displayName/description/version）+ `index.ts`（`export default definePack(ctx): { tools }`）
- 后端为**每个会话独立实例化**包工具（`ctx.getWorkspaceRoot()` 返回该会话 cwd），新增包重启服务后生效
- 挂载语义：创建会话时把全部已安装包工具注册进 `createAgentSession` 的 `customTools`；挂载/卸载 = 对全部会话调 `setActiveToolsByName(["read","bash","edit","write", ...包工具])`，不重建会话、不丢历史

### Office 助手包（office-assistant）

通过 OfficeCLI 操作 Word/Excel/PowerPoint，按真实命令树划分 13 个工具（`office_create` / `office_view` / `office_get` / `office_query` / `office_add` / `office_set` / `office_remove` / `office_move` / `office_swap` / `office_batch` / `office_import` / `office_merge` / `office_help`），参数用 TypeBox 明确声明，execFile 数组传参（禁 shell 拼接），cwd = 会话工作目录，超时 120 秒，输出截断 8000 字符，**不注入提示词**。二进制缺失时工具返回"OfficeCLI 未安装，请在页面点击下载"。

二进制位置：`packages/console/data/bin/officecli.exe`（版本记录在 `data/bin/officecli.json`）。只检查、不自动下载；页面上"能力包 → Office 助手 → 下载/更新"按钮一键安装（33MB 带进度条与 SHA256 校验）。

### 代码开发包（code-development）

对用户只显示一个插件，内部组件分三层：

- 核心：Monaco 代码编辑器、GitHub CLI、mise 环境管理器。
- 项目环境：Node.js、Python、Java、Go、Rust、.NET，各自可安装和卸载；以后新增语言只需补充组件清单和识别标记，不增加新的工具卡片。
- 智能体能力：仓库状态（`git_status`）、代码差异（`git_diff`）、分支（`git_branch`）、提交（`git_commit`）、同步（`git_sync`）、GitHub 仓库（`github_repository`）、拉取请求（`github_pull_request`）、项目环境（`development_environment`）。

插件只在代码、Git 或 GitHub 任务命中时加载相应工具组；普通问候不会注入这些工具定义。GitHub 登录、Git 全局配置、语言环境和缓存全部放在 `<PI_CONSOLE_DATA>/tools/code-development/`，从而与电脑上已有开发环境隔离。配套技能安装到控制台私有智能体目录，要求先检查、再修改、运行验证、审核差异，并且只有用户明确授权才提交或推送。

## 前端

- 顶栏：模型选择器（已配置 Key 的完整列出，未配置的按 provider 折叠）、思考等级选择器
- 左侧：可折叠"能力包"面板（开关 + OfficeCLI 状态行 + 下载进度条）
- 输入区：📎 附件（多文件芯片、可移除）；图片同时作为 `images` 传给模型。附件在 `uploads/` 生成模型工作副本，在 Pi 数据目录生成消息原始快照；历史消息始终打开原始快照，模型只看到工作副本路径。
- SSE 断线自动重连（`since` 补发 + seq 去重 + `resync` 全量重建兜底）

## 验收清单

1. 第 1 步功能零回归：纯净对话、工具块、停止、刷新恢复
2. 不挂任何包时模型不能调用 office 工具
3. 挂载/卸载后同一会话立即获得/失去 office 工具（不刷新、不重建）
4. OfficeCLI 未安装时工具返回引导错误；下载后 SHA256 校验通过、工具可用
5. 上传图片/文本：图片进模型上下文（历史显示 `[图片]`），附件落盘 `uploads/` 且模型可读取
6. 切换模型/思考等级新一轮生效，重启后保留
7. `npm run build` 与 `npx tsx packages/console/src/server.ts` 无报错
