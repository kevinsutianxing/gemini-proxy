# 统一 API 代理（gemini-proxy）

部署在 Deno Deploy 上的多协议 API 代理：Gemini 多 Key 直连 + OpenAI 兼容转发 + Codex 转发 + TCP 中继，用统一认证保护真实上游密钥。

> 平台说明：Deno Deploy Classic 已于 2026-07-20 关停。本项目运行于新平台（[console.deno.com](https://console.deno.com)），线上域名为 `https://<org>-<app>.deno.net`。

🌟 **功能特点**

*   **统一认证**：自定义密钥保护真实 API Key，避免泄漏
*   **多 Key 轮换**：Gemini / OpenAI 各自独立的 Key 池，随机轮换避免速率限制
*   **多路由**：`/gemini` `/openai` `/codex` `/v1` `/auth` `/fetch`，完全透明转发，支持流式响应
*   **TCP 中继**：`/relay` WebSocket TCP 中继（CONNECT 协议，独立 token 认证）

🚀 **快速部署**

### 方法一：CLI（本仓库推荐）

```bash
# token：console.deno.com → Account Settings → Access Tokens 新建（勿用已死的 deployctl 流程）
export DENO_DEPLOY_TOKEN=ddp_xxxx

./deploy.sh              # preview 部署（安全，不影响生产域名）
PROD=1 ./deploy.sh       # 生产部署（带 10 秒确认护栏）
```

### 方法二：GitHub 集成（console.deno.com）

1.  登录 [console.deno.com](https://console.deno.com) 并关联 GitHub 仓库
2.  production 分支 → 自动部署生产；其他分支 → 自动生成 preview 部署

### 环境变量（平台侧配置，不入库）

| 变量名 | 说明 |
| :--- | :--- |
| `key` | 客户端认证密钥（必填，自定义） |
| `gemini_apikey` | Gemini API Key 池，多把逗号分隔 |
| `openai_apikey` | OpenAI 兼容上游 Key 池，多把逗号分隔 |
| `apikey` | 通用兜底 Key 池（`openai_apikey` 未设时 OpenAI 路由回落到它） |
| `tcp_relay_token` | `/relay` TCP 中继认证 token |
| `gemini_base_url` | Gemini 上游覆盖（缺省直连 generativelanguage.googleapis.com） |
| `openai_base_url` / `codex_base_url` | OpenAI / Codex 上游覆盖 |
| `gemini_relay_base` / `gemini_relay_key` | 可选 Gemini 中继（未设置 = 直连 Google） |

📖 **使用方法**

### 在 CherryStudio 中配置

1.  打开 CherryStudio 设置
2.  添加新的服务商配置：
    *   服务商类型：`gemini`
    *   API Base URL：`https://gemini-proxy.kevinsutianxing.deno.net`
    *   API Key：`sk-my-secret-key-123`（你在环境变量中设置的 `key`）
    *   模型：`gemini-2.5-flash` 或 `gemini-2.5-pro`
