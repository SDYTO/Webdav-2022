import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

import { BRANDING } from "./branding/branding.generated";

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * 把 branding/config.json 里的品牌信息注入 index.html。
 *
 * index.html 本身保持一份中性的模板（title / favicon / description 都是占位值），
 * 真实品牌在开发与构建时替换进来 —— 这样换品牌只需要动 branding/ 目录，
 * 不必去编辑 HTML，也不会把「构建产物」和「源文件」搅在一起。
 *
 * 替换以固定标签为锚点，重复执行结果一致（幂等）。
 */
function brandingHtmlPlugin() {
  const swap = (
    html: string,
    pattern: RegExp,
    replacement: string,
    label: string
  ): string => {
    if (!pattern.test(html)) {
      console.warn(`[branding] index.html 中未找到 ${label}，已跳过注入。`);
      return html;
    }
    return html.replace(pattern, replacement);
  };

  return {
    name: "sd-ytodb-branding-html",
    transformIndexHtml(html: string) {
      let output = html;
      output = swap(
        output,
        /<title>[\s\S]*?<\/title>/,
        `<title>${escapeHtml(BRANDING.siteName)}</title>`,
        "<title>"
      );
      output = swap(
        output,
        /<link rel="icon"[^>]*>/,
        `<link rel="icon" href="${escapeHtml(BRANDING.iconUrl)}" />`,
        "favicon <link>"
      );
      output = swap(
        output,
        /<link rel="apple-touch-icon"[^>]*>/,
        `<link rel="apple-touch-icon" href="${escapeHtml(BRANDING.appleTouchIconUrl)}" />`,
        "apple-touch-icon <link>"
      );
      output = swap(
        output,
        /<meta name="description"[^>]*>/,
        `<meta name="description" content="${escapeHtml(BRANDING.description)}" />`,
        "description <meta>"
      );
      return output;
    },
  };
}

// Cloudflare Pages 部署约定：产物目录必须是 build/（见 wrangler.toml 的
// pages_build_output_dir），因此构建 outDir 保持为 "build"。
export default defineConfig({
  plugins: [react(), brandingHtmlPlugin()],
  build: {
    outDir: "build",
  },
});
