/**
 * 前端运行时品牌状态。
 *
 * 品牌有两个来源，优先级从低到高：
 *   1. `branding/branding.generated.ts` —— 构建期常量（改它要重新部署）
 *   2. `/api/branding` —— 管理员在「品牌设置」里存进 R2 的覆盖值
 *
 * 应用启动时拉一次第 2 层；拉到就把它写进 document（标题 / favicon / iOS 图标 / 描述）
 * 并替换掉构建期默认，页面上的品牌标识由 BrandMark 订阅本模块的 store 渲染。
 * 因此管理员保存后无需重新部署，刷新即见。
 *
 * 注意：`RuntimeBranding` 直接复用 Pages Functions 里那份类型定义（type-only 导入，
 * 编译期擦除，前端产物不会因此把服务端代码打进去），避免两处各写一份而漂移。
 */

import React from "react";

import { BRANDING } from "../../branding/branding.generated";
import type { RuntimeBranding } from "../../functions/_branding";
import { authFetch } from "./auth";

/**
 * 可自定义的素材种类。与 functions/_branding 的 ASSET_KINDS 对应，
 * 但这里**故意重复一份**：前端不引入服务端模块（除了那个 type-only 的接口），
 * 否则 R2 相关的代码会被打进浏览器产物。
 */
export const ASSET_KINDS = ["logo", "icon", "appleTouchIcon"] as const;
export type AssetKind = (typeof ASSET_KINDS)[number];

/** 素材在品牌数据里对应的字段，供界面取当前预览地址。 */
export const ASSET_URL_FIELD: Record<AssetKind, keyof RuntimeBranding> = {
  logo: "logoUrl",
  icon: "iconUrl",
  appleTouchIcon: "appleTouchIconUrl",
};

const DEFAULTS: RuntimeBranding = {  siteName: BRANDING.siteName,
  shortName: BRANDING.shortName,
  description: BRANDING.description,
  showNameBesideLogo: BRANDING.showNameBesideLogo,
  logoUrl: BRANDING.logoUrl,
  logoAspectRatio: BRANDING.logoAspectRatio,
  iconUrl: BRANDING.iconUrl,
  iconType: BRANDING.iconType,
  appleTouchIconUrl: BRANDING.appleTouchIconUrl,
  customized: false,
  updatedAt: null,
};

let current: RuntimeBranding = DEFAULTS;
const listeners = new Set<() => void>();

export function getBranding(): RuntimeBranding {
  return current;
}

/** 订阅品牌变化（BrandMark 与设置弹窗用） */
export function subscribeBranding(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function publish(next: RuntimeBranding) {
  current = next;
  applyToDocument(next);
  for (const listener of listeners) listener();
}

/** 把品牌写进 document：标签页标题、favicon、iOS 主屏图标、页面描述。 */
function applyToDocument(branding: RuntimeBranding) {
  if (typeof document === "undefined") return;
  document.title = branding.siteName;
  setLink("icon", branding.iconUrl, branding.iconType);
  setLink("apple-touch-icon", branding.appleTouchIconUrl);
  setMeta("description", branding.description);
}

function setLink(rel: string, href: string, type?: string) {
  let link = document.head.querySelector<HTMLLinkElement>(`link[rel="${rel}"]`);
  if (!link) {
    link = document.createElement("link");
    link.rel = rel;
    document.head.appendChild(link);
  }
  if (link.getAttribute("href") !== href) link.setAttribute("href", href);
  // 图标在 SVG / PNG 之间切换时 type 必须跟着换，否则部分浏览器会忽略它
  if (type) link.setAttribute("type", type);
  else link.removeAttribute("type");
}

function setMeta(name: string, content: string) {
  let meta = document.head.querySelector<HTMLMetaElement>(`meta[name="${name}"]`);
  if (!meta) {
    meta = document.createElement("meta");
    meta.name = name;
    document.head.appendChild(meta);
  }
  meta.content = content;
}

/**
 * 只接受形状正确的字段：服务端已经校验过，这里再挡一次是为了防止
 * 代理/缓存返回半截 JSON 时把界面刷成空白。
 */
function normalize(raw: unknown): RuntimeBranding {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return DEFAULTS;
  const source = raw as Record<string, unknown>;
  const text = (key: string, fallback: string) =>
    typeof source[key] === "string" && (source[key] as string).trim()
      ? (source[key] as string).trim()
      : fallback;
  const optionalUrl = (key: string, fallback: string | null) =>
    typeof source[key] === "string" ? (source[key] as string) : fallback;

  return {
    siteName: text("siteName", DEFAULTS.siteName),
    shortName: text("shortName", DEFAULTS.shortName),
    description: text("description", DEFAULTS.description),
    showNameBesideLogo:
      typeof source.showNameBesideLogo === "boolean"
        ? source.showNameBesideLogo
        : DEFAULTS.showNameBesideLogo,
    logoUrl: optionalUrl("logoUrl", DEFAULTS.logoUrl),
    logoAspectRatio:
      typeof source.logoAspectRatio === "number" ? source.logoAspectRatio : null,
    iconUrl: text("iconUrl", DEFAULTS.iconUrl),
    iconType: text("iconType", DEFAULTS.iconType),
    appleTouchIconUrl: text("appleTouchIconUrl", DEFAULTS.appleTouchIconUrl),
    customized: source.customized === true,
    updatedAt: typeof source.updatedAt === "string" ? source.updatedAt : null,
  };
}

async function readJson(response: Response): Promise<Record<string, unknown> | null> {
  try {
    return (await response.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function errorMessage(response: Response, data: Record<string, unknown> | null): string {
  if (data && typeof data.error === "string" && data.error) return data.error;
  if (response.status === 401) return "需要管理口令";
  if (response.status === 503) return "写操作口令未配置，无法保存";
  return `保存失败（HTTP ${response.status}）`;
}

/** 启动时拉取一次运行期品牌。失败就保持构建期默认，不打扰用户。 */
export async function loadBranding(): Promise<RuntimeBranding | null> {
  try {
    const response = await fetch("/api/branding", { headers: { Accept: "application/json" } });
    if (!response.ok) return null;
    const branding = normalize(await response.json());
    publish(branding);
    return branding;
  } catch {
    return null;
  }
}

export interface BrandingSaveResult {
  branding: RuntimeBranding;
  /** 服务端的处理提示，例如「已移除 <script> 元素」 */
  notes: string[];
}

function notesOf(data: Record<string, unknown> | null): string[] {
  if (!data || !Array.isArray(data.notes)) return [];
  return data.notes.filter((note): note is string => typeof note === "string");
}

/** 保存品牌（**需管理口令**；authFetch 会自动带上，未登录则弹出登录框）。 */
export async function saveBranding(form: FormData): Promise<BrandingSaveResult> {
  const response = await authFetch("/api/branding", { method: "POST", body: form });
  const data = await readJson(response);
  if (!response.ok) throw new Error(errorMessage(response, data));

  const branding = normalize(data);
  publish(branding);
  return { branding, notes: notesOf(data) };
}

/** 清空运行期品牌，恢复构建期默认（**需管理口令**）。 */
export async function resetBranding(): Promise<BrandingSaveResult> {
  const response = await authFetch("/api/branding", { method: "DELETE" });
  const data = await readJson(response);
  if (!response.ok) throw new Error(errorMessage(response, data));

  const branding = normalize(data);
  publish(branding);
  return { branding, notes: notesOf(data) };
}

export function useBranding(): RuntimeBranding {
  const [branding, setBranding] = React.useState(current);
  React.useEffect(
    () =>
      subscribeBranding(() => {
        setBranding(current);
      }),
    []
  );
  return branding;
}
