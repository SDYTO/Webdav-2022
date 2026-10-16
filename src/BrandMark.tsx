import { Box, Typography } from "@mui/material";
import type { SxProps, Theme } from "@mui/material/styles";

import { useBranding } from "./app/branding";

const WORDMARK_SX: SxProps<Theme> = {
  fontWeight: 700,
  whiteSpace: "nowrap",
  color: "primary.main",
  letterSpacing: "-0.03em",
  lineHeight: 1.2,
};

/**
 * 站点品牌标识。
 *
 * 配置了自定义 Logo 就显示 Logo（是否在其旁重复站点名，由品牌配置的
 * showNameBesideLogo 决定）；没配置则退化成纯文字站名，与改造前表现一致。
 * 顶栏与登录弹窗共用同一个组件，避免两处的品牌呈现各自演化。
 *
 * 品牌数据来自 app/branding 的运行时 store：构建期默认值 + 管理员在「品牌设置」
 * 里保存的覆盖值。管理员保存后本组件会自动重渲染，不需要刷新页面。
 * 外围间距请调用方用 Box 包裹处理，这里不接 sx，以免样式合并逻辑污染组件本身。
 */
function BrandMark({
  size = 26,
  orientation = "row",
  variant = "h6",
}: {
  /** Logo 显示高度（px）。未配置 Logo 时该值不生效 */
  size?: number;
  /** row：Logo 与站名横向并排（顶栏）；column：Logo 在上、站名在下（登录弹窗） */
  orientation?: "row" | "column";
  variant?: "h6" | "subtitle1" | "body1";
}) {
  const { siteName, logoUrl, logoAspectRatio, showNameBesideLogo } = useBranding();
  // 没有 Logo 时必须显示文字；有 Logo 时再由配置决定要不要重复站名
  const showWordmark = !logoUrl || showNameBesideLogo;
  const column = orientation === "column";

  const wordmark = showWordmark ? (
    <Typography variant={variant} component="span" sx={WORDMARK_SX}>
      {siteName}
    </Typography>
  ) : null;

  if (!logoUrl) return wordmark;

  return (
    <Box
      sx={{
        display: "inline-flex",
        minWidth: 0,
        alignItems: "center",
        justifyContent: column ? "center" : "flex-start",
        flexDirection: column ? "column" : "row",
        gap: 0.75,
      }}
    >
      <Box
        component="img"
        src={logoUrl}
        // 站名与 Logo 并存时 Logo 只是装饰；单独用 Logo 时它必须承载站点名称
        alt={showWordmark ? "" : siteName}
        width={logoAspectRatio ? Math.round(size * logoAspectRatio) : undefined}
        height={size}
        sx={{
          display: "block",
          flexShrink: 0,
          height: size,
          width: logoAspectRatio ? "auto" : undefined,
          maxWidth: size * 6,
          objectFit: "contain",
        }}
      />
      {wordmark}
    </Box>
  );
}

export default BrandMark;
