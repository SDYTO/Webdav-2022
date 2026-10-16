/**
 * 品牌配置读写端点。
 *
 *   GET    /api/branding                     读取当前品牌（免密；主站与 WebDAV 页都靠它）
 *   GET    /api/branding?asset=<kind>        读取素材本体（免密；kind = logo | icon | appleTouchIcon）
 *   POST   /api/branding                     上传素材 / 修改文本（**需管理口令**）
 *   DELETE /api/branding                     清空运行期品牌，回落构建期默认（**需管理口令**）
 *
 * 为什么素材要单独一个出口：文件存在内部前缀 `_$flaredrive$/branding/` 下，
 * 那里被中间件与各端点全量拒绝（枚举 / 下载 / 搜索 / 打包 / WebDAV 都不可达）。
 * 这里按 kind 白名单取出，且只回图片类型，是这个目录唯一的公开读出口。
 *
 * 安全要点：
 *   - 写操作统一走 `requireWrite`（常数时间比较 + fail closed）。
 *   - 素材按**内容**嗅探格式，不信文件名与浏览器给的 MIME。
 *   - SVG 上传时消毒（剥 script / on* / foreignObject / javascript:），下发时再加 CSP `sandbox`。
 *   - 素材落在由 kind 决定的固定键上，用户无法借文件名跳到别的对象。
 */

import {
  ASSET_KINDS,
  ASSET_LABEL,
  acceptAsset,
  clearStoredBranding,
  isAssetKind,
  isBrandingKey,
  normalizeText,
  persistAsset,
  readStoredBranding,
  removeAssetObjects,
  resolveBranding,
  writeStoredBranding,
  type AssetKind,
  type StoredAsset,
  type StoredBranding,
} from "../_branding";
import { requireWrite, jsonResponse, textResponse, type DriveEnv } from "./_core";

type BrandingEnv = DriveEnv;

const TEXT_FIELDS = ["siteName", "shortName", "description"] as const;

/** 素材缓存一年：URL 带内容版本（?v=），换图即换地址，不需要访客手动刷新。 */
const ASSET_CACHE_CONTROL = "public, max-age=31536000, immutable";

async function serveAsset(
  env: BrandingEnv,
  kind: AssetKind,
  request: Request
): Promise<Response> {
  const label = ASSET_LABEL[kind];
  const stored = await readStoredBranding(env.BUCKET);
  const asset = stored.assets?.[kind];
  if (!asset || !isBrandingKey(asset.key)) return textResponse(`未配置${label}`, 404);

  const etag = `"${asset.version}"`;
  if ((request.headers.get("If-None-Match") || "").includes(etag)) {
    return new Response(null, { status: 304, headers: { ETag: etag } });
  }

  const object = await env.BUCKET.get(asset.key);
  if (object === null) return textResponse(`未配置${label}`, 404);

  const headers = new Headers();
  headers.set("Content-Type", asset.type || "application/octet-stream");
  headers.set("Content-Length", String(object.size));
  headers.set("ETag", etag);
  headers.set("Cache-Control", ASSET_CACHE_CONTROL);
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Content-Disposition", "inline");
  if (asset.type === "image/svg+xml") {
    // 直接打开 SVG 时按沙箱文档对待：不同源、不执行脚本。
    // 经 <img> / CSS 引用时该响应头不参与文档策略，不影响正常显示。
    headers.set("Content-Security-Policy", "sandbox");
  }
  return new Response(object.body, { status: 200, headers });
}

export const onRequestGet: PagesFunction<BrandingEnv> = async (context) => {
  const url = new URL(context.request.url);
  const kind = url.searchParams.get("asset");
  if (kind !== null) {
    if (!isAssetKind(kind)) return textResponse("未知的素材类型", 400);
    return serveAsset(context.env, kind, context.request);
  }

  const stored = await readStoredBranding(context.env.BUCKET);
  return jsonResponse(resolveBranding(stored));
};

// 浏览器只在 <link rel=icon> 换地址时发 GET；HEAD 留个等价出口，避免 405 噪声。
export const onRequestHead = onRequestGet;

export const onRequestPost: PagesFunction<BrandingEnv> = async (context) => {
  const denied = requireWrite(context.request, context.env);
  if (denied) return denied;

  let form: FormData;
  try {
    form = await context.request.formData();
  } catch {
    return jsonResponse({ error: "请求体不是合法的表单数据" }, 400);
  }

  const bucket = context.env.BUCKET;
  const stored = await readStoredBranding(bucket);
  const assets: Partial<Record<AssetKind, StoredAsset>> = { ...(stored.assets ?? {}) };
  const notes: string[] = [];

  for (const kind of ASSET_KINDS) {
    const label = ASSET_LABEL[kind];
    const flag = form.get(`remove__${kind}`);

    if (flag === "1" || flag === "true") {
      await removeAssetObjects(bucket, kind);
      delete assets[kind];
      notes.push(`已清除${label}`);
      continue;
    }

    const file = form.get(kind);
    if (!(file instanceof File) || file.size === 0) continue;

    const accepted = await acceptAsset(kind, new Uint8Array(await file.arrayBuffer()));
    if (!accepted.ok) return jsonResponse({ error: accepted.error }, 400);

    assets[kind] = await persistAsset(bucket, kind, accepted);
    notes.push(`已更新${label}`);
    for (const note of accepted.notes) notes.push(`${label}：${note}`);
  }

  const next: StoredBranding = { ...stored, assets };

  for (const field of TEXT_FIELDS) {
    const raw = form.get(field);
    if (typeof raw !== "string") continue; // 表单没带这个字段 = 不改
    const normalized = normalizeText(raw, field);
    if (!normalized.ok) return jsonResponse({ error: normalized.error }, 400);
    // 留空 = 删掉覆盖值，回落到构建期默认
    if (normalized.value) next[field] = normalized.value;
    else delete next[field];
  }

  const showName = form.get("showNameBesideLogo");
  if (typeof showName === "string") {
    next.showNameBesideLogo = showName === "true" || showName === "1";
  }

  next.updatedAt = new Date().toISOString();
  await writeStoredBranding(bucket, next);

  return jsonResponse({ ...resolveBranding(next), notes });
};

export const onRequestDelete: PagesFunction<BrandingEnv> = async (context) => {
  const denied = requireWrite(context.request, context.env);
  if (denied) return denied;

  await clearStoredBranding(context.env.BUCKET);
  return jsonResponse({ ...resolveBranding({}), notes: ["已恢复为默认品牌"] });
};
