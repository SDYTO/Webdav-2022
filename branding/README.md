# 自定义品牌（Logo / 图标 / 站点名）

把 Wabdav-2022 换成你自己的样子。有两种方式，按需选：

## 方式一：界面里改（推荐，无需重新部署）

登录管理员后，点右上角**账户图标 → 品牌设置**：

- 直接改站点名 / 短名 / 描述
- 上传 Logo、站点图标（favicon）、主屏图标，带预览，可单独清除
- 保存后**立即全站生效**：顶栏、浏览器标题与图标、登录弹窗、PWA 清单、
  WebDAV 浏览页（服务端渲染）都会跟着变
- 「恢复默认」一键回到构建期配置

素材存放在服务端 R2 的内部前缀下（`_$flaredrive$/branding/`），通过
`/api/branding` 这一个受控出口读写：

| 方法 | 说明 |
| --- | --- |
| `GET /api/branding` | 读当前品牌（免密） |
| `GET /api/branding?asset=logo\|icon\|appleTouchIcon` | 读素材本体（免密，内容寻址长缓存） |
| `POST /api/branding` | 修改 / 上传（**需管理口令**） |
| `DELETE /api/branding` | 恢复构建期默认（**需管理口令**） |

安全约束：素材按**内容**嗅探格式（不信任文件名与 MIME），单张 ≤ 1 MB（SVG ≤ 256 KB）；
SVG 上传时自动消毒（剥 `<script>`、`on*` 事件、`foreignObject`、`javascript:` 链接），
下发时再叠加 `Content-Security-Policy: sandbox`，直接打开也不会执行脚本。

## 方式二：改配置文件（构建期默认值）

如果你想让**没配置过品牌的新部署**就带某套默认 Logo / 站名，用这种方式：

## 目录里有什么

```
branding/
├── config.json              ← 改站点名、指定用哪张图
├── logo.svg / logo.png      ← 你的 Logo（自己放进来，文件名随意）
├── icon.svg / icon.png      ← 你的站点图标（自己放进来）
├── apple-touch-icon.png     ← 可选：iOS「添加到主屏幕」用的图标
├── branding.generated.ts    ← 构建脚本生成，别手改
└── README.md
```

## 三步换掉

1. 把图片拷进这个目录
2. 在 `config.json` 里写上文件名
3. 重新构建并部署

```bash
npm run build     # prebuild 钩子会先跑品牌脚本
npm run preview   # 本地看一眼效果
```

> 两种方式的关系：`config.json` 是**默认值**，界面上保存的是**覆盖值**；
> 覆盖值存在服务器上，删掉覆盖值（界面里点「恢复默认」）就会回到这里的配置。

## config.json 字段说明

| 字段 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `siteName` | string | `"Wabdav-2022"` | 站点名。顶栏、浏览器标题、PWA 名称、WebDAV 浏览页标题都用它。最长 60 字符 |
| `shortName` | string | 同 `siteName` | PWA 主屏短名，建议 ≤ 12 字符，太长会被系统截断。最长 24 字符 |
| `description` | string | Wabdav-2022 默认描述 | 页面 `description` 与 PWA 描述。最长 200 字符 |
| `showNameBesideLogo` | boolean | `true` | Logo 旁边是否再显示一遍站点名。**Logo 本身已经写了字就设成 `false`**，否则会重复两遍 |
| `logo` | string \| null | `null` | Logo 文件名。填 `null` 表示不用图片，顶栏直接显示纯文字站名 |
| `icon` | string \| null | `null` | 站点图标（favicon）文件名。`null` 时用内置的 `/favicon.png` |
| `appleTouchIcon` | string \| null | `null` | iOS 主屏图标。不填时自动回退用 `icon`，再回退到内置的 `/logo144.png` |

字段可以整个删掉，缺省即用默认值。

**例一：Logo 是图标，旁边还要显示站名**

```json
{
  "siteName": "我的网盘",
  "shortName": "网盘",
  "description": "我的资料分享站",
  "showNameBesideLogo": true,
  "logo": "logo.svg",
  "icon": "icon.png",
  "appleTouchIcon": "apple-touch-icon.png"
}
```

**例二：Logo 是一整条字标，不需要再重复站名**

```json
{
  "siteName": "ACME Drive",
  "logo": "wordmark.svg",
  "showNameBesideLogo": false
}
```

## 图片规格

只支持 **SVG** 和 **PNG**。JPG / WebP 没有透明背景，做站点标识会出现难看的白底方块，所以直接拒绝。

| 用途 | 格式 | 建议 | 体积上限 |
| --- | --- | --- | --- |
| `logo` | SVG（首选，矢量缩放不糊） | 任意尺寸，脚本会读 `viewBox` 算宽高比 | 256 KB |
| `logo` | PNG | 高度 ≥ 64px，宽高比随意，**需要透明背景** | 1 MB |
| `icon` | SVG 或 PNG | 正方形；PNG 建议 512×512 | 1 MB |
| `appleTouchIcon` | PNG（iOS 不认 SVG） | 180×180，**不要透明**（iOS 会填成黑底） | 1 MB |

关于 favicon 尺寸：PWA 清单只会登记你实际给出的那一档尺寸。想让「添加到主屏幕」在各种设备上都清晰，
直接丢一张 **512×512** 的 PNG 最省事。

## 改完会影响哪些地方

- 浏览器标签页的标题与图标
- 顶栏左上角的品牌标识
- 管理口令弹窗里的标识
- PWA 的安装名称与图标
- WebDAV 浏览页的标题与品牌标

界面主色调（橙色 `#f38020`）和浏览器主题色**不随这里变化**，想改要动 `src/app/theme.ts`。

## 常见问题

**改了图，浏览器里还是旧的？**

素材 URL 会带内容哈希（`/branding/logo.svg?v=a1b2c3d4`），内容一变 URL 就变，正常不会读到缓存。
如果仍是旧的，多半是忘了重新构建 —— 记得跑一次 `npm run build`。

**SVG 里可以写脚本吗？**

构建脚本会剥掉 `<script>`、`on*` 事件属性、`<foreignObject>`、`javascript:` 链接，以及 DOCTYPE / ENTITY 声明，
每一步都会在输出里报出来。同时 `/branding/*` 的响应头带 CSP `sandbox`，即便混进脚本也在独立源里跑，读不到本站的
localStorage（写操作口令存在那里）。

**SVG 里引用的外部图片加载不出来？**

是故意的：CSP 为 `default-src 'none'`，SVG 不允许引用外部资源。请把图片内联成 base64 或直接画成路径。

**提示「已补全缺失的 xmlns」？**

有些绘图工具导出的 SVG 不带 `xmlns`，而缺了它的 SVG 放在 `<img>` 里根本不会渲染。脚本会自动补上，不用管。

**为什么 `public/manifest.json` 不在 git 里，`branding.generated.ts` 却在？**

两者都是脚本产物。`branding.generated.ts` 要参与 TypeScript 类型检查，必须存在于仓库；
`public/manifest.json` 和 `public/branding/` 是纯静态产物，已写进 `.gitignore`。

**改坏了怎么回退？**

把 `config.json` 里对应字段改回 `null`（或直接删掉字段）即可 —— 会恢复成内置图标与「Wabdav-2022」站名。
