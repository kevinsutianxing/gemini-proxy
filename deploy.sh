#!/usr/bin/env bash
# 部署 gemini-proxy 到 Deno Deploy（2026-09-22 v2：本地已与线上合并版对齐）
# 该版本无密钥占位符——所有密钥走平台 env（gemini_apikey/key/openai_apikey/tcp_relay_token 等）
# 用法: ./deploy.sh → preview 部署（安全）；PROD=1 ./deploy.sh → 生产（带护栏）
set -euo pipefail
cd "$(dirname "$0")"

: "${DENO_DEPLOY_TOKEN:?需要 DENO_DEPLOY_TOKEN（console.deno.com → Account Settings → Access Tokens 新建）}"

FLAGS=(--org=kevinsutianxing --app=gemini-proxy --token="$DENO_DEPLOY_TOKEN")
if [[ "${PROD:-0}" == "1" ]]; then
  echo "🔴 生产部署：将替换 https://gemini-proxy.kevinsutianxing.deno.net"
  echo "🔴 线上正承载 HK43 codex 的 ChatGPT-Advisor 生产流量（/codex/responses）"
  echo "🔴 2026-09-22 本地已与线上行为对齐（探针逐字节一致）；确认本次变更意图后继续。10 秒内 Ctrl-C 取消..."
  sleep 10
  FLAGS+=(--prod)
else
  echo "▶ preview 部署（不影响生产域名；PROD=1 才上生产）"
fi

~/.deno/bin/deno deploy . "${FLAGS[@]}"

echo ""
echo "✅ 部署已提交。查看日志:"
echo "  deno deploy logs --org=kevinsutianxing --app=gemini-proxy --token=\$DENO_DEPLOY_TOKEN"
echo "验证: curl -s https://gemini-proxy.kevinsutianxing.deno.net/ | head -c 120"
