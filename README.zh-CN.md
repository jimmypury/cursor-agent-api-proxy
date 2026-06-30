# cursor-agent-api-proxy

[![npm version](https://img.shields.io/npm/v/cursor-agent-api-proxy)](https://www.npmjs.com/package/cursor-agent-api-proxy)
[![npm downloads](https://img.shields.io/npm/dm/cursor-agent-api-proxy)](https://www.npmjs.com/package/cursor-agent-api-proxy)
[![license](https://img.shields.io/npm/l/cursor-agent-api-proxy)](./LICENSE)

[English](./README.md)

Cursor CLI 的 OpenAI 兼容 API 代理。让任何 OpenAI 兼容客户端直接使用你的 Cursor 订阅。

## 前置条件

- Node.js 20+
- 有效的 [Cursor](https://cursor.com) 订阅（Pro / Business）

## 安装

**1. 安装 Cursor CLI 并登录：**

```bash
# macOS / Linux
curl https://cursor.com/install -fsS | bash

# Windows PowerShell
irm 'https://cursor.com/install?win32=true' | iex
```

```bash
agent login          # 打开浏览器，用 Cursor 账号登录
agent --list-models  # 确认 CLI 可用
```

> **无头环境？** 跳过 `agent login`，到 [cursor.com/settings](https://cursor.com/settings) 生成 API Key，然后 `export CURSOR_API_KEY=<key>`。

**2. 安装并启动代理：**

```bash
npm install -g cursor-agent-api-proxy
cursor-agent-api          # 后台启动，默认 http://localhost:4646
cursor-agent-api status   # 查看运行状态
```

**3. 验证：**

```bash
curl http://localhost:4646/health
```

**其他命令：**

```bash
cursor-agent-api stop           # 停止
cursor-agent-api restart        # 重启
cursor-agent-api start 8080     # 指定端口启动
cursor-agent-api run            # 前台运行（调试用）
```

日志：`~/.cursor-agent-api/server.log`

## 配合 OpenClaw 使用

### 首次安装（onboard 向导）

如果还没装过 [OpenClaw](https://docs.openclaw.ai)，运行引导向导：

```bash
openclaw onboard
```

向导进行到 **Model/Auth** 步骤时：

1. Provider 类型 → 选 **Custom Provider**（OpenAI-compatible）
2. Base URL → `http://localhost:4646/v1`
3. API Key → 输入 `not-needed`（已 `agent login` 就不需要 key）
4. Default model → `auto`（或 `agent --list-models` 中的任意模型）

### 已有配置（编辑配置文件）

OpenClaw 已经在用了？直接改配置文件：

```json5
{
  env: {
    // "not-needed" = 已通过 agent login 登录，不需要 key
    // 或填你的 Cursor API Key，代理会按请求转发
    OPENAI_API_KEY: "not-needed",
    OPENAI_BASE_URL: "http://localhost:4646/v1",
  },
  agents: {
    defaults: {
      model: { primary: "openai/auto" },
    },
  },
}
```

## 模型

模型 ID 和 `agent --list-models` 输出一致，直接填：

```bash
auto                  # 自动选择
gpt-5.2               # GPT-5.2
gpt-5.3-codex         # GPT-5.3 Codex
opus-4.6-thinking     # Claude Opus 4.6 (thinking)
sonnet-4.5-thinking   # Claude Sonnet 4.5 (thinking)
gemini-3-pro          # Gemini 3 Pro
```

完整列表：`curl http://localhost:4646/v1/models` 或 `agent --list-models`。

## API

| 端点 | 方法 | 说明 |
|------|------|------|
| `/health` | GET | 健康检查 |
| `/v1/models` | GET | 模型列表 |
| `/v1/chat/completions` | POST | 聊天补全（支持 `stream: true`） |

## 配置

| 环境变量 | 默认值 | 说明 |
|---------|--------|------|
| `PORT` | `4646` | 监听端口（或 `cursor-agent-api start 8080`） |
| `CURSOR_API_KEY` | - | `agent login` 的替代方案 |
| `PROXY_API_KEY` | - | 设置后启用代理鉴权（shared 模式）；逗号分隔可配置多个 key |
| `PROXY_AUTH_MODE` | 设置 `PROXY_API_KEY` 时默认 `shared`，否则关闭 | `shared` 或 `bring-your-own-key` |

### 代理鉴权

默认不开启代理鉴权（本地自用，行为不变）。配置以下任一模式来限制 `/v1/*` 访问：

**共享模式（shared）**——分享你的 Cursor 订阅。客户端使用你下发的代理 key；
Cursor 凭证由服务端提供。

```bash
export PROXY_API_KEY=sk-your-proxy-key
# 设置 PROXY_API_KEY 时 PROXY_AUTH_MODE 默认为 "shared"
```

```bash
curl -X POST http://localhost:4646/v1/chat/completions \
  -H "Authorization: Bearer sk-your-proxy-key" \
  -H "Content-Type: application/json" \
  -d '{"model":"auto","messages":[{"role":"user","content":"Hello!"}]}'
```

**自带 Cursor Key 模式（bring-your-own-key）**——每个客户端用自己的 Cursor
API Key；代理只要求请求里带有真实 Bearer token。

```bash
export PROXY_AUTH_MODE=bring-your-own-key
```

```bash
curl -X POST http://localhost:4646/v1/chat/completions \
  -H "Authorization: Bearer your-cursor-api-key" \
  -H "Content-Type: application/json" \
  -d '{"model":"auto","messages":[{"role":"user","content":"Hello!"}]}'
```

`/health` 始终不鉴权（供 Docker 健康检查 / 负载均衡探活使用）。

## 开机自启

开机自动启动代理：

```bash
cursor-agent-api install    # 注册为系统服务
cursor-agent-api uninstall  # 移除
```

- macOS → LaunchAgent
- Windows → Task Scheduler
- Linux → systemd user service

## 其他客户端

<details>
<summary>Python (openai SDK)</summary>

```python
from openai import OpenAI

client = OpenAI(
    base_url="http://localhost:4646/v1",
    api_key="not-needed",
)

resp = client.chat.completions.create(
    model="auto",
    messages=[{"role": "user", "content": "Hello!"}],
)
print(resp.choices[0].message.content)
```

</details>

<details>
<summary>Continue.dev</summary>

```json
{
  "models": [{
    "title": "Cursor",
    "provider": "openai",
    "model": "auto",
    "apiBase": "http://localhost:4646/v1",
    "apiKey": "not-needed"
  }]
}
```

</details>

<details>
<summary>curl</summary>

```bash
curl -X POST http://localhost:4646/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"auto","messages":[{"role":"user","content":"Hello!"}]}'
```

</details>

## 原理

```
客户端  →  POST /v1/chat/completions (OpenAI 格式)
        →  cursor-agent-api-proxy
        →  spawn agent CLI (stream-json)
        →  Cursor 订阅
        →  AI 响应 → OpenAI 格式 → 客户端
```

## 参与开发

```bash
git clone https://github.com/tageecc/cursor-agent-api-proxy.git
cd cursor-agent-api-proxy
pnpm install && pnpm run build
pnpm start
```

## License

MIT
