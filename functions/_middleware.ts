/**
 * 全局中间件：安全响应头 + 内部前缀拦截。
 *
 * 这里不处理业务鉴权（读免密、写需口令由各端点自行把关），只做两件事：
 *   1. 全站统一注入安全响应头，避免各端点遗漏导致降级。
 *   2. 在进入任何业务代码之前，直接掐掉指向内部前缀与常见探测路径的请求，
 *      让 `_$flaredrive$/...`（回收站等元数据）在 URL 层面就不可达。
 */

const INTERNAL_MARKER = "_$flaredrive$";

/** 常见凭据/配置探测路径：直接 404，不进入 Functions 业务层。 */
const PROBE_PATTERNS = [
  /^\/\.env/i,
  /^\/\.git\//i,
  /^\/\.svn\//i,
  /^\/wp-admin/i,
  /^\/wp-login/i,
  /^\/phpmyadmin/i,
  /^\/\.aws\//i,
  /^\/\.ssh\//i,
];

const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  // MUI/emotion 运行时注入 <style>，样式源必须放开 inline；脚本源仍然只允许同源。
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "media-src 'self' blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "frame-src 'self' blob:",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

function applySecurityHeaders(response: Response, url: URL): Response {
  // Response 头可能是只读的，重新构造一份再写。
  const headers = new Headers(response.headers);
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("X-Frame-Options", "DENY");
  headers.set("Referrer-Policy", "no-referrer");
  headers.set("Permissions-Policy", "geolocation=(), microphone=(), camera=(), usb=()");
  // 端点可以自己声明更严的策略（品牌素材下发的 SVG 用 `sandbox`），此时不覆盖：
  // 全站策略的 script-src 是 'self'，对同源 SVG 文档来说等同于允许执行脚本。
  if (!headers.has("Content-Security-Policy")) {
    headers.set("Content-Security-Policy", CONTENT_SECURITY_POLICY);
  }
  // 分享型网盘不应被搜索引擎收录，降低资料被外部检索到的风险。
  headers.set("X-Robots-Tag", "noindex, nofollow, noarchive");

  const isDynamic =
    url.pathname === "/api" ||
    url.pathname.startsWith("/api/") ||
    url.pathname === "/webdav" ||
    url.pathname.startsWith("/webdav/");
  // 同理：端点自己声明了 Cache-Control 就尊重它（品牌素材是内容寻址的，
  // 需要长缓存；一刀切 no-store 会让每次加载都重新拉图）。
  if (isDynamic && !headers.has("Cache-Control")) {
    headers.set("Cache-Control", "no-store");
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function notFound(): Response {
  return new Response("Not Found", {
    status: 404,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

/** 路径里出现内部前缀就拒绝——同时覆盖百分号编码（%5F）绕过尝试。 */
function hitsInternalPrefix(pathname: string): boolean {
  if (pathname.includes(INTERNAL_MARKER)) return true;
  try {
    return decodeURIComponent(pathname).includes(INTERNAL_MARKER);
  } catch {
    // 非法百分号编码：交给后续业务层按无效路径处理。
    return false;
  }
}

export const onRequest: PagesFunction = async (context) => {
  const url = new URL(context.request.url);

  if (hitsInternalPrefix(url.pathname)) return notFound();
  if (PROBE_PATTERNS.some((pattern) => pattern.test(url.pathname))) {
    return notFound();
  }

  const response = await context.next();
  return applySecurityHeaders(response, url);
};
