// 本文件由 tools/build-branding.mjs 依据 branding/config.json 自动生成，请勿手动编辑。
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

export const BRANDING: Branding = {
  "siteName": "Wabdav-2022",
  "shortName": "Wabdav-2022",
  "description": "Wabdav-2022 共享网盘 —— 文件管理与 WebDAV",
  "showNameBesideLogo": true,
  "logoUrl": null,
  "logoAspectRatio": null,
  "iconUrl": "/favicon.png",
  "iconType": "image/png",
  "appleTouchIconUrl": "/logo144.png"
};

export default BRANDING;
