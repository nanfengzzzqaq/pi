# @pi/console — Pi Web 控制台（第 1 步：后端骨架 + 最简对话页面）

在浏览器里使用 Pi：`node:http` 原生后端 + 纯 HTML/JS/CSS 前端，无新增 npm 依赖、无构建步骤。
默认形态为**纯净原生 Pi**（内置 read/bash/edit/write 工具，官方系统提示词，不加任何自定义工具和提示词）。

## 安装与启动

```bash
# 仓库根目录
npm install
npm run build          # 构建上游全部包（coding-agent 的入口指向 dist，必须先构建）

# 可选：指定模型（格式 provider/model-id，如 zai-coding-cn/glm-5.2）
set PI_CONSOLE_MODEL=zai-coding-cn/glm-5.2
# 对应厂商的 API Key（按所用 provider 设置，也可用 ~/.pi/agent/auth.json）
set ZAI_CODING_CN_API_KEY=...

npx tsx packages/console/src/server.ts
# 浏览器打开 http://127.0.0.1:3200
```

> PowerShell 请用 `$env:PI_CONSOLE_MODEL="..."`，Git Bash 请用 `export PI_CONSOLE_MODEL=...`。

## 环境变量

| 变量 | 说明 |
|---|---|
| `PORT` | 监听端口，默认 `3200`（仅绑定 `127.0.0.1`） |
| `PI_CONSOLE_MODEL` | 可选。`provider/model-id`，如 `zai-coding-cn/glm-5.2`。未设置时走 Pi 默认模型解析（settings / 可用凭据） |
| `PI_CONSOLE_TOKEN` | 可选。设置后所有 `/api/*` 请求必须带 `Authorization: Bearer <token>`（SSE 因 EventSource 无法设头，额外接受 `?token=`），静态页面放行 |

模型鉴权沿用 Pi 本身的方式：各厂商环境变量 API Key（如 `ZAI_CODING_CN_API_KEY`、`ANTHROPIC_API_KEY`）或 `~/.pi/agent/auth.json`，本步不做登录 UI。

## HTTP 接口

| 方法与路径 | 说明 |
|---|---|
| `GET /` `/app.js` `/style.css` | 静态页面 |
| `POST /api/sessions` | 创建会话，返回 `{ sessionId }` |
| `GET /api/sessions/:id/stream?since=N` | SSE 事件流；`since` 为已收到的最大事件序号，用于断线补发（缓冲不足时下发 `resync` 事件，前端改走 history 全量重建） |
| `POST /api/sessions/:id/messages` | body `{"text":"..."}`，立即回 202；错误通过 SSE `error` 事件传递 |
| `POST /api/sessions/:id/abort` | 中止当前运行 |
| `GET /api/sessions/:id/history` | 消息快照（user/assistant 文本 + 工具调用记录），页面刷新时恢复 |

SSE 转发的事件子集：`text_delta`（流式文本）、`thinking_delta`（仅指示"思考中"，不含思考内容）、`tool_execution_start/end`（工具调用块）、`turn_end`（轮次结束 / 错误）、`agent_settled`（整轮结束）、`auto_retry_start`（重试提示）、`compaction_start/end`（上下文压缩提示）。

每个会话独立的 AgentSession 与专属工作目录 `packages/console/data/workspaces/<sessionId>/`（内存会话，服务器重启后页面会自动新建会话）。

## 验收清单

1. `npm run build` 和服务器启动无报错
2. 浏览器里能完整跑一轮对话：流式输出正常、中文正常
3. 让模型"列出当前目录的文件"，能看到 read/bash 工具调用块的完整生命周期（开始→结束）
4. 运行中点"停止"能中止
5. 刷新页面后历史消息恢复、SSE 重连不丢事件
6. 不设 `PI_CONSOLE_MODEL` 时启动不崩（走默认模型解析，找不到模型时在页面上给出清晰错误提示）
