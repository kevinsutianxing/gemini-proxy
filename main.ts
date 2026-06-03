// Gemini API 基础 URL
const GEMINI_API_BASE = "https://generativelanguage.googleapis.com";

// 从环境变量获取配置
const AUTH_KEY = Deno.env.get("key"); // 用户认证密钥
const GEMINI_API_KEYS_STR = Deno.env.get("apikey"); // Gemini API 密钥（可以是多个，用逗号分隔）

// 解析多个 API Keys
let GEMINI_API_KEYS: string[] = [];
if (GEMINI_API_KEYS_STR) {
  // 分割并清理每个 key（去除空格）
  GEMINI_API_KEYS = GEMINI_API_KEYS_STR
    .split(',')
    .map(key => key.trim())
    .filter(key => key.length > 0);
}

// 随机获取一个 API Key
function getRandomApiKey(): string {
  if (GEMINI_API_KEYS.length === 0) {
    throw new Error("没有可用的 API Key");
  }
  
  // 随机选择一个 API Key
  const randomIndex = Math.floor(Math.random() * GEMINI_API_KEYS.length);
  const selectedKey = GEMINI_API_KEYS[randomIndex];
  
  console.log(`选择 API Key #${randomIndex + 1}/${GEMINI_API_KEYS.length}`);
  
  return selectedKey;
}

// 启动时打印配置状态（不打印实际值）
console.log("=== 服务器启动配置检查 ===");
console.log(`AUTH_KEY 是否已设置: ${AUTH_KEY ? '是' : '否'}`);
console.log(`AUTH_KEY 长度: ${AUTH_KEY ? AUTH_KEY.length : 0}`);
console.log(`GEMINI_API_KEYS 数量: ${GEMINI_API_KEYS.length}`);
if (GEMINI_API_KEYS.length > 0) {
  console.log(`API Keys 长度分布: ${GEMINI_API_KEYS.map(k => k.length).join(', ')}`);
}
console.log("========================");

// 处理请求的主函数
async function handler(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const requestId = crypto.randomUUID().substring(0, 8); // 生成请求ID用于日志追踪
  
  console.log(`\n[${requestId}] === 收到请求 ===`);
  console.log(`[${requestId}] 方法: ${req.method}`);
  console.log(`[${requestId}] 路径: ${url.pathname}`);
  
  // 处理 CORS 预检请求
  if (req.method === "OPTIONS") {
    console.log(`[${requestId}] 处理 OPTIONS 预检请求`);
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization, x-api-key, x-goog-api-key",
        "Access-Control-Max-Age": "86400",
      },
    });
  }

  try {
    // 检查环境变量是否配置
    if (!AUTH_KEY || GEMINI_API_KEYS.length === 0) {
      console.error(`[${requestId}] 错误：环境变量未正确配置`);
      return new Response(
        JSON.stringify({ 
          error: "服务器配置错误",
          details: {
            auth_key_configured: !!AUTH_KEY,
            api_keys_count: GEMINI_API_KEYS.length
          }
        }),
        { 
          status: 500,
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
          }
        }
      );
    }

    // 从请求中提取 API 密钥
    let clientKey = "";
    let keySource = "";
    
    // 首先尝试从 x-goog-api-key header 获取（CherryStudio 使用这个）
    const googApiKey = req.headers.get("x-goog-api-key");
    if (googApiKey) {
      clientKey = googApiKey.trim();
      keySource = "x-goog-api-key header";
    }
    
    // 如果没有，尝试从 Authorization header 获取
    if (!clientKey) {
      const authHeader = req.headers.get("Authorization");
      if (authHeader) {
        if (authHeader.toLowerCase().startsWith("bearer ")) {
          clientKey = authHeader.substring(7).trim();
          keySource = "Authorization Bearer";
        } else {
          clientKey = authHeader.trim();
          keySource = "Authorization (direct)";
        }
      }
    }
    
    // 如果 Authorization header 没有，尝试从 x-api-key header 获取
    if (!clientKey) {
      const xApiKey = req.headers.get("x-api-key");
      if (xApiKey) {
        clientKey = xApiKey.trim();
        keySource = "x-api-key header";
      }
    }
    
    // 如果还是没有，尝试从 URL 参数获取
    if (!clientKey) {
      const urlKey = url.searchParams.get("key");
      if (urlKey) {
        clientKey = urlKey.trim();
        keySource = "URL parameter";
      }
    }

    console.log(`[${requestId}] 客户端密钥来源: ${keySource || '未找到'}`);
    
    // 验证客户端密钥
    if (!clientKey) {
      console.log(`[${requestId}] 认证失败：未提供密钥`);
      return new Response(
        JSON.stringify({ 
          error: "认证失败：未提供API密钥",
          hint: "请在 x-goog-api-key 或 Authorization header 中提供密钥"
        }),
        { 
          status: 401,
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
          }
        }
      );
    }
    
    if (clientKey !== AUTH_KEY) {
      console.log(`[${requestId}] 认证失败：密钥不匹配`);
      return new Response(
        JSON.stringify({ 
          error: "认证失败：API密钥无效"
        }),
        { 
          status: 401,
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
          }
        }
      );
    }

    console.log(`[${requestId}] 认证成功`);

    // 随机选择一个 Gemini API Key
    const selectedApiKey = getRandomApiKey();
    const keyIndex = GEMINI_API_KEYS.indexOf(selectedApiKey) + 1;
    console.log(`[${requestId}] 使用 API Key #${keyIndex}/${GEMINI_API_KEYS.length}`);

    // 构建目标 URL
    const targetPath = url.pathname;
    url.searchParams.delete("key");
    url.searchParams.set("key", selectedApiKey);
    const targetUrl = `${GEMINI_API_BASE}${targetPath}${url.search}`;
    
    console.log(`[${requestId}] 转发到: ${targetPath}`);

    // 准备转发请求的 headers
    const forwardHeaders = new Headers();
    const headersToForward = [
      "Content-Type",
      "Accept",
      "User-Agent",
      "Accept-Language",
      "Accept-Encoding",
      "x-goog-api-client",
    ];
    
    for (const header of headersToForward) {
      const value = req.headers.get(header);
      if (value) {
        forwardHeaders.set(header, value);
      }
    }

    // 准备请求体
    let body = null;
    if (req.method !== "GET" && req.method !== "HEAD") {
      body = await req.arrayBuffer();
      console.log(`[${requestId}] 请求体大小: ${body.byteLength} bytes`);
    }

    // 转发请求到 Gemini API
    const startTime = Date.now();
    const geminiResponse = await fetch(targetUrl, {
      method: req.method,
      headers: forwardHeaders,
      body: body ? body : undefined,
    });
    const responseTime = Date.now() - startTime;

    console.log(`[${requestId}] Gemini 响应: ${geminiResponse.status} (${responseTime}ms)`);
    
    // 如果返回 429，记录哪个 Key 触发了限制
    if (geminiResponse.status === 429) {
      console.warn(`[${requestId}] ⚠️ API Key #${keyIndex} 触发速率限制`);
    }

    // 准备响应 headers
    const responseHeaders = new Headers();
    const headersToReturn = [
      "Content-Type",
      "Content-Length",
      "Content-Encoding",
      "Transfer-Encoding",
    ];
    
    for (const header of headersToReturn) {
      const value = geminiResponse.headers.get(header);
      if (value) {
        responseHeaders.set(header, value);
      }
    }
    
    // 添加 CORS 和调试 headers
    responseHeaders.set("Access-Control-Allow-Origin", "*");
    responseHeaders.set("X-Request-ID", requestId);
    responseHeaders.set("X-API-Key-Used", `${keyIndex}/${GEMINI_API_KEYS.length}`);
    
    // 处理流式响应
    const contentType = geminiResponse.headers.get("Content-Type");
    if (contentType?.includes("stream") || url.searchParams.get("alt") === "sse") {
      console.log(`[${requestId}] 返回流式响应`);
      return new Response(geminiResponse.body, {
        status: geminiResponse.status,
        headers: responseHeaders,
      });
    }

    // 对于非流式响应
    const responseBody = await geminiResponse.arrayBuffer();
    console.log(`[${requestId}] 响应体大小: ${responseBody.byteLength} bytes`);
    
    if (geminiResponse.status >= 400) {
      const errorText = new TextDecoder().decode(responseBody);
      console.error(`[${requestId}] API 错误: ${errorText.substring(0, 200)}`);
    }
    
    return new Response(responseBody, {
      status: geminiResponse.status,
      headers: responseHeaders,
    });

  } catch (error) {
    console.error(`[${requestId}] 处理请求时发生错误:`, error);
    return new Response(
      JSON.stringify({ 
        error: "内部服务器错误",
        message: error instanceof Error ? error.message : "未知错误",
        requestId: requestId
      }),
      { 
        status: 500,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        }
      }
    );
  }
}

console.log("Gemini API 代理服务器已启动...");
Deno.serve(handler);
