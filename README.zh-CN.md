# Wabdav-2022

[English](README.md) | [中文](README.zh-CN.md)

一个裁剪过的自建网盘：跑在 **Cloudflare Pages** 上（后端就是 Pages Functions，存储是 **Cloudflare R2**），并自带 **WebDAV** 入口。

它是 [Davflare](https://github.com/lanshatop/Davflare) 的精简分支，只保留两件事和一套访问模型：

- **文件管理** —— 浏览、上传、新建文件夹、重命名、移动、删除、搜索、预览、回收站。
- **WebDAV** —— 把同一个桶挂成网络驱动器 / 同步目标（Obsidian、rclone、Windows 资源管理器等）。
- **读免密，写要口令。** 任何人拿到链接都能浏览与下载；所有会改动数据的操作都收敛到一个管理口令后面。

## 访问模型

| 操作 | 匿名访客 | 口令持有者 |
| --- | --- | --- |
| 浏览 / 搜索 / 下载 / 打包文件夹 | ✅ | ✅ |
| WebDAV 读（`OPTIONS` / `PROPFIND` / `GET`） | ✅ | ✅ |
| 上传 / 新建文件夹 / 重命名 / 移动 | ❌ 401 | ✅ |
| 删除 / 回收站 / 还原 / 清空 | ❌ 401 | ✅ |
| WebDAV 写（`PUT` / `MKCOL` / `DELETE` / 分块上传） | ❌ 401 | ✅ |

设计意图是「**链接即分享**」：链接随便给，写口令自己留着。隔离细节与已知边界见 [SECURITY.md](SECURITY.md)。

## 功能

- 网格 / 列表两种视图，面包屑导航、多选、键盘快捷键、拖拽上传、粘贴上传、传输管理器
- 分块上传（超过 100 MB 的文件走分片流程），为其他客户端上传的图片懒生成缩略图
- 图片 / 视频 / 音频 / PDF / 文本的内联预览
- 回收站，保留天数可配置（`TRASH_RETENTION_DAYS`），可在界面上还原
- 文件夹打包下载
- `/webdav` 提供 WebDAV Class 1/2（自带服务端渲染的列表页，不依赖 JavaScript）
- 界面内自定义品牌：站点名、Logo、站点图标、主屏图标，**改完即生效，无需重新部署**
- 浅色 / 深色主题，中文 / 英文界面

## 本分支裁掉了什么

除了文件管理与 WebDAV 之外的功能全部移除，连同它们的后端端点、前端视图与环境变量一起删除：API Key 签发、MCP Playground、扩展网盘、CLI、静态站点与图床、TextPad、分享链接、收集表。

> 原则是：**每个不存在的端点，就是一个不存在的漏洞。**

## 部署到 Cloudflare Pages

1. 在 Cloudflare 账号里开通 R2，建一个桶（名字只能是小写字母 / 数字 / 连字符）。
2. 建一个 Pages 项目并指向本仓库。框架预设选 **None**，构建命令 `npm run build`，产物目录 `build`（`wrangler.toml` 里的 `pages_build_output_dir` 已经是这个值）。
3. 把你的 R2 桶绑定到变量名 **`BUCKET`**。
4. 配置环境变量：

   | 变量 | 类型 | 默认值 | 说明 |
   | --- | --- | --- | --- |
   | `ADMIN_USER` | 明文 | `admin` | 写操作用户名 |
   | `ADMIN_PASSWORD` | **Secret** | — | 写操作口令。**没配置时所有写操作一律返回 503**（fail-closed，永远不会变成「谁都能写」） |
   | `TRASH_RETENTION_DAYS` | 明文 | `30` | 回收站保留天数，过期对象被清掉。`-1` 关闭自动清理 |

   ```bash
   npx wrangler pages secret put ADMIN_PASSWORD --project-name <你的 Pages 项目名>
   ```

5. 可选：绑定自定义域名。

> **关于 `wrangler.toml` 里的 `name` 与 `bucket_name`。** 仓库里预填的是原作者线上部署所用的值，为的是重新部署时能直接对上。部署到你自己的账号前，请把这两项改成你自己的项目名与桶名。

> **R2 桶必须保持私有。** 它只应该通过 Pages 的绑定被访问。一旦开启桶的公共开发域名或自定义域，上面整套鉴权逻辑就全部被绕过了。

### 命令行部署

```bash
npm install
npm run build
npx wrangler pages deploy build --project-name <你的 Pages 项目名> --branch main
```

## 本地预览

`wrangler pages dev` 依赖可用的 `workerd`；如果你的机器上跑不起来，本仓库自带一个 Node 版的替身：它复刻 Pages 的路由规则，把真正的 `functions/` 代码跑起来，R2 用文件系统模拟。

```bash
npm install
npm run preview        # http://127.0.0.1:8788
npm run preview:reset  # 同上，但从空桶开始
npm run smoke          # 对运行中的本地预览跑端到端冒烟测试
```

`npm run smoke` 会逐条验证整套访问模型：匿名只读、无口令时写操作被拒、内部元数据前缀在 URL / API / WebDAV 三层都不可达、路径穿越被拒、回收站往返、分块上传，以及品牌相关端点。

本地口令放在 `.dev.vars`（已被 git 忽略，纯本地，不是任何环境的凭据）。

## WebDAV

| | |
| --- | --- |
| 地址 | `https://<你的域名>/webdav/` |
| 只读挂载 | 无需凭据 |
| 读写挂载 | 用户名 `ADMIN_USER`，口令 `ADMIN_PASSWORD` |

Windows（映射网络驱动器）：

```
net use W: https://<你的域名>/webdav/ /user:admin <口令>
```

在浏览器里打开 `/webdav/` 会渲染一个服务端生成的列表页 —— 适合把一个目录以「不带脚本」的朴素形式发给别人。

## 自定义品牌

两种方式，按需选：

1. **界面里改（无需重新部署）。** 登录管理员 → 右上角账户菜单 → **品牌设置**。可以改站点名，并上传 Logo、站点图标（favicon）与主屏图标（带预览）。保存后立即作用于顶栏、浏览器标签、登录弹窗、PWA 清单与 WebDAV 列表页；「恢复默认」会回到构建期配置。
2. **改配置文件（成为新部署的默认值）。** 编辑 `branding/config.json`，把素材图放到同目录，然后重新构建。字段与图片规格见 [branding/README.md](branding/README.md)。

两种方式共用同一套约束：素材按**内容**嗅探格式（不信任扩展名），单张 ≤ 1 MB（SVG ≤ 256 KB），SVG 上传时自动消毒，下发时叠加 `Content-Security-Policy: sandbox`。

> 仓库自带的 `public/favicon.png` 与 `public/logo144.png` 是上游项目留下的占位图，对外发布站点前请换成你自己的。

## 目录结构

```
functions/        Cloudflare Pages Functions —— 整个后端
  _middleware.ts    安全响应头、内部前缀拦截、探测路径
  api/              JSON API（list、stat、download、archive、upload、mkdir、rename、delete、trash、search、auth、branding）
  webdav/           WebDAV 协议实现与列表页
src/              React 前端
branding/         站点名 / Logo / 图标配置
tools/            本地预览服务、冒烟测试、品牌构建脚本
public/           静态资源与响应头配置
```

## 致谢

- [longern/FlareDrive](https://github.com/longern/FlareDrive)（作者 [longern](https://github.com/longern)）—— 这一系列分支的源头项目。内部对象前缀至今仍是 `_$flaredrive$/`。
- [lanshatop/Davflare](https://github.com/lanshatop/Davflare) —— 本分支裁剪自这个功能完整的重写版本。
- [r2-webdav](https://github.com/abersheeran/r2-webdav)（作者 [abersheeran](https://github.com/abersheeran)）—— WebDAV 实现参考。

## 许可证

[MIT](./LICENSE) —— 保留原始版权声明。
