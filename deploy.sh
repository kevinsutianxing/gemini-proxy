#!/usr/bin/env bash
# 部署 gemini-proxy 到 Deno Deploy（2026-09-02 起 /gemini/* 走 gpt.ge 中继）
# 背景: Google 封锁 Deno Deploy 出口访问 generativelanguage.googleapis.com（0/10 连接重置），
#       Vertex 不收 API key，故 gemini 上游切换为 api.gpt.ge 中继（Gemini 原生格式 + Bearer 认证）
# 用法: DENO_DEPLOY_TOKEN=ddp_xxx GPTGE_RELAY_KEY=sk-xxx ./deploy.sh
set -euo pipefail
cd "$(dirname "$0")"

: "${DENO_DEPLOY_TOKEN:?需要 DENO_DEPLOY_TOKEN（dash.deno.com → Account Settings → Access Tokens 新建）}"
: "${GPTGE_RELAY_KEY:?需要 GPTGE_RELAY_KEY（api.gpt.ge 的 API key）}"

# 把真实中继 key 注入占位符（仓库是 public，源码里不能存真实 key）
sed "s|__RELAY_KEY__|${GPTGE_RELAY_KEY}|g" main.ts > deploy_entry.ts

~/.deno/bin/deployctl deploy \
  --org=kevinsutianxing \
  --app=gemini-proxy \
  --prod \
  --token="$DENO_DEPLOY_TOKEN" \
  deploy_entry.ts

rm -f deploy_entry.ts

echo ""
echo "✅ 部署完成。验证命令:"
echo "  curl -s -X POST https://gemini-proxy.kevinsutianxing.deno.net/gemini/v1beta/models/gemini-3.1-pro-preview:generateContent \\"
echo "    -H 'Authorization: Bearer p0o9i8u7' -H 'Content-Type: application/json' \\"
echo "    -d '{\"contents\":[{\"parts\":[{\"text\":\"hi\"}]}]}'"
