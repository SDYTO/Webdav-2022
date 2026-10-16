/**
 * Wabdav-2022 共享网盘 —— 后端公共工具层。
 *
 * 访问模型（只读免密 + 写操作口令）：
 *   - 读：目录列举 / 文件元数据 / 下载 / 搜索 / 打包下载 / 回收站列表 —— 完全免鉴权，
 *         任何人凭链接即可浏览与下载（用于对外分享资料）。
 *   - 写：上传 / 新建文件夹 / 重命名 / 移动 / 删除 / 回收站还原与清空 —— 必须携带
 *         `Authorization: Basic base64(ADMIN_USER:ADMIN_PASSWORD)`。
 *
 * 安全约定（本文件是唯一的凭据比较入口，各端点不要自己写 `===` 比口令）：
 *   - 常数时间比较整个 Authorization 头，避免逐字节提前返回造成的时序侧信道。
 *   - fail closed：口令未配置或为空时一律拒绝，杜绝 `btoa(":")` 这类固定头被猜中。
 *
 * 内部对象前缀 `_$flaredrive$/` 存放回收站等元数据，所有读写入口都必须拒绝访问。
 */

/** 内部元数据前缀（回收站等）。用户不可见、不可读写、不可打包、不可搜索。 */
export const INTERNAL_PREFIX = "_$flaredrive$/";
/** 回收站对象前缀（内部前缀的子路径）。 */
export const TRASH_PREFIX = `${INTERNAL_PREFIX}trash/`;

export interface DriveEnv {
  BUCKET: R2Bucket;
  /** 写操作用户名，默认 admin。 */
  ADMIN_USER?: string;
  /** 写操作口令。未配置时所有写操作一律拒绝（fail closed）。 */
  ADMIN_PASSWORD?: string;
  /** 回收站保留天数，默认 30；-1 关闭自动清理；0 表示全部视为过期。 */
  TRASH_RETENTION_DAYS?: string;
}

export function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

export function textResponse(message: string, status: number) {
  return new Response(message, {
    status,
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}

export function timingSafeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

// UTF-8 安全 Base64：btoa 只接受 Latin-1，非 ASCII 口令会抛异常。
// TextEncoder 输出 UTF-8 字节后按字节转 binary string。
export function utf8ToBase64(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

export function adminUser(env: DriveEnv): string {
  const user = (env.ADMIN_USER || "").trim();
  return user || "admin";
}

/**
 * 写操作鉴权：通过返回 null，未通过返回可直接返回给客户端的 Response。
 * 所有写端点（含 WebDAV 写方法）统一调用它，不要各写一份。
 */
export function requireWrite(request: Request, env: DriveEnv): Response | null {
  const password = env.ADMIN_PASSWORD || "";
  if (!password) {
    // fail closed：没有配置口令 = 没有任何人能写，而不是"任何人可写"。
    return textResponse(
      "写操作口令未配置（请在部署环境变量中设置 ADMIN_PASSWORD）",
      503
    );
  }
  const authorization = request.headers.get("Authorization") || "";
  const expected = `Basic ${utf8ToBase64(`${adminUser(env)}:${password}`)}`;
  if (!timingSafeEqual(authorization, expected)) {
    return new Response("Unauthorized", {
      status: 401,
      headers: {
        "WWW-Authenticate": 'Basic realm="Wabdav-2022", charset="UTF-8"',
        "Content-Type": "text/plain; charset=utf-8",
      },
    });
  }
  return null;
}

/** 判断请求是否携带了写操作凭据（前端据此显示"已登录"状态，不做安全判定）。 */
export function hasWriteCredentials(request: Request): boolean {
  return /^Basic\s+/i.test((request.headers.get("Authorization") || "").trim());
}

export function isInternalKey(key: string) {
  // normalizeDirKey 会剥掉结尾斜杠，所以裸的内部根（"_$flaredrive$"）必须精确匹配。
  // 不能直接用 startsWith("_$flaredrive$")，否则会把用户目录 "_$flaredrive$backup" 误判为内部目录。
  return (
    key === "_$flaredrive$" ||
    key.startsWith(INTERNAL_PREFIX) ||
    key.includes("/_$flaredrive$/") ||
    key.endsWith("/_$flaredrive$")
  );
}

export function isCollectionObject(
  object: { httpMetadata?: R2HTTPMetadata; customMetadata?: Record<string, string> } | null
) {
  if (!object) return false;
  return (
    object.customMetadata?.resourcetype === "<collection />" ||
    object.httpMetadata?.contentType === "application/x-directory"
  );
}

/**
 * 归一化 path 参数。**不做 URL 解码**：查询参数经 URLSearchParams 已解码过一次，
 * JSON 正文里本来就是原始键；再 decodeURIComponent 一次会把文件名里的字面量 `%XX`
 * 当成转义（`%2e` → `.`、`a%2Fb` → `a/b`），指到别的对象上。
 */
export function decodeRawPath(raw: string | null): string {
  const path = (raw || "").trim();
  return path.replace(/\\/g, "/").replace(/^\/+/, "");
}

export function splitSafeParts(path: string): string[] | Response {
  const parts = path.split("/").filter((part) => part && part !== ".");
  if (parts.some((part) => part === "..")) {
    return textResponse("路径不合法", 400);
  }
  return parts;
}

export function isTruthyParam(raw: unknown): boolean {
  if (raw === true || raw === 1) return true;
  if (typeof raw !== "string") return false;
  const value = raw.trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes";
}

export function normalizeFileKey(raw: string | null): string | Response {
  const decoded = decodeRawPath(raw);
  if (!decoded) return textResponse("缺少 path 参数", 400);
  const parts = splitSafeParts(decoded);
  if (parts instanceof Response) return parts;
  if (parts.length === 0) return textResponse("缺少 path 参数", 400);
  const key = parts.join("/");
  if (isInternalKey(key)) return textResponse("禁止访问内部目录", 400);
  if (decoded.endsWith("/")) return textResponse("不能操作目录", 400);
  return key;
}

/** 目录键：允许结尾斜杠（自动剥掉），文件与目录通用。 */
export function normalizeDirKey(raw: string | null): string | Response {
  const decoded = decodeRawPath(raw);
  if (!decoded) return textResponse("缺少 path 参数", 400);
  const parts = splitSafeParts(decoded);
  if (parts instanceof Response) return parts;
  if (parts.length === 0) return textResponse("缺少 path 参数", 400);
  const key = parts.join("/");
  if (isInternalKey(key)) return textResponse("禁止访问内部目录", 400);
  return key;
}

/** 目录递归操作的单次对象数上限，超出时要求调用方分批。 */
export const MAX_DIR_OBJECTS = 1000;

export async function listDescendants(
  bucket: R2Bucket,
  dirKey: string,
  limit = MAX_DIR_OBJECTS
): Promise<{ objects: R2Object[] } | Response> {
  const objects: R2Object[] = [];
  let cursor: string | undefined;
  do {
    const listing = await bucket.list({
      prefix: `${dirKey}/`,
      cursor,
      include: ["httpMetadata", "customMetadata"],
    });
    for (const object of listing.objects) {
      if (isInternalKey(object.key)) continue;
      objects.push(object);
      if (objects.length > limit) {
        return textResponse(`目录包含超过 ${limit} 个对象，请分批处理`, 400);
      }
    }
    if (!listing.truncated) break;
    cursor = listing.cursor;
  } while (true);
  return { objects };
}

export async function isPrefixOnlyFolder(
  bucket: R2Bucket,
  key: string
): Promise<boolean> {
  const listing = await bucket.list({
    prefix: `${key}/`,
    limit: 1,
  });
  const prefixes = (listing as { delimitedPrefixes?: string[] }).delimitedPrefixes;
  return listing.objects.length > 0 || Boolean(prefixes && prefixes.length > 0);
}

/** 判断 key 是「目录」：有目录标记，或是只有前缀的虚拟目录。 */
export async function resolveAsDirectory(
  bucket: R2Bucket,
  key: string
): Promise<boolean> {
  const head = await bucket.head(key);
  if (head !== null) return isCollectionObject(head);
  return isPrefixOnlyFolder(bucket, key);
}

/** 逐级补建父目录标记（0 字节 + application/x-directory）。 */
export async function ensureFolderMarkers(bucket: R2Bucket, folder: string) {
  if (!folder) return;
  const parts = folder.replace(/\/$/, "").split("/").filter(Boolean);
  let current = "";
  for (const part of parts) {
    current = current ? `${current}/${part}` : part;
    const head = await bucket.head(current);
    if (head === null) {
      await bucket.put(current, new Uint8Array(), {
        httpMetadata: { contentType: "application/x-directory" },
        customMetadata: { resourcetype: "<collection />" },
      });
    }
  }
}

/** 目录整体移动：先复制后代到新前缀，再删源，最后搬目录标记。 */
export async function moveDirectory(
  bucket: R2Bucket,
  from: string,
  to: string
): Promise<Response | null> {
  const descendants = await listDescendants(bucket, from);
  if (descendants instanceof Response) return descendants;

  for (const object of descendants.objects) {
    const target = `${to}/${object.key.slice(from.length + 1)}`;
    const body = await bucket.get(object.key);
    if (body === null) continue;
    await bucket.put(target, body.body, {
      httpMetadata: body.httpMetadata,
      customMetadata: body.customMetadata,
    });
  }
  for (const object of descendants.objects) {
    await bucket.delete(object.key);
  }

  const marker = await bucket.get(from);
  if (marker !== null) {
    await bucket.put(to, marker.body, {
      httpMetadata: marker.httpMetadata,
      customMetadata: marker.customMetadata,
    });
    await bucket.delete(from);
  } else {
    await bucket.put(to, new Uint8Array(), {
      httpMetadata: { contentType: "application/x-directory" },
      customMetadata: { resourcetype: "<collection />" },
    });
  }
  return null;
}

/** 目录整体删除（递归硬删）：先删后代，再删目录标记。 */
export async function deleteDirectory(
  bucket: R2Bucket,
  dirKey: string
): Promise<Response | null> {
  const descendants = await listDescendants(bucket, dirKey);
  if (descendants instanceof Response) return descendants;
  for (const object of descendants.objects) {
    await bucket.delete(object.key);
  }
  await bucket.delete(dirKey);
  return null;
}

export function splitNameExt(name: string): { stem: string; ext: string } {
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return { stem: name, ext: "" };
  return { stem: name.slice(0, dot), ext: name.slice(dot) };
}

export function formatConflictStamp(date = new Date()): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  const hh = String(date.getUTCHours()).padStart(2, "0");
  const mm = String(date.getUTCMinutes()).padStart(2, "0");
  const ss = String(date.getUTCSeconds()).padStart(2, "0");
  return `${y}${m}${d}T${hh}${mm}${ss}`;
}

/**
 * 拷贝单个对象（保留 httpMetadata/customMetadata）。
 * 目录与源不存在返回错误 Response；成功返回 null。
 */
export async function copyObject(
  bucket: R2Bucket,
  from: string,
  to: string,
  options?: { overwrite?: boolean }
): Promise<Response | null> {
  if (!options?.overwrite) {
    const dest = await bucket.head(to);
    if (dest !== null) {
      return textResponse("目标已存在", 409);
    }
  }
  const source = await bucket.get(from);
  if (source === null) return textResponse("文件不存在", 404);
  if (isCollectionObject(source)) {
    return textResponse("只能操作文件，不能操作目录", 400);
  }
  await bucket.put(to, source.body, {
    httpMetadata: source.httpMetadata,
    customMetadata: source.customMetadata,
  });
  return null;
}

export async function copyThenDelete(
  bucket: R2Bucket,
  from: string,
  to: string
): Promise<Response | null> {
  const error = await copyObject(bucket, from, to, { overwrite: true });
  if (error) return error;
  await bucket.delete(from);
  return null;
}
