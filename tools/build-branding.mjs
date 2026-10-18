#!/usr/bin/env node
/**
 * sd-ytodb 品牌构建脚本。
 *
 * 读取 `branding/config.json` 与 `branding/` 目录下的素材文件，产出三样东西：
 *
 *   1. `branding/branding.generated.ts`
 *      前端（src/）与 Pages Functions（functions/）共用的品牌数据，
 *      编译期常量，运行时零开销。
 *   2. `public/branding/*`
 *      素材副本，随静态产物一起发布；URL 带内容哈希查询串
 *      （`?v=xxxxxxxx`），换了图就换 URL，浏览器缓存自动失效。
 *   3. `public/manifest.json`
 *      PWA 清单，名称与图标随配置走。
 *
 * 由 package.json 的 predev / prebuild 钩子自动触发，也可手动 `npm run branding`。
 * 脚本是幂等的：同样的输入重复运行，产出字节完全一致。
 *
 * 安全说明：SVG 素材会被消毒（剥掉 <script>、on* 事件、foreignObject、
 * javascript: 链接、DOCTYPE/ENTITY），并配合 public/_headers 里 `/branding/*`
 * 的 CSP `sandbox` 双重兜底 —— 因为静态资源不经过 Functions 中间件，
 * 不能指望 _middleware.ts 的 CSP 覆盖到这里。
 */

import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, "..");
const brandingDir = path.join(projectRoot, "branding");
const configPath = path.join(brandingDir, "config.json");
const generatedPath = path.join(brandingDir, "branding.generated.ts");
const publicDir = path.join(projectRoot, "public");
const publicBrandingDir = path.join(publicDir, "branding");
const manifestPath = path.join(publicDir, "manifest.json");

/** config.json 缺省值，同时也是「合法字段白名单」。 */
const DEFAULTS = {
  siteName: "sd-ytodb",
  shortName: "sd-ytodb",
  description: "sd-ytodb 共享网盘 —— 文件管理与 WebDAV",
  showNameBesideLogo: true,
  logo: null,
  icon: null,
  appleTouchIcon: null,
};

/** 未配置自定义素材时，沿用仓库里既有的两张图标，行为与改造前一致。 */
const FALLBACK = {
  iconUrl: "/favicon.png",
  iconType: "image/png",
  iconSizes: "48x48",
  appleTouchIconUrl: "/logo144.png",
  appleTouchIconType: "image/png",
};

/** 主题色保持与 MUI 主题、WebDAV 页 --brand 一致，不随品牌配置变化。 */
const THEME_COLOR = "#f38020";
const BACKGROUND_COLOR = "#f4f1ec";

const ALLOWED_EXTENSIONS = new Set([".svg", ".png"]);
const MAX_BYTES = { ".svg": 256 * 1024, ".png": 1024 * 1024 };
const MIME_BY_EXT = { ".svg": "image/svg+xml", ".png": "image/png" };

const warnings = [];

function warn(message) {
  warnings.push(message);
}

class ConfigError extends Error {}

function fail(message) {
  throw new ConfigError(message);
}

function formatKb(bytes) {
  return `${(bytes / 1024).toFixed(0)} KB`;
}

function roundRatio(value) {
  return Math.round(value * 10000) / 10000;
}

// ————————————————————————————————————————————————————————————
// 配置读取与校验
// ————————————————————————————————————————————————————————————

function readConfigFile() {
  if (!fs.existsSync(configPath)) {
    warn("未找到 branding/config.json，本次沿用内置默认品牌。");
    return { ...DEFAULTS };
  }

  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(configPath, "utf8"));
  } catch (error) {
    fail(`branding/config.json 不是合法 JSON —— ${error.message}`);
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    fail("branding/config.json 顶层必须是一个 JSON 对象。");
  }
  return normalizeConfig(raw);
}

function normalizeConfig(raw) {
  for (const key of Object.keys(raw)) {
    if (!(key in DEFAULTS)) {
      warn(`忽略未知字段 "${key}"（可用字段：${Object.keys(DEFAULTS).join(" / ")}）。`);
    }
  }

  const siteName = readText(raw.siteName, "siteName", 60, DEFAULTS.siteName);
  const shortName = readText(raw.shortName, "shortName", 24, [...siteName].slice(0, 24).join(""));
  const description = readText(raw.description, "description", 200, DEFAULTS.description);

  let showNameBesideLogo = DEFAULTS.showNameBesideLogo;
  if (raw.showNameBesideLogo !== undefined && raw.showNameBesideLogo !== null) {
    if (typeof raw.showNameBesideLogo !== "boolean") {
      fail("字段 showNameBesideLogo 必须是 true 或 false。");
    }
    showNameBesideLogo = raw.showNameBesideLogo;
  }

  return {
    siteName,
    shortName,
    description,
    showNameBesideLogo,
    logo: readAssetName(raw.logo, "logo"),
    icon: readAssetName(raw.icon, "icon"),
    appleTouchIcon: readAssetName(raw.appleTouchIcon, "appleTouchIcon"),
  };
}

function readText(value, field, maxLength, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value !== "string") fail(`字段 ${field} 必须是字符串。`);
  const trimmed = value.trim();
  if (!trimmed) return fallback;
  // 换行/制表等控制字符会污染 HTML 与 JSON 输出
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(trimmed)) {
    fail(`字段 ${field} 含有不可见的控制字符，请清理后再试。`);
  }
  const length = [...trimmed].length;
  if (length > maxLength) {
    fail(`字段 ${field} 最长 ${maxLength} 个字符，当前 ${length} 个。`);
  }
  return trimmed;
}

function readAssetName(value, field) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") fail(`字段 ${field} 必须是文件名（字符串）或 null。`);
  const name = value.trim();
  if (!name) return null;

  // 只允许 branding/ 下的裸文件名，杜绝 ../../ 之类穿越到仓库其它位置
  if (name.includes("/") || name.includes("\\") || name.includes("..") || path.basename(name) !== name) {
    fail(`字段 ${field} 只能填 branding/ 目录下的文件名，不能带任何路径：${JSON.stringify(value)}`);
  }

  const ext = path.extname(name).toLowerCase();
  if (!ALLOWED_EXTENSIONS.has(ext)) {
    fail(
      `字段 ${field} 只支持 .svg 与 .png（收到 ${name}）。` +
        "JPG / WebP 没有透明背景，不适合做站点标识，请先转换成 PNG。"
    );
  }

  const filePath = path.join(brandingDir, name);
  if (!fs.existsSync(filePath)) fail(`字段 ${field} 指向的文件不存在：branding/${name}`);
  const stats = fs.statSync(filePath);
  if (!stats.isFile()) fail(`branding/${name} 不是一个文件。`);
  if (stats.size === 0) fail(`branding/${name} 是空文件。`);

  const limit = MAX_BYTES[ext];
  if (stats.size > limit) {
    fail(`branding/${name} 体积 ${formatKb(stats.size)}，超过上限 ${formatKb(limit)}。`);
  }

  return { name, ext, filePath, byteLength: stats.size };
}

// ————————————————————————————————————————————————————————————
// 素材解析：尺寸探测 + SVG 消毒
// ————————————————————————————————————————————————————————————

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function readPngSize(buffer, name) {
  if (buffer.length < 24 || !buffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
    fail(`branding/${name} 扩展名是 .png，但内容不是合法 PNG（是否改错了扩展名？）。`);
  }
  if (buffer.toString("latin1", 12, 16) !== "IHDR") {
    fail(`branding/${name} 的 PNG 头部异常，缺少 IHDR 数据块。`);
  }
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  if (!width || !height) fail(`branding/${name} 的 PNG 尺寸读到 0，文件可能已损坏。`);
  return { width, height };
}

const SVG_SCRUBBERS = [
  { pattern: /<script\b[\s\S]*?<\/script\s*>/gi, label: "<script> 元素" },
  { pattern: /<script\b[^>]*\/?>/gi, label: "<script> 元素" },
  { pattern: /<foreignObject\b[\s\S]*?<\/foreignObject\s*>/gi, label: "<foreignObject> 元素" },
  { pattern: /<foreignObject\b[^>]*\/?>/gi, label: "<foreignObject> 元素" },
  { pattern: /<iframe\b[\s\S]*?<\/iframe\s*>/gi, label: "<iframe> 元素" },
  { pattern: /\son[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, label: "内联事件属性（on*）" },
  {
    pattern: /\b(?:xlink:href|href)\s*=\s*(?:"[^"]*javascript:[^"]*"|'[^']*javascript:[^']*'|javascript:[^\s>]+)/gi,
    label: "javascript: 链接",
  },
  { pattern: /<!DOCTYPE[^>]*>/gi, label: "DOCTYPE 声明" },
  { pattern: /<!ENTITY[^>]*>/gi, label: "ENTITY 声明" },
];

function sanitizeSvg(source, name) {
  let text = source.replace(/^\uFEFF/, "");
  const notes = [];

  for (const { pattern, label } of SVG_SCRUBBERS) {
    const next = text.replace(pattern, "");
    if (next !== text) {
      if (!notes.includes(`已移除${label}`)) notes.push(`已移除${label}`);
      text = next;
    }
  }

  if (!/<svg[\s>]/i.test(text)) {
    fail(`branding/${name} 里找不到 <svg> 根元素，不像是 SVG 文件。`);
  }
  if (!/xmlns\s*=\s*["']http:\/\/www\.w3\.org\/2000\/svg["']/i.test(text)) {
    // 没有 xmlns 的 SVG 在 <img> 里不会被渲染，直接补全会比报错友好
    text = text.replace(/<svg\b/i, '<svg xmlns="http://www.w3.org/2000/svg"');
    notes.push("已补全缺失的 xmlns");
  }

  return { text, notes };
}

function svgAspectRatio(text) {
  const viewBox = /viewBox\s*=\s*["']\s*(-?[\d.]+)[\s,]+(-?[\d.]+)[\s,]+(-?[\d.]+)[\s,]+(-?[\d.]+)\s*["']/i.exec(text);
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

function loadAsset(asset) {
  const buffer = fs.readFileSync(asset.filePath);

  if (asset.ext === ".png") {
    const { width, height } = readPngSize(buffer, asset.name);
    return {
      ...asset,
      bytes: buffer,
      mime: MIME_BY_EXT[".png"],
      sizes: `${width}x${height}`,
      ratio: roundRatio(width / height),
      notes: [],
    };
  }

  const sanitized = sanitizeSvg(buffer.toString("utf8"), asset.name);
  return {
    ...asset,
    bytes: Buffer.from(sanitized.text, "utf8"),
    mime: MIME_BY_EXT[".svg"],
    sizes: "any",
    ratio: svgAspectRatio(sanitized.text),
    notes: sanitized.notes,
  };
}

// ————————————————————————————————————————————————————————————
// 产出：静态素材 / branding.generated.ts / manifest.json
// ————————————————————————————————————————————————————————————

async function resetPublicBrandingDir() {
  await fsp.rm(publicBrandingDir, { recursive: true, force: true });
  await fsp.mkdir(publicBrandingDir, { recursive: true });
}

/** 写入 public/branding/<target>.<ext>，返回带内容哈希的公开 URL。 */
async function publishAsset(asset, targetName) {
  const hash = crypto.createHash("sha256").update(asset.bytes).digest("hex").slice(0, 8);
  const fileName = `${targetName}${asset.ext}`;
  await fsp.writeFile(path.join(publicBrandingDir, fileName), asset.bytes);
  return { url: `/branding/${fileName}?v=${hash}`, mime: asset.mime, sizes: asset.sizes };
}

function renderGeneratedTs(branding) {
  const payload = {
    siteName: branding.siteName,
    shortName: branding.shortName,
    description: branding.description,
    showNameBesideLogo: branding.showNameBesideLogo,
    logoUrl: branding.logoUrl,
    logoAspectRatio: branding.logoAspectRatio,
    iconUrl: branding.iconUrl,
    iconType: branding.iconType,
    appleTouchIconUrl: branding.appleTouchIconUrl,
  };

  return `// 本文件由 tools/build-branding.mjs 依据 branding/config.json 自动生成，请勿手动编辑。
// 修改品牌请编辑 branding/config.json 与 branding/ 下的素材文件，再重新构建。
// 用法说明见 branding/README.md。

export interface Branding {
  /** 站点名称：顶栏、浏览器标题、PWA 名称、WebDAV 浏览页标题都用它 */
  siteName: string;
  /** PWA 主屏短名称（过长会被系统截断） */
  shortName: string;
  /** 页面 description 与 PWA description */
  description: string;
  /** 自定义 Logo 右侧是否重复展示站点名；Logo 本身已含文字时设为 false */
  showNameBesideLogo: boolean;
  /** 自定义 Logo 的地址（带内容版本参数）；为 null 表示未配置，界面回退成纯文字站名 */
  logoUrl: string | null;
  /** Logo 的宽高比（宽 / 高），用于在图片加载前预留空间、避免布局抖动；未配置为 null */
  logoAspectRatio: number | null;
  /** favicon 地址 */
  iconUrl: string;
  /** favicon 的 MIME 类型 */
  iconType: string;
  /** iOS「添加到主屏幕」使用的图标地址 */
  appleTouchIconUrl: string;
}

export const BRANDING: Branding = ${JSON.stringify(payload, null, 2)};

export default BRANDING;
`;
}

function buildManifestIcons(branding) {
  const icons = [
    branding.iconType === "image/svg+xml"
      ? { src: branding.iconUrl, type: branding.iconType, sizes: "any", purpose: "any" }
      : { src: branding.iconUrl, type: branding.iconType, sizes: branding.iconSizes, purpose: "any" },
  ];

  // iOS 主屏图标与 favicon 不是同一张时也登记一份，部分启动器会用
  if (branding.appleTouchIconUrl !== branding.iconUrl) {
    const isSvg = branding.appleTouchIconType === "image/svg+xml";
    icons.push({
      src: branding.appleTouchIconUrl,
      type: branding.appleTouchIconType,
      sizes: isSvg ? "any" : branding.appleTouchIconSizes,
      purpose: "any",
    });
  }

  return icons;
}

function renderManifest(branding) {
  return `${JSON.stringify(
    {
      short_name: branding.shortName,
      name: branding.siteName,
      description: branding.description,
      icons: buildManifestIcons(branding),
      start_url: ".",
      display: "standalone",
      theme_color: THEME_COLOR,
      background_color: BACKGROUND_COLOR,
    },
    null,
    2
  )}\n`;
}

// ————————————————————————————————————————————————————————————
// 主流程
// ————————————————————————————————————————————————————————————

/** PNG 才展示像素尺寸；SVG 是矢量，标 "any" 没有意义。 */
function sizeSuffix(asset) {
  return asset && asset.ext === ".png" ? ` [${asset.sizes}]` : "";
}

async function main() {
  const config = readConfigFile();

  const logo = config.logo ? loadAsset(config.logo) : null;
  const icon = config.icon ? loadAsset(config.icon) : null;
  const appleTouch = config.appleTouchIcon ? loadAsset(config.appleTouchIcon) : null;

  await resetPublicBrandingDir();

  const publishedLogo = logo ? await publishAsset(logo, "logo") : null;
  const publishedIcon = icon ? await publishAsset(icon, "icon") : null;
  const publishedApple = appleTouch ? await publishAsset(appleTouch, "apple-touch-icon") : null;

  // iOS 主屏图标的三级回退：专用图 → favicon → 仓库既有 logo144.png
  let appleTouchIconUrl = FALLBACK.appleTouchIconUrl;
  let appleTouchIconType = FALLBACK.appleTouchIconType;
  let appleTouchIconSizes = "144x144";
  if (publishedApple) {
    appleTouchIconUrl = publishedApple.url;
    appleTouchIconType = publishedApple.mime;
    appleTouchIconSizes = publishedApple.sizes;
  } else if (publishedIcon) {
    appleTouchIconUrl = publishedIcon.url;
    appleTouchIconType = publishedIcon.mime;
    appleTouchIconSizes = publishedIcon.sizes;
  }

  const branding = {
    siteName: config.siteName,
    shortName: config.shortName,
    description: config.description,
    showNameBesideLogo: config.showNameBesideLogo,
    logoUrl: publishedLogo ? publishedLogo.url : null,
    logoAspectRatio: logo ? logo.ratio : null,
    iconUrl: publishedIcon ? publishedIcon.url : FALLBACK.iconUrl,
    iconType: publishedIcon ? publishedIcon.mime : FALLBACK.iconType,
    iconSizes: publishedIcon ? publishedIcon.sizes : FALLBACK.iconSizes,
    appleTouchIconUrl,
    appleTouchIconType,
    appleTouchIconSizes,
  };

  await fsp.writeFile(generatedPath, renderGeneratedTs(branding), "utf8");
  await fsp.mkdir(publicDir, { recursive: true });
  await fsp.writeFile(manifestPath, renderManifest(branding), "utf8");

  for (const message of warnings) console.warn(`[branding] 提醒：${message}`);

  console.log(`[branding] 站点名：${branding.siteName}（短名 ${branding.shortName}）`);
  console.log(
    `[branding] Logo：${branding.logoUrl ?? "未配置，顶栏回退为纯文字站名"}${sizeSuffix(logo)}`
  );
  console.log(`[branding] 图标：${branding.iconUrl}${icon ? sizeSuffix(icon) : "（内置）"}`);
  console.log(
    `[branding] 主屏图标：${branding.appleTouchIconUrl}${
      appleTouch || icon ? sizeSuffix(appleTouch ?? icon) : "（内置）"
    }`
  );
  for (const [label, asset] of [
    ["Logo", logo],
    ["图标", icon],
    ["主屏图标", appleTouch],
  ]) {
    if (asset?.notes.length) console.log(`[branding] ${label} 处理：${asset.notes.join("；")}`);
  }
  console.log("[branding] 已更新 branding/branding.generated.ts 与 public/manifest.json");
}

main().catch((error) => {
  if (error instanceof ConfigError) {
    console.error(`\n[branding] 配置有误：${error.message}\n`);
    console.error("[branding] 请修改 branding/config.json 后重试；字段说明见 branding/README.md\n");
    process.exit(1);
  }
  console.error(error);
  process.exit(1);
});
