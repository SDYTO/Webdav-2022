/**
 * 运行时品牌配置（站点名 / Logo / 图标）的读写与校验层。
 *
 * 与构建期的差异：
 *   - `branding/branding.generated.ts` 是构建期常量，改它必须重新部署；
 *   - 本模块面向「管理员在界面里改品牌」：配置与素材存在 R2 的内部前缀下，
 *     保存即全站生效（主站客户端渲染、WebDAV 服务端渲染、PWA manifest 都读它）。
 *   - 两者是「默认值 + 覆盖」的关系：R2 里没有配置时，一切回落到构建期常量，
 *     因此不配置任何东西时表现与改造前完全一致。
 *
 * 存放位置：`_$flaredrive$/branding/`
 *   - `config.json`  文本字段 + 各素材的索引（对象键、MIME、体积、内容版本、像素尺寸）
 *   - `logo.<ext>` / `icon.<ext>` / `apple-touch-icon.<ext>`  素材本体
 *
 * 之所以放内部前缀：那里的所有常规入口（列举、下载、搜索、打包、WebDAV）都已被拒绝，
 * 素材只能经由 `/api/branding?asset=...` 这一个受控出口读出。
 */

import { BRANDING } from "../branding/branding.generated";
import { INTERNAL_PREFIX } from "./api/_core";

export const BRANDING_PREFIX = `${INTERNAL_PREFIX}branding/`;
export const BRANDING_CONFIG_KEY = `${BRANDING_PREFIX}config.json`;

export const ASSET_KINDS = ["logo", "icon", "appleTouchIcon"] as const;
export type AssetKind = (typeof ASSET_KINDS)[number];

/** 中文标签，仅用于错误提示与界面文案。 */
export const ASSET_LABEL: Record<AssetKind, string> = {
  logo: "Logo",
  icon: "站点图标",
  appleTouchIcon: "主屏图标",
};

export function isAssetKind(value: string): value is AssetKind {
  return (ASSET_KINDS as readonly string[]).includes(value);
}

/** 文本字段长度上限，与 tools/build-branding.mjs 的校验口径保持一致。 */
export const TEXT_LIMITS = { siteName: 60, shortName: 24, description: 200 };

/** 素材体积上限（按扩展名）。品牌素材不该有这么大，超了基本是选错文件。 */
const MAX_BYTES: Record<string, number> = {
  ".svg": 256 * 1024,
  ".png": 1024 * 1024,
  ".jpg": 1024 * 1024,
  ".jpeg": 1024 * 1024,
  ".gif": 1024 * 1024,
  ".webp": 1024 * 1024,
  ".ico": 256 * 1024,
};
const DEFAULT_MAX_BYTES = 1024 * 1024;

export interface StoredAsset {
  /** R2 对象键（必定位于 BRANDING_PREFIX 之下） */
  key: string;
  /** 规范化后的 MIME 类型 */
  type: string;
  /** 字节数 */
  size: number;
  /** 内容版本（内容哈希前缀），用于生成换图即失效的 URL */
  version: string;
  /** 位图的真实像素宽；矢量图为 null */
  width: number | null;
  /** 位图的真实像素高；矢量图为 null */
  height: number | null;
  /** 宽高比（宽 / 高）。位图由像素算，矢量图由 viewBox / width-height 推，都拿不到时为 null */
  ratio: number | null;
}

export interface StoredBranding {
  siteName?: string;
  shortName?: string;
  description?: string;
  showNameBesideLogo?: boolean;
  assets?: Partial<Record<AssetKind, StoredAsset>>;
  updatedAt?: string;
}

/** 交给前端 / 服务端渲染使用的、已合并默认值的品牌数据。 */
export interface RuntimeBranding {
  siteName: string;
  shortName: string;
  description: string;
  showNameBesideLogo: boolean;
  logoUrl: string | null;
  logoAspectRatio: number | null;
  iconUrl: string;
  iconType: string;
  appleTouchIconUrl: string;
  /** 是否存在运行期自定义；界面据此显示「已自定义」与「恢复默认」 */
  customized: boolean;
  updatedAt: string | null;
}

export function assetUrl(kind: AssetKind, version: string): string {
  return `/api/branding?asset=${kind}&v=${encodeURIComponent(version)}`;
}

/** 素材对象键必须落在内部品牌目录内，且不含穿越片段。 */
export function isBrandingKey(key: unknown): key is string {
  return (
    typeof key === "string" &&
    key.startsWith(BRANDING_PREFIX) &&
    key.length > BRANDING_PREFIX.length &&
    !key.includes("..") &&
    !key.includes("\\")
  );
}

export function assetKey(kind: AssetKind, ext: string): string {
  return `${BRANDING_PREFIX}${kind === "appleTouchIcon" ? "apple-touch-icon" : kind}${ext}`;
}

// ————————————————————————————————————————————————————————————
// 读取 / 写入
// ————————————————————————————————————————————————————————————

/**
 * 读取已存储的品牌配置。任何异常都退化为「空配置」：
 * 一次改品牌失败不该让站点打不开，回落到构建期默认值即可。
 */
export async function readStoredBranding(bucket: R2Bucket): Promise<StoredBranding> {
  try {
    const object = await bucket.get(BRANDING_CONFIG_KEY);
    if (object === null) return {};
    const parsed: unknown = JSON.parse(await object.text());
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed as StoredBranding;
  } catch {
    return {};
  }
}

export async function writeStoredBranding(
  bucket: R2Bucket,
  data: StoredBranding
): Promise<void> {
  await bucket.put(BRANDING_CONFIG_KEY, JSON.stringify(data, null, 2), {
    httpMetadata: { contentType: "application/json; charset=utf-8" },
    customMetadata: { resourcetype: "branding-config" },
  });
}

/** 清空全部运行期品牌数据（素材 + 配置）。 */
export async function clearStoredBranding(bucket: R2Bucket): Promise<void> {
  let cursor: string | undefined;
  do {
    const listing = await bucket.list({ prefix: BRANDING_PREFIX, cursor });
    for (const object of listing.objects) {
      await bucket.delete(object.key);
    }
    cursor = listing.truncated ? listing.cursor : undefined;
  } while (cursor);
}

/**
 * 删除某个素材的历史对象。
 * 按 `<kind>.` 前缀清而不是只删索引里的那个键：换了扩展名（logo.svg → logo.png）时
 * 旧对象仍在 R2 里，只删新键会留下垃圾。
 */
export async function removeAssetObjects(bucket: R2Bucket, kind: AssetKind): Promise<void> {
  const listing = await bucket.list({ prefix: assetKey(kind, ".") });
  for (const object of listing.objects) {
    await bucket.delete(object.key);
  }
}

// ————————————————————————————————————————————————————————————
// 合并：R2 覆盖 → 构建期默认
// ————————————————————————————————————————————————————————————

function trimmedOr(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  return trimmed || fallback;
}

function assetOf(
  stored: StoredBranding,
  kind: AssetKind
): (StoredAsset & { key: string }) | null {
  const asset = stored.assets?.[kind];
  if (!asset || !isBrandingKey(asset.key) || typeof asset.version !== "string") {
    return null;
  }
  return asset as StoredAsset & { key: string };
}

function ratioOf(asset: StoredAsset | null): number | null {
  if (!asset) return null;
  if (typeof asset.ratio === "number" && asset.ratio > 0) return asset.ratio;
  if (!asset.width || !asset.height) return null;
  return Math.round((asset.width / asset.height) * 10000) / 10000;
}

export function resolveBranding(stored: StoredBranding): RuntimeBranding {
  const logo = assetOf(stored, "logo");
  const icon = assetOf(stored, "icon");
  const apple = assetOf(stored, "appleTouchIcon");

  return {
    siteName: trimmedOr(stored.siteName, BRANDING.siteName),
    shortName: trimmedOr(stored.shortName, BRANDING.shortName),
    description: trimmedOr(stored.description, BRANDING.description),
    showNameBesideLogo:
      typeof stored.showNameBesideLogo === "boolean"
        ? stored.showNameBesideLogo
        : BRANDING.showNameBesideLogo,
    logoUrl: logo ? assetUrl("logo", logo.version) : BRANDING.logoUrl,
    logoAspectRatio: logo ? ratioOf(logo) : BRANDING.logoAspectRatio,
    iconUrl: icon ? assetUrl("icon", icon.version) : BRANDING.iconUrl,
    iconType: icon ? icon.type : BRANDING.iconType,
    // iOS 主屏图标的三级回退：专用图 → favicon → 构建期默认
    appleTouchIconUrl: apple
      ? assetUrl("appleTouchIcon", apple.version)
      : icon
      ? assetUrl("icon", icon.version)
      : BRANDING.appleTouchIconUrl,
    customized: Boolean(
      logo ||
        icon ||
        apple ||
        stored.siteName ||
        stored.shortName ||
        stored.description ||
        typeof stored.showNameBesideLogo === "boolean"
    ),
    updatedAt: typeof stored.updatedAt === "string" ? stored.updatedAt : null,
  };
}

// ————————————————————————————————————————————————————————————
// 素材校验
// ————————————————————————————————————————————————————————————

export interface AcceptedAsset {
  ok: true;
  /** 消毒 / 规范化之后的字节（SVG 会补 xmlns、剥脚本） */
  bytes: Uint8Array;
  type: string;
  ext: string;
  width: number | null;
  height: number | null;
  /** 宽高比（宽 / 高）；拿到就用于在图片加载前预留空间 */
  ratio: number | null;
  /** 处理过程中的提示，例如「已移除 <script> 元素」 */
  notes: string[];
  version: string;
}

export interface RejectedAsset {
  ok: false;
  error: string;
}

function startsWith(bytes: Uint8Array, signature: number[], offset = 0): boolean {
  return signature.every((byte, index) => bytes[offset + index] === byte);
}

function ascii(bytes: Uint8Array, start: number, end: number): string {
  let out = "";
  for (let i = start; i < end && i < bytes.length; i++) out += String.fromCharCode(bytes[i]);
  return out;
}

/**
 * 按**内容**判定图片类型，不信任文件名或浏览器给的 MIME。
 * 返回 null 表示不是支持的图片格式。
 */
function sniffImage(bytes: Uint8Array): { type: string; ext: string } | null {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return { type: "image/png", ext: ".png" };
  }
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return { type: "image/jpeg", ext: ".jpg" };
  const head6 = ascii(bytes, 0, 6);
  if (head6 === "GIF87a" || head6 === "GIF89a") return { type: "image/gif", ext: ".gif" };
  if (startsWith(bytes, [0x00, 0x00, 0x01, 0x00])) return { type: "image/x-icon", ext: ".ico" };
  if (startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && ascii(bytes, 8, 12) === "WEBP") {
    return { type: "image/webp", ext: ".webp" };
  }
  return null;
}

function readPngSize(bytes: Uint8Array): { width: number | null; height: number | null } {
  if (bytes.length < 24 || ascii(bytes, 12, 16) !== "IHDR") return { width: null, height: null };
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

function readGifSize(bytes: Uint8Array): { width: number | null; height: number | null } {
  if (bytes.length < 10) return { width: null, height: null };
  return {
    width: bytes[6] | (bytes[7] << 8),
    height: bytes[8] | (bytes[9] << 8),
  };
}

function readIcoSize(bytes: Uint8Array): { width: number | null; height: number | null } {
  if (bytes.length < 8) return { width: null, height: null };
  // ICO 里 0 表示 256
  return { width: bytes[6] || 256, height: bytes[7] || 256 };
}

/** JPEG：顺着段链找 SOFn，从里面取高宽。 */
function readJpegSize(bytes: Uint8Array): { width: number | null; height: number | null } {
  let offset = 2;
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset++;
      continue;
    }
    const marker = bytes[offset + 1];
    // SOF0..SOF15，排除 DHT(c4) / JPG(c8) / DAC(cc) 三个非 SOF 的 0xCx
    const isSof =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    const length = (bytes[offset + 2] << 8) | bytes[offset + 3];
    if (isSof) {
      return {
        height: (bytes[offset + 5] << 8) | bytes[offset + 6],
        width: (bytes[offset + 7] << 8) | bytes[offset + 8],
      };
    }
    if (length < 2) break;
    offset += 2 + length;
  }
  return { width: null, height: null };
}

function roundRatio(value: number): number {
  return Math.round(value * 10000) / 10000;
}

function svgAspectRatio(text: string): number | null {
  const viewBox =
    /viewBox\s*=\s*["']\s*(-?[\d.]+)[\s,]+(-?[\d.]+)[\s,]+(-?[\d.]+)[\s,]+(-?[\d.]+)\s*["']/i.exec(
      text
    );
  if (viewBox) {
    const width = Number(viewBox[3]);
    const height = Number(viewBox[4]);
    if (width > 0 && height > 0) return roundRatio(width / height);
  }
  const width = /<svg\b[^>]*\bwidth\s*=\s*["']([\d.]+)(?:px)?["']/i.exec(text);
  const height = /<svg\b[^>]*\bheight\s*=\s*["']([\d.]+)(?:px)?["']/i.exec(text);
  if (width && height) {
    const w = Number(width[1]);
    const h = Number(height[1]);
    if (w > 0 && h > 0) return roundRatio(w / h);
  }
  return null;
}

// 与 tools/build-branding.mjs 的 SVG_SCRUBBERS 保持一致。
// 构建期（Node 脚本）与运行期（Functions）无法共用模块，改动时两处都要改。
const SVG_SCRUBBERS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /<script\b[\s\S]*?<\/script\s*>/gi, label: "<script> 元素" },
  { pattern: /<script\b[^>]*\/?>/gi, label: "<script> 元素" },
  { pattern: /<foreignObject\b[\s\S]*?<\/foreignObject\s*>/gi, label: "<foreignObject> 元素" },
  { pattern: /<foreignObject\b[^>]*\/?>/gi, label: "<foreignObject> 元素" },
  { pattern: /<iframe\b[\s\S]*?<\/iframe\s*>/gi, label: "<iframe> 元素" },
  { pattern: /<iframe\b[^>]*\/?>/gi, label: "<iframe> 元素" },
  { pattern: /\son[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, label: "内联事件属性（on*）" },
  {
    pattern:
      /\b(?:xlink:href|href)\s*=\s*(?:"[^"]*javascript:[^"]*"|'[^']*javascript:[^']*'|javascript:[^\s>]+)/gi,
    label: "javascript: 链接",
  },
  { pattern: /<!DOCTYPE[^>]*>/gi, label: "DOCTYPE 声明" },
  { pattern: /<!ENTITY[^>]*>/gi, label: "ENTITY 声明" },
];

/**
 * SVG 消毒。运行期出口本身还有 CSP `sandbox` 兜底，这里是第二道防线：
 * 即便素材被存进 R2，也不会把可执行内容带出去。
 */
export function sanitizeSvg(source: string): {
  text: string;
  notes: string[];
  error?: string;
} {
  let text = source.replace(/^\uFEFF/, "");
  const notes: string[] = [];

  for (const { pattern, label } of SVG_SCRUBBERS) {
    const next = text.replace(pattern, "");
    if (next !== text) {
      const note = `已移除${label}`;
      if (!notes.includes(note)) notes.push(note);
      text = next;
    }
  }

  if (!/<svg[\s>]/i.test(text)) {
    return { text, notes, error: "文件里找不到 <svg> 根元素，不像是 SVG 图片" };
  }
  if (!/xmlns\s*=\s*["']http:\/\/www\.w3\.org\/2000\/svg["']/i.test(text)) {
    text = text.replace(/<svg\b/i, '<svg xmlns="http://www.w3.org/2000/svg"');
    notes.push("已补全缺失的 xmlns");
  }
  return { text, notes };
}

async function contentVersion(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as unknown as BufferSource);
  return Array.from(new Uint8Array(digest))
    .slice(0, 4)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * 校验并规范化一个上传的素材。
 * 顺序：体积 → 内容嗅探（不信任文件名/MIME）→ 尺寸 → SVG 消毒 → 内容哈希。
 */
export async function acceptAsset(
  kind: AssetKind,
  bytes: Uint8Array
): Promise<AcceptedAsset | RejectedAsset> {
  const label = ASSET_LABEL[kind];
  if (bytes.byteLength === 0) return { ok: false, error: `${label}是空文件` };

  const sniffed = sniffImage(bytes);
  const isSvgCandidate =
    !sniffed &&
    // SVG 是纯文本，没有魔数；只在前 4KB 里找 <svg 作为判据，避免拿大二进制当文本处理
    /<svg[\s>]/i.test(ascii(bytes, 0, Math.min(bytes.length, 4096)));

  if (!sniffed && !isSvgCandidate) {
    return {
      ok: false,
      error: `${label}只支持 SVG / PNG / JPG / GIF / WebP / ICO 图片`,
    };
  }

  const ext = sniffed ? sniffed.ext : ".svg";
  const limit = MAX_BYTES[ext] ?? DEFAULT_MAX_BYTES;
  if (bytes.byteLength > limit) {
    return { ok: false, error: `${label}体积超过上限 ${Math.round(limit / 1024)} KB` };
  }

  if (sniffed) {
    const size =
      sniffed.type === "image/png"
        ? readPngSize(bytes)
        : sniffed.type === "image/gif"
        ? readGifSize(bytes)
        : sniffed.type === "image/x-icon"
        ? readIcoSize(bytes)
        : sniffed.type === "image/jpeg"
        ? readJpegSize(bytes)
        : { width: null, height: null };
    return {
      ok: true,
      bytes,
      type: sniffed.type,
      ext,
      width: size.width,
      height: size.height,
      ratio: size.width && size.height ? roundRatio(size.width / size.height) : null,
      notes: [],
      version: await contentVersion(bytes),
    };
  }

  // 到这里一定是 SVG 候选
  const decoder = new TextDecoder("utf-8", { fatal: false });
  const sanitized = sanitizeSvg(decoder.decode(bytes));
  if (sanitized.error) return { ok: false, error: `${label}${sanitized.error}` };

  const encoded = new TextEncoder().encode(sanitized.text);
  if (encoded.byteLength > limit) {
    return { ok: false, error: `${label}体积超过上限 ${Math.round(limit / 1024)} KB` };
  }

  return {
    ok: true,
    bytes: encoded,
    type: "image/svg+xml",
    ext: ".svg",
    // 矢量图没有「像素尺寸」，但宽高比要从 viewBox / width-height 推出来，
    // 否则顶栏在图片加载前预留不出正确宽度，会抖一下。
    width: null,
    height: null,
    ratio: svgAspectRatio(sanitized.text),
    notes: sanitized.notes,
    version: await contentVersion(encoded),
  };
}

/** 写入素材对象，并返回索引条目。 */
export async function persistAsset(
  bucket: R2Bucket,
  kind: AssetKind,
  asset: AcceptedAsset
): Promise<StoredAsset> {
  await removeAssetObjects(bucket, kind);
  const key = assetKey(kind, asset.ext);
  await bucket.put(key, asset.bytes, {
    httpMetadata: {
      contentType: asset.type,
      cacheControl: "public, max-age=31536000, immutable",
    },
    customMetadata: { resourcetype: "branding-asset", version: asset.version },
  });
  return {
    key,
    type: asset.type,
    size: asset.bytes.byteLength,
    version: asset.version,
    width: asset.width,
    height: asset.height,
    ratio: asset.ratio,
  };
}

/** 文本字段校验：控制字符与超长一律拒绝，避免污染 HTML / JSON 输出。 */
export function normalizeText(
  value: string,
  field: keyof typeof TEXT_LIMITS
): { ok: true; value: string } | { ok: false; error: string } {
  const trimmed = value.trim();
  if (!trimmed) return { ok: true, value: "" };
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(trimmed)) {
    return { ok: false, error: `${field} 含有不可见的控制字符，请清理后再试` };
  }
  const length = [...trimmed].length;
  const limit = TEXT_LIMITS[field];
  if (length > limit) {
    return { ok: false, error: `${field} 最长 ${limit} 个字符，当前 ${length} 个` };
  }
  return { ok: true, value: trimmed };
}
