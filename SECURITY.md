# Wabdav-2022 安全风险隔离说明

> 本文档说明 Wabdav-2022（基于 Davflare 裁剪）在「只读免密 + 写操作口令」模型下
> 做了哪些安全隔离，以及部署到 Cloudflare 时需要额外注意的事项。

---

## 1. 访问模型

| 操作 | 匿名访问者 | 管理口令持有者 |
|---|---|---|
| 浏览目录 / 搜索 | ✅ | ✅ |
| 下载文件 / 打包下载 | ✅ | ✅ |
| WebDAV 读（PROPFIND / GET / OPTIONS） | ✅ | ✅ |
| 上传 / 新建文件夹 / 重命名 / 移动 | ❌ 401 | ✅ |
| 删除 / 回收站查看与还原 / 清空 | ❌ 401 | ✅ |
| WebDAV 写（PUT / MKCOL / DELETE / 分块上传） | ❌ 401 | ✅ |

**设计原则**：分享资料场景下，读操作完全免密（可直接把链接发给别人）；
一切会改动数据的操作都收敛到一个口令后面。

---

## 2. 凭据与鉴权

### 2.1 唯一比较入口：`requireWrite()`

所有写端点（upload / mkdir / delete / rename / trash、WebDAV 写方法）
都调用 `functions/api/_core.ts` 的 `requireWrite()`，它做了两件事：

- **fail-closed**：如果部署环境没有配置 `ADMIN_PASSWORD`，一律返回 `503`，
  即「没配口令 = 没人能写」，而**不是**「任何人都能写」；
- **常数时间比较**：使用 `timingSafeEqual` 对整个 `Authorization: Basic …`
  头做逐字节比较，不泄漏「第几位错了」这类时序信息。

### 2.2 登录校验端点不触发浏览器弹窗

`GET /api/auth` 校验口令，但 401 响应**刻意不带** `WWW-Authenticate` 头，
避免浏览器弹出原生 Basic 认证对话框（那会打断前端的受控弹窗流程）。

### 2.3 前端本地短路

`src/app/auth.tsx` 的 `authFetch()` 在发出**写请求**前先检查本地凭据：
没有凭据就直接返回 401 并唤起口令弹窗，省掉一次注定失败的往返；
只有 `/api/counts`、`/api/archive` 这两个用 POST 但语义只读的端点例外放行。

---

## 3. 内部前缀隔离（最高优先级）

R2 桶里有一个保留前缀 `_$flaredrive$/`，用于存放：

- 回收站对象与条目元数据（`_$flaredrive$/trash/…`）
- 缩略图摘要（`_$flaredrive$/thumbnails/…`）

这些对象的**文件名本身就包含其他文件的原路径**，属于敏感信息，
必须确保任何访客（包括口令持有者走正常入口）都无法直接读取。
因此做了**三层拦截**：

1. **URL 层**：`functions/_middleware.ts` 对所有路径做包含性匹配，
   同时检查原始路径与 `decodeURIComponent` 之后的路径，
   `_$flaredrive$`、`_%24flaredrive%24`、`%5f%24flare…` 等编码变体一律 404；
2. **Key 层**：每个 API 端点在拼出 R2 key 后再调 `isInternalKey()` 复核一次，
   防止绕过 URL 直接用查询参数构造；
3. **WebDAV 层**：`webdav/[[path]].ts` 同样拒绝内部前缀，返回 404 而非 403
   （404 不暴露「这里确实有东西」）。

> 冒烟测试覆盖：明文、百分号编码、API 读取、下载、WebDAV 五条路径全部 404/400。

---

## 4. 路径与输入校验

| 风险 | 防护 |
|---|---|
| 路径穿越 `..` | 所有端点拒绝含 `..` 的路径段（400） |
| `%2e%2e` / `%2F` 混淆 | `decodeRawPath()` 刻意**不做二次 URL 解码**，只依赖 URLSearchParams 的一次解码 |
| 反斜杠 `..\` | 统一归一化为 `/` 再处理 |
| 空字节 / 控制字符 | 文件名清洗掉 `\u0000-\u001f` |
| 目录递归爆炸 | 列举/删除/复制的单次对象上限 1000 |
| 上传体积 | 单请求 100MB 上限（Workers 硬限制），更大走分块上传 |
| 分块 partNumber | 限定 1–10000，合并时校验升序且不重复 |

---

## 5. 响应头与防探测

### 5.1 安全响应头（`functions/_middleware.ts` + `public/_headers`）

```
X-Content-Type-Options: nosniff
X-Frame-Options: DENY
Referrer-Policy: no-referrer
X-Robots-Tag: noindex, nofollow, noarchive
Content-Security-Policy: default-src 'self'; script-src 'self';
  style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:;
  media-src 'self' blob:; connect-src 'self'; object-src 'none';
  base-uri 'self'; form-action 'self'; frame-ancestors 'none'
```

- CSP 不允许任何第三方源，压缩了 XSS 外联与注入面；
- `no-referrer` 避免分享链接时把内部 URL 泄漏给目标站点；
- `/api/*` 与 `/webdav/*` 额外带 `Cache-Control: no-store`，
  防止中间层缓存把带口令的响应吐给别人。

### 5.2 常见探测路径直接 404

`.env` / `.git/` / `.svn/` / `.aws/` / `.ssh/` / `wp-admin` / `wp-login` / `phpmyadmin`
等扫描器常用路径统一返回 404，不给任何指纹。

### 5.3 搜索引擎

`robots.txt` 为 `Disallow: /`，加上 `X-Robots-Tag`，双保险避免目录内容被收录。

---

## 6. 已裁剪的攻击面

原 Davflare 的以下功能整体移除，其对应的后端端点、前端视图与环境变量一并删除：

- API Key 体系（`api/_apikey.ts` 及签发界面）→ 换成单一管理口令
- MCP Playground、扩展网盘（extension drive）、CLI
- Sites / Images 视图、TextPad、分享链接（share）、收集表（collect）
- 对外发布（publish）相关 Dialog 与端点

> 裁剪原则：**每个不存在的端点就是一个不存在的漏洞**。

---

## 7. 部署时的安全清单（Cloudflare）

1. **`ADMIN_PASSWORD` 用 Secret，不要写进 `wrangler.toml`**
   ```bash
   npx wrangler pages secret put ADMIN_PASSWORD --project-name <你的 Pages 项目名>
   ```
   Secret 不会出现在构建日志与 git 里。

2. **R2 桶不设公开访问**。桶只通过 Pages 绑定（binding `BUCKET`）访问，
   不要开启 R2 的公共开发站点或自定义域，否则会绕过全部鉴权逻辑。

3. **不要给 `/webdav/*` 配 Cloudflare Access**，除非你希望 WebDAV 也走 SSO——
   Access 会拦掉匿名只读。

4. **限速（可选但推荐）**：在 Cloudflare 仪表盘给 `/api/*` 加一条 Rate Limiting 规则
   （例如「同 IP 每分钟 60 次」），能显著降低暴力猜口令的可行性。
   `requireWrite()` 的 401 不带 `WWW-Authenticate`，浏览器不会自动重试，天然利于限速。

5. **口令强度**：既然是唯一的写凭据，建议 ≥ 20 位随机串。
   泄漏后用上面第 1 条命令随时轮换，前端会在下一次 401 时自动登出。

6. **域名**：把 `<你的域名>` 绑定为 Pages 自定义域。
   Pages 默认提供 HTTPS 与 HTTP/3；确认「Always Use HTTPS」开启即可。

---

## 8. 已知边界（诚实说明）

- **Basic Auth 走明文头**：安全性完全依赖 HTTPS。Cloudflare Pages 强制 HTTPS，
  但如果有人把自定义域指到别处（DNS 劫持），口令可能被中间人截获。
  这不是本项目独有的问题，所有 Basic Auth 方案皆然。
- **没有用户体系**：只有一个管理口令。多人协作时共享同一口令，无法区分是谁删的。
  如需审计，建议后续加 Cloudflare Access 或换成带用户体系的方案。
- **回收站需要口令才能看**：匿名访客看不到回收站（连「是否存在」都看不到），
  这是刻意的——回收站条目名里含原路径。
- **防爆破**：后端没有内置失败次数锁定，依赖第 7 节第 4 条的边缘限速。
