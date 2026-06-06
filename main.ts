// === 统一 API 代理服务器 ===
// 支持同时代理 OpenAI 和 Gemini API
// 路由规则：
//   /openai/* → 转发到 OpenAI API（Authorization Bearer 方式认证）
//   /gemini/* → 转发到 Gemini API（URL ?key= 方式认证）
//   /v1/* → 默认转发到 OpenAI API（向后兼容）
// 其他路径 → 返回使用说明

// ── 环境变量 ──
const AUTH_KEY = Deno.env.get("key"); // 客户端统一认证密钥
const OPENAI_API_KEYS_STR = Deno.env.get("openai_apikey"); // OpenAI API 密钥（逗号分隔）
const GEMINI_API_KEYS_STR = Deno.env.get("gemini_apikey"); // Gemini API 密钥（逗号分隔）
const OPENAI_BASE_URL = Deno.env.get("openai_base_url") || "https://api.openai.com";
const GEMINI_BASE_URL = Deno.env.get("gemini_base_url") || "https://generativelanguage.googleapis.com";

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
console.log("================================");
console.log("路由: /openai/* → OpenAI | /gemini/* → Gemini | /v1/* → OpenAI(兼容)");

// ── CORS ──
function corsHeaders(): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers":
      "Content-Type, Authorization, x-api-key, x-goog-api-key, OpenAI-Beta, OpenAI-Organization",
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
type RouteTarget = "openai" | "gemini" | "help";

function resolveRoute(pathname: string): RouteTarget {
  if (pathname.startsWith("/openai/") || pathname === "/openai") return "openai";
  if (pathname.startsWith("/gemini/") || pathname === "/gemini") return "gemini";
  // /v1/ 默认走 OpenAI（向后兼容原 openai-proxy）
  if (pathname.startsWith("/v1/")) return "openai";
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
  if (GEMINI_API_KEYS.length === 0) {
    return errorResponse("Gemini API Keys 未配置", 500, requestId);
  }

  const geminiRef = { value: geminiKeyIndex };
  const selectedKey = getNextKey(GEMINI_API_KEYS, geminiRef);
  geminiKeyIndex = geminiRef.value;
  const keyNum = GEMINI_API_KEYS.indexOf(selectedKey) + 1;
  console.log(`[${requestId}] 使用 Gemini Key #${keyNum}/${GEMINI_API_KEYS.length}`);

  // 去掉路径前缀 /gemini
  let targetPath = url.pathname;
  if (targetPath.startsWith("/gemini")) {
    targetPath = targetPath.substring(6); // /gemini/v1beta/models → /v1beta/models
  }
  if (targetPath === "") targetPath = "/v1beta/models/gemini-pro:generateContent";

  // 替换 URL 中的 key 参数
  const targetUrlObj = new URL(url.search);
  targetUrlObj.searchParams.delete("key");
  targetUrlObj.searchParams.set("key", selectedKey);
  const targetUrl = `${GEMINI_BASE_URL}${targetPath}${targetUrlObj.search}`;
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

  // 读取请求体
  let body: ArrayBuffer | undefined;
  if (req.method !== "GET" && req.method !== "HEAD") {
    body = await req.arrayBuffer();
    console.log(`[${requestId}] 请求体: ${body.byteLength} bytes`);
  }

  const isStream = url.searchParams.get("alt") === "sse";

  const startTime = Date.now();
  const resp = await fetch(targetUrl, {
    method: req.method,
    headers: forwardHeaders,
    body,
  });
  const elapsed = Date.now() - startTime;

  console.log(`[${requestId}] Gemini 响应: ${resp.status} (${elapsed}ms)`);
  if (resp.status === 429) console.warn(`[${requestId}] ⚠️ Key 限速`);

  return buildResponse(resp, requestId, isStream, elapsed, GEMINI_API_KEYS.length, selectedKey);
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
  for (const h of ["Content-Type", "Content-Length", "Content-Encoding", "Transfer-Encoding"]) {
    const v = resp.headers.get(h);
    if (v) headers.set(h, v);
  }
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
      version: "1.0.0",
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
        "/v1/*": {
          target: "OpenAI API (兼容旧地址)",
          example: "POST /v1/chat/completions",
          note: "直接转发到 OpenAI，向后兼容",
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

  // 验证客户端
  const authError = verifyClient(req, requestId);
  if (authError) {
    return errorResponse(authError, 401, requestId);
  }

  console.log(`[${requestId}] 认证成功 → 路由: ${route}`);

  if (route === "openai") {
    return proxyOpenAI(req, url, requestId);
  }
  if (route === "gemini") {
    return proxyGemini(req, url, requestId);
  }

  return errorResponse("未知路由", 404, requestId);
}

Deno.serve(handler);
