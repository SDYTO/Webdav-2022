/**
 * 动态 PWA 清单。
 *
 * 构建期已经生成过一份 `public/manifest.json`，但管理员在界面里换了图标后，
 * 装到桌面的应用图标不该还是旧的 —— 所以这里在**请求时**用运行期品牌重建清单。
 *
 * 不变量（start_url / display / theme_color / background_color）优先从静态产物里读，
 * 避免同一个值在构建脚本和这里各写一遍而漂移；静态产物读不到时才用内置兜底。
 */

import { readStoredBranding, resolveBranding, type StoredAsset } from "./_branding";
import type { DriveEnv } from "./api/_core";

interface ManifestEnv extends DriveEnv {
  /** Pages 的静态产物绑定；本地预览里也提供同名对象 */
  ASSETS?: { fetch(input: RequestInfo | URL): Promise<Response> };
}

interface ManifestIcon {
  src: string;
  type: string;
  sizes: string;
  purpose: string;
}

const FALLBACK_INVARIANTS = {
  start_url: ".",
  display: "standalone",
  theme_color: "#f38020",
  background_color: "#f4f1ec",
};

/** SVG 是矢量，标 "any"；位图按真实像素标，装到桌面时系统才好挑尺寸。 */
function iconEntry(url: string, type: string, asset: StoredAsset | null): ManifestIcon {
  const sizes = type === "image/svg+xml" || !asset?.width || !asset?.height
    ? "any"
    : `${asset.width}x${asset.height}`;
  return { src: url, type, sizes, purpose: "any" };
}

export const onRequestGet: PagesFunction<ManifestEnv> = async (context) => {
  const stored = await readStoredBranding(context.env.BUCKET);
  const branding = resolveBranding(stored);

  let base: Record<string, unknown> = {};
  try {
    const response = await context.env.ASSETS?.fetch(
      new URL("/manifest.json", context.request.url).toString()
    );
    if (response?.ok) {
      const parsed: unknown = await response.json();
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        base = parsed as Record<string, unknown>;
      }
    }
  } catch {
    // 读不到静态清单不算错误，下面的兜底常量足以产出合法清单
  }

  // 构建期清单里的 icons 带准确尺寸（48x48 / 144x144），如果运行期没换过图标就原样沿用，
  // 不要用一份信息更少的数组把它覆盖掉。只有管理员真的上传了新图标时才重建。
  const runtimeIcon = stored.assets?.icon ?? null;
  const runtimeApple = stored.assets?.appleTouchIcon ?? null;
  let icons: ManifestIcon[] = Array.isArray(base.icons) ? (base.icons as ManifestIcon[]) : [];
  if (runtimeIcon || runtimeApple || icons.length === 0) {
    icons = [iconEntry(branding.iconUrl, branding.iconType, runtimeIcon)];
    if (branding.appleTouchIconUrl !== branding.iconUrl) {
      // 专用主屏图标有自己的类型；回退到 favicon / 构建期默认时沿用 favicon 的类型
      icons.push(
        iconEntry(branding.appleTouchIconUrl, runtimeApple?.type ?? branding.iconType, runtimeApple)
      );
    }
  }

  const manifest = {
    ...FALLBACK_INVARIANTS,
    ...base,
    short_name: branding.shortName,
    name: branding.siteName,
    description: branding.description,
    icons,
  };

  return new Response(JSON.stringify(manifest, null, 2), {
    status: 200,
    headers: {
      "Content-Type": "application/manifest+json; charset=utf-8",
      // 换品牌后不该被浏览器缓存住旧清单
      "Cache-Control": "no-cache",
    },
  });
};
