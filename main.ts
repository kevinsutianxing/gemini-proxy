// === 统一 API 代理服务器 ===
// 支持同时代理 OpenAI、Gemini、Codex (ChatGPT Plus) API
// 路由规则：
//   /openai/* → 转发到 OpenAI API（Authorization Bearer 方式认证）
//   /gemini/* → 转发到 Gemini API（URL ?key= 方式认证）
//   /codex/*  → 转发到 ChatGPT Codex API（Authorization Bearer OAuth token）
//   /auth/*   → 转发到 auth.openai.com（OAuth/device flow，用于 Codex 登录）
//   /v1/* → 默认转发到 OpenAI API（向后兼容）
// 其他路径 → 返回使用说明

// ── 环境变量 ──
const AUTH_KEY = Deno.env.get("key"); // 客户端统一认证密钥
const OPENAI_API_KEYS_STR = Deno.env.get("openai_apikey"); // OpenAI API 密钥（逗号分隔）
const GEMINI_API_KEYS_STR = Deno.env.get("gemini_apikey"); // Gemini API 密钥（逗号分隔）
const OPENAI_BASE_URL = Deno.env.get("openai_base_url") || "https://api.openai.com";
const GEMINI_BASE_URL = Deno.env.get("gemini_base_url") || "https://generativelanguage.googleapis.com";
// 2026-09-02: Google 封锁 Deno Deploy 出口 IP 访问 generativelanguage.googleapis.com（实测 0/10 连接重置），
// 且 Vertex (aiplatform.googleapis.com) 不接受 API key（401 "API keys are not supported"）。
// 因此 /gemini/* 默认改走 gpt.ge 中继（Gemini 原生格式，Authorization Bearer 认证）。
// 启用条件：环境变量 gemini_relay_key，或部署时把 __RELAY_KEY__ 占位符替换为真实 key（见 deploy.sh）。
const GEMINI_RELAY_BASE = Deno.env.get("gemini_relay_base") || "https://api.gpt.ge";
const GEMINI_RELAY_KEY = Deno.env.get("gemini_relay_key") || "__RELAY_KEY__";
// gpt.ge 上没有的模型名 → 等价可用名（仅中继模式生效）
const GEMINI_MODEL_ALIASES: Record<string, string> = {
  "gemini-3.5-flash-lite-preview": "gemini-3.5-flash-lite",
};
const CODEX_BASE_URL = Deno.env.get("codex_base_url") || "https://chatgpt.com/backend-api/codex";
const AUTH_BASE_URL = "https://auth.openai.com";

// ── 兼容旧配置（如果新变量没设置，fallback 到旧的 apikey） ──
const OPENAI_API_KEYS = parseKeys(OPENAI_API_KEYS_STR || Deno.env.get("apikey") || "");
const GEMINI_API_KEYS = parseKeys(GEMINI_API_KEYS_STR || "");

let openaiKeyIndex = 0;
let geminiKeyIndex = 0;

function parseKeys(str: string): string[] {
  return str.split(",").map(k => k.trim()).filter(k => k.length > 0);
}

function getNextKey(keys: string[], indexRef: { value: number }): string {
  if (keys.length === 0) throw new Error("没有可用的 API Key");
  const key = keys[indexRef.value % keys.length];
  indexRef.value++;
  console.log(`选择 API Key #${indexRef.value}/${keys.length}`);
  return key;
}

// ── 启动日志 ──
console.log("=== 统一 API 代理服务器启动 ===");
console.log(`AUTH_KEY: ${AUTH_KEY ? "已设置" : "❌ 未设置"}`);
console.log(`OpenAI Keys: ${OPENAI_API_KEYS.length} 个`);
console.log(`Gemini Keys: ${GEMINI_API_KEYS.length} 个`);
console.log(`OpenAI 后端: ${OPENAI_BASE_URL}`);
console.log(`Gemini 后端: ${GEMINI_BASE_URL}`);
console.log(`Gemini 中继: ${GEMINI_RELAY_KEY !== "__RELAY_KEY__" && GEMINI_RELAY_KEY.length > 0 ? `${GEMINI_RELAY_BASE} (启用)` : "未启用（直连模式）"}`);
console.log(`Codex 后端: ${CODEX_BASE_URL}`);
console.log("================================");
console.log("路由: /openai/* → OpenAI | /gemini/* → Gemini | /codex/* → Codex | /auth/* → Auth | /v1/* → OpenAI(兼容)");

// ── CORS ──
function corsHeaders(): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers":
      "Content-Type, Authorization, x-api-key, x-goog-api-key, OpenAI-Beta, OpenAI-Organization, " +
      "Originator, Chatgpt-Account-Id, Session_id, X-Codex-Turn-Metadata, X-Client-Request-Id, " +
      "Thread-Id, X-Codex-Window-Id, X-Codex-Beta-Features",
    "Access-Control-Max-Age": "86400",
  };
}

// ── 提取客户端密钥 ──
function extractClientKey(req: Request): { key: string; source: string } {
  // 1. x-goog-api-key header
  const googKey = req.headers.get("x-goog-api-key");
  if (googKey) return { key: googKey.trim(), source: "x-goog-api-key" };

  // 2. Authorization: Bearer <key>
  const auth = req.headers.get("Authorization");
  if (auth) {
    if (auth.toLowerCase().startsWith("bearer ")) {
      return { key: auth.substring(7).trim(), source: "Authorization Bearer" };
    }
    return { key: auth.trim(), source: "Authorization (direct)" };
  }

  // 3. x-api-key header
  const xKey = req.headers.get("x-api-key");
  if (xKey) return { key: xKey.trim(), source: "x-api-key" };

  // 4. URL 参数
  const url = new URL(req.url);
  const urlKey = url.searchParams.get("key");
  if (urlKey) return { key: urlKey.trim(), source: "URL parameter" };

  return { key: "", source: "未找到" };
}

// ── 验证客户端身份 ──
function verifyClient(req: Request, requestId: string): string | null {
  if (!AUTH_KEY) return "服务器配置错误：未设置 AUTH_KEY";

  const { key, source } = extractClientKey(req);
  console.log(`[${requestId}] 密钥来源: ${source}`);

  if (!key) return "认证失败：未提供API密钥";
  if (key !== AUTH_KEY) return "认证失败：API密钥无效";

  return null; // 验证通过
}

// ── 路由解析 ──
type RouteTarget = "openai" | "gemini" | "codex" | "auth" | "fetch" | "help";

function resolveRoute(pathname: string): RouteTarget {
  if (pathname.startsWith("/openai/") || pathname === "/openai") return "openai";
  if (pathname.startsWith("/gemini/") || pathname === "/gemini") return "gemini";
  if (pathname.startsWith("/codex/") || pathname === "/codex") return "codex";
  if (pathname.startsWith("/auth/")) return "auth";
  // /v1/ 默认走 OpenAI（向后兼容原 openai-proxy）
  if (pathname.startsWith("/v1/")) return "openai";
  if (pathname.startsWith("/fetch") || pathname === "/fetch") return "fetch";
  return "help";
}

// ── OpenAI 代理逻辑 ──
async function proxyOpenAI(
  req: Request,
  url: URL,
  requestId: string,
): Promise<Response> {
  if (OPENAI_API_KEYS.length === 0) {
    return errorResponse("OpenAI API Keys 未配置", 500, requestId);
  }

  const openaiRef = { value: openaiKeyIndex };
  const selectedKey = getNextKey(OPENAI_API_KEYS, openaiRef);
  openaiKeyIndex = openaiRef.value;
  const keyNum = OPENAI_API_KEYS.indexOf(selectedKey) + 1;
  console.log(`[${requestId}] 使用 OpenAI Key #${keyNum}/${OPENAI_API_KEYS.length}`);

  // 去掉路径前缀 /openai
  let targetPath = url.pathname;
  if (targetPath.startsWith("/openai")) {
    targetPath = targetPath.substring(7); // /openai/v1/chat → /v1/chat
  }
  if (targetPath === "") targetPath = "/v1/chat/completions";

  const targetUrl = `${OPENAI_BASE_URL}${targetPath}${url.search}`;
  console.log(`[${requestId}] OpenAI 转发: ${targetUrl}`);

  // 准备转发 headers
  const forwardHeaders = new Headers();
  for (const h of [
    "Content-Type", "Accept", "User-Agent", "Accept-Language",
    "Accept-Encoding", "OpenAI-Beta", "OpenAI-Organization",
  ]) {
    const v = req.headers.get(h);
    if (v) forwardHeaders.set(h, v);
  }
  forwardHeaders.set("Authorization", `Bearer ${selectedKey}`);

  // 读取请求体 & 检测流式
  let body: ArrayBuffer | undefined;
  let isStream = false;
  if (req.method !== "GET" && req.method !== "HEAD") {
    body = await req.arrayBuffer();
    try {
      const parsed = JSON.parse(new TextDecoder().decode(body));
      if (parsed.stream === true) isStream = true;
    } catch { /* ignore */ }
    console.log(`[${requestId}] 请求体: ${body.byteLength} bytes, stream=${isStream}`);
  }

  const startTime = Date.now();
  const resp = await fetch(targetUrl, {
    method: req.method,
    headers: forwardHeaders,
    body,
  });
  const elapsed = Date.now() - startTime;

  console.log(`[${requestId}] OpenAI 响应: ${resp.status} (${elapsed}ms)`);
  if (resp.status === 429) console.warn(`[${requestId}] ⚠️ Key 限速`);

  return buildResponse(resp, requestId, isStream, elapsed, OPENAI_API_KEYS.length, selectedKey);
}

// ── Gemini 代理逻辑 ──
async function proxyGemini(
  req: Request,
  url: URL,
  requestId: string,
): Promise<Response> {
  const useRelay = GEMINI_RELAY_KEY.length > 0 && GEMINI_RELAY_KEY !== "__RELAY_KEY__";
  console.log(`[${requestId}] Gemini 上游: ${useRelay ? `中继 ${GEMINI_RELAY_BASE}` : `直连 ${GEMINI_BASE_URL}`}`);

  if (!useRelay && GEMINI_API_KEYS.length === 0) {
    return errorResponse("Gemini API Keys 未配置", 500, requestId);
  }

  let selectedKey = "";
  let totalKeys = GEMINI_API_KEYS.length;
  if (useRelay) {
    selectedKey = GEMINI_RELAY_KEY;
    totalKeys = 1;
  } else {
    const geminiRef = { value: geminiKeyIndex };
    selectedKey = getNextKey(GEMINI_API_KEYS, geminiRef);
    geminiKeyIndex = geminiRef.value;
    const keyNum = GEMINI_API_KEYS.indexOf(selectedKey) + 1;
    console.log(`[${requestId}] 使用 Gemini Key #${keyNum}/${GEMINI_API_KEYS.length}`);
  }

  // 去掉路径前缀 /gemini
  let targetPath = url.pathname;
  if (targetPath.startsWith("/gemini")) {
    targetPath = targetPath.substring(7); // /gemini/v1beta/models → /v1beta/models
  }
  if (targetPath === "") targetPath = "/v1beta/models/gemini-pro:generateContent";

  // 中继模式：把 gpt.ge 没有的模型名映射为等价可用名
  if (useRelay) {
    targetPath = targetPath.replace(
      /\/models\/([^:/?]+)([:/?]|$)/,
      (m, name: string, tail: string) =>
        GEMINI_MODEL_ALIASES[name] ? `/models/${GEMINI_MODEL_ALIASES[name]}${tail}` : m,
    );
  }

  // 组装上游 URL（剥掉客户端传来的 key 参数；直连模式才注入 ?key=）
  const searchParams = new URLSearchParams(url.search);
  searchParams.delete("key");
  if (!useRelay) searchParams.set("key", selectedKey);
  const upstreamBase = useRelay ? GEMINI_RELAY_BASE : GEMINI_BASE_URL;
  const targetUrl = `${upstreamBase}${targetPath}?${searchParams.toString()}`;
  console.log(`[${requestId}] Gemini 转发: ${targetPath}`);

  // 准备转发 headers
  const forwardHeaders = new Headers();
  for (const h of [
    "Content-Type", "Accept", "User-Agent", "Accept-Language",
    "Accept-Encoding", "x-goog-api-client",
  ]) {
    const v = req.headers.get(h);
    if (v) forwardHeaders.set(h, v);
  }
  // 中继模式用 Bearer 认证（gpt.ge 不认 ?key= 参数）
  if (useRelay) forwardHeaders.set("Authorization", `Bearer ${selectedKey}`);

  // 读取请求体
  let body: ArrayBuffer | undefined;
  if (req.method !== "GET" && req.method !== "HEAD") {
    body = await req.arrayBuffer();
    console.log(`[${requestId}] 请求体: ${body.byteLength} bytes`);
  }

  const isStream = url.searchParams.get("alt") === "sse";

  const startTime = Date.now();
  let resp: Response;
  try {
    resp = await fetch(targetUrl, {
      method: req.method,
      headers: forwardHeaders,
      body,
    });
  } catch (e) {
    const elapsed = Date.now() - startTime;
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[${requestId}] Gemini 上游请求失败 (${elapsed}ms): ${msg}`);
    return errorResponse(`Gemini 上游请求失败: ${msg}`, 502, requestId);
  }
  const elapsed = Date.now() - startTime;

  console.log(`[${requestId}] Gemini 响应: ${resp.status} (${elapsed}ms)`);
  if (resp.status === 429) console.warn(`[${requestId}] ⚠️ Key 限速`);

  return buildResponse(resp, requestId, isStream, elapsed, totalKeys, selectedKey);
}

// ── Codex 代理逻辑（新增） ──
// Codex 路由将 /codex/* 转发到 https://chatgpt.com/backend-api/codex/*
// 认证：CLIProxyAPI 管理 OAuth token，通过 Authorization Bearer 传递
// 本代理只做透传，不做 key 轮换
async function proxyCodex(
  req: Request,
  url: URL,
  requestId: string,
): Promise<Response> {
  // 去掉路径前缀 /codex
  let targetPath = url.pathname;
  if (targetPath.startsWith("/codex")) {
    targetPath = targetPath.substring(6); // /codex/responses → /responses
  }
  if (targetPath === "") targetPath = "/responses";

  const targetUrl = `${CODEX_BASE_URL}${targetPath}${url.search}`;
  console.log(`[${requestId}] Codex 转发: ${targetUrl}`);

  // 透传所有 Codex 相关 headers
  const forwardHeaders = new Headers();
  for (const h of [
    "Content-Type", "Accept", "User-Agent", "Accept-Language",
    "Accept-Encoding",
    // Codex 特有 headers — 完整透传
    "Authorization",       // OAuth access token (CLIProxyAPI 管理)
    "Originator",          // codex_cli_rs/codex-tui
    "Chatgpt-Account-Id",  // 账户 ID
    "Session_id",          // 会话 ID
    "X-Codex-Turn-Metadata",
    "X-Client-Request-Id",
    "Thread-Id",
    "X-Codex-Window-Id",
    "X-Codex-Beta-Features",
  ]) {
    const v = req.headers.get(h);
    if (v) forwardHeaders.set(h, v);
  }

  // 读取请求体 & 检测流式
  let body: ArrayBuffer | undefined;
  let isStream = false;
  if (req.method !== "GET" && req.method !== "HEAD") {
    body = await req.arrayBuffer();
    try {
      const text = new TextDecoder().decode(body);
      // Codex 用的是 OpenAI responses API 格式，stream 在 body 里
      if (text.includes('"stream"')) {
        const parsed = JSON.parse(text);
        if (parsed.stream === true) isStream = true;
      }
    } catch { /* ignore */ }
    console.log(`[${requestId}] Codex 请求体: ${body.byteLength} bytes, stream=${isStream}`);
  }

  const startTime = Date.now();
  const resp = await fetch(targetUrl, {
    method: req.method,
    headers: forwardHeaders,
    body,
  });
  const elapsed = Date.now() - startTime;

  console.log(`[${requestId}] Codex 响应: ${resp.status} (${elapsed}ms)`);
  if (resp.status === 429) console.warn(`[${requestId}] ⚠️ Codex 限速`);
  if (resp.status === 401 || resp.status === 403) {
    console.warn(`[${requestId}] ⚠️ Codex 认证/授权失败: ${resp.status}`);
  }

  // Codex 用流式 SSE，直接透传
  const headers = new Headers();
  for (const h of ["Content-Type", "Content-Length", "Content-Encoding", "Transfer-Encoding"]) {
    const v = resp.headers.get(h);
    if (v) headers.set(h, v);
  }
  headers.set("Access-Control-Allow-Origin", "*");
  headers.set("X-Proxy-Request-ID", requestId);
  headers.set("X-Response-Time", `${elapsed}ms`);

  return new Response(resp.body, { status: resp.status, headers });
}

// ── Auth 代理逻辑（auth.openai.com 透传） ──
// 用于 CLIProxyAPI 的 Codex OAuth device code flow
// 透传所有 headers 和 body，不做认证拦截
async function proxyAuth(
  req: Request,
  url: URL,
  requestId: string,
): Promise<Response> {
  // 去掉路径前缀 /auth
  let targetPath = url.pathname;
  if (targetPath.startsWith("/auth")) {
    targetPath = targetPath.substring(5); // /auth/oauth/authorize → /oauth/authorize
  }
  if (targetPath === "") targetPath = "/";

  const targetUrl = `${AUTH_BASE_URL}${targetPath}${url.search}`;
  console.log(`[${requestId}] Auth 转发: ${targetUrl}`);

  // 透传所有 headers
  const forwardHeaders = new Headers();
  for (const [k, v] of req.headers.entries()) {
    // 跳过 host 和代理相关的 headers
    const lower = k.toLowerCase();
    if (lower === "host" || lower === "x-forwarded-for" || lower === "x-real-ip") continue;
    forwardHeaders.set(k, v);
  }
  // 设置正确的 host
  forwardHeaders.set("Host", "auth.openai.com");
  forwardHeaders.set("Origin", "https://auth.openai.com");
  forwardHeaders.set("Referer", "https://auth.openai.com/");

  // 读取请求体
  let body: ArrayBuffer | undefined;
  if (req.method !== "GET" && req.method !== "HEAD") {
    body = await req.arrayBuffer();
    console.log(`[${requestId}] Auth 请求体: ${body.byteLength} bytes`);
  }

  const startTime = Date.now();
  const resp = await fetch(targetUrl, {
    method: req.method,
    headers: forwardHeaders,
    body,
    redirect: "manual", // 不自动跟随重定向，让客户端处理
  });
  const elapsed = Date.now() - startTime;

  console.log(`[${requestId}] Auth 响应: ${resp.status} (${elapsed}ms)`);

  // 透传响应
  const headers = new Headers();
  for (const [k, v] of resp.headers.entries()) {
    const lower = k.toLowerCase();
    if (lower === "location") {
      // 重写重定向 URL 中的 auth.openai.com 为代理地址
      headers.set(k, v.replace(/https?:\/\/auth\.openai\.com/g, `${url.origin}/auth`));
    } else {
      headers.set(k, v);
    }
  }
  headers.set("Access-Control-Allow-Origin", "*");
  headers.set("X-Proxy-Request-ID", requestId);
  headers.set("X-Response-Time", `${elapsed}ms`);

  return new Response(resp.body, { status: resp.status, headers });
}


// ── 通用 Web Fetch 代理 ──
// 从 Deno 边缘节点发起请求，绕过地域 IP 封锁
// 用法: GET /fetch?url=<encoded_url>
async function proxyFetch(
  req: Request,
  url: URL,
  requestId: string,
): Promise<Response> {
  const targetUrl = url.searchParams.get("url");
  if (!targetUrl) {
    return errorResponse("缺少 url 参数。用法: /fetch?url=<encoded_url>", 400, requestId);
  }

  let parsed: URL;
  try {
    parsed = new URL(targetUrl);
  } catch {
    return errorResponse(`无效的 URL: ${targetUrl}`, 400, requestId);
  }

  // 安全限制：仅允许 https
  if (parsed.protocol !== "https:") {
    return errorResponse("仅允许 https 目标", 403, requestId);
  }

  console.log(`[${requestId}] fetch → ${parsed.href}`);

  const startTime = Date.now();
  let resp: Response;
  try {
    // 转发请求的 Cookie header（用于需要认证的请求）
    const fetchHeaders: Record<string, string> = {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,application/json,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9,zh-TW;q=0.8,zh;q=0.7",
    };
    const reqCookie = req.headers.get("Cookie");
    if (reqCookie) fetchHeaders["Cookie"] = reqCookie;
    const reqAuth = req.headers.get("Authorization");
    if (reqAuth) fetchHeaders["Authorization"] = reqAuth;

    resp = await fetch(parsed.href, {
      method: "GET",
      headers: fetchHeaders,
      redirect: "follow",
    });
  } catch (e) {
    const elapsed = Date.now() - startTime;
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[${requestId}] fetch 失败 (${elapsed}ms): ${msg}`);
    return errorResponse(`fetch 失败: ${msg}`, 502, requestId);
  }

  const elapsed = Date.now() - startTime;
  console.log(`[${requestId}] fetch 完成 ${resp.status} (${elapsed}ms)`);

  const headers = new Headers();
  // 同 buildResponse：不转发 Content-Length / Content-Encoding（Deno fetch 已解压，转发会错位）
  for (const h of ["Content-Type", "Last-Modified", "ETag"]) {
    const v = resp.headers.get(h);
    if (v) headers.set(h, v);
  }
  headers.set("Access-Control-Allow-Origin", "*");
  headers.set("X-Proxy-Request-ID", requestId);
  headers.set("X-Fetch-Status", `${resp.status}`);
  headers.set("X-Response-Time", `${elapsed}ms`);

  return new Response(resp.body, { status: resp.status, headers });
}

// ── 构建统一响应 ──
function buildResponse(
  resp: Response,
  requestId: string,
  isStream: boolean,
  elapsed: number,
  totalKeys: number,
  usedKey: string,
): Response {
  const headers = new Headers();
  // 注意：Deno fetch 已自动解压 body，上游的 content-length / content-encoding 是压缩前的值，
  // 原样转发会导致客户端解码错位（表现为空响应，2026-09-02 实测定位）。
  // 只转发 Content-Type，长度/编码头交给运行时重新生成。
  const ct = resp.headers.get("Content-Type");
  if (ct) headers.set("Content-Type", ct);
  headers.set("Access-Control-Allow-Origin", "*");
  headers.set("X-Proxy-Request-ID", requestId);
  headers.set("X-Response-Time", `${elapsed}ms`);
  headers.set("X-API-Key-Count", `${totalKeys}`);

  const contentType = resp.headers.get("Content-Type");
  if (contentType?.includes("text/event-stream") || contentType?.includes("stream") || isStream) {
    console.log(`[${requestId}] 返回流式响应`);
    return new Response(resp.body, { status: resp.status, headers });
  }

  return new Response(resp.body, { status: resp.status, headers });
}

// ── 错误响应 ──
function errorResponse(msg: string, status: number, requestId: string): Response {
  return new Response(
    JSON.stringify({ error: msg, requestId }),
    {
      status,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
    },
  );
}

// ── 使用说明 ──
function helpResponse(): Response {
  return new Response(
    JSON.stringify({
      name: "统一 API 代理",
      version: "2.0.0",
      routes: {
        "/openai/*": {
          target: "OpenAI API",
          example: "POST /openai/v1/chat/completions",
          note: "Key 通过 Authorization Bearer 传递",
        },
        "/gemini/*": {
          target: "Google Gemini API",
          example: "POST /gemini/v1beta/models/gemini-pro:generateContent",
          note: "Key 通过 URL ?key= 传递",
        },
        "/codex/*": {
          target: "ChatGPT Codex API (ChatGPT Plus/Pro)",
          example: "POST /codex/responses",
          note: "OAuth token 通过 Authorization Bearer 传递，透传所有 Codex headers",
        },
        "/auth/*": {
          target: "auth.openai.com 透传（用于 Codex OAuth 登录）",
          example: "POST /auth/api/accounts/deviceauth/usercode",
          note: "透传所有 headers，用于 device code flow，需要 AUTH_KEY",
        },
        "/v1/*": {
          target: "OpenAI API (兼容旧地址)",
          example: "POST /v1/chat/completions",
          note: "直接转发到 OpenAI，向后兼容",
        },
        "/fetch": {
          target: "通用 Web Fetch 代理（Deno 边缘节点出口）",
          example: "GET /fetch?url=https%3A%2F%2Finvestor.tsmc.com%2Fenglish%2Fmonthly-revenue",
          note: "用于绕过地域 IP 封锁，仅允许 https，需要 AUTH_KEY",
        },
      },
      auth: "所有请求都需要在 Authorization/x-api-key/x-goog-api-key 中携带认证密钥",
    }),
    {
      status: 200,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
    },
  );
}

// ── 主 handler ──
async function handler(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const requestId = crypto.randomUUID().substring(0, 8);

  console.log(`\n[${requestId}] ${req.method} ${url.pathname}`);

  // CORS
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }

  // 路由
  const route = resolveRoute(url.pathname);

  if (route === "help") {
    return helpResponse();
  }

  // Codex 和 Auth 路由跳过 AUTH_KEY 验证
  // Codex：认证由上游 chatgpt.com 处理
  // Auth：这是 OAuth flow 本身，不需要代理密钥
  if (route !== "codex" && route !== "auth") {
    const authError = verifyClient(req, requestId);
    if (authError) {
      return errorResponse(authError, 401, requestId);
    }
    console.log(`[${requestId}] 认证成功 → 路由: ${route}`);
  } else {
    console.log(`[${requestId}] ${route} 路由 → 跳过代理认证`);
  }

  if (route === "openai") {
    return proxyOpenAI(req, url, requestId);
  }
  if (route === "gemini") {
    return proxyGemini(req, url, requestId);
  }
  if (route === "codex") {
    return proxyCodex(req, url, requestId);
  }
  if (route === "auth") {
    return proxyAuth(req, url, requestId);
  }
  if (route === "fetch") {
    return proxyFetch(req, url, requestId);
  }

  return errorResponse("未知路由", 404, requestId);
}

Deno.serve(handler);
