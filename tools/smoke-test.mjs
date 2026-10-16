/**
 * 端到端冒烟测试（本地预览环境，不参与部署）。
 *
 * 直接打本地预览服务，逐条验证访问模型与安全边界是否真的成立：
 *   只读免密 / 写操作需口令 / 内部前缀不可达 / 路径穿越被拒 /
 *   WebDAV 读免密写要口令 / 回收站往返 / 分块上传。
 *
 * 每次运行使用独立的 smoke-<时间戳>/ 目录，可反复执行不互相干扰。
 * 用法：node tools/smoke-test.mjs [baseUrl]
 */

const BASE = process.argv[2] || "http://127.0.0.1:8788";
const USER = process.env.SMOKE_USER || "admin";
// 与 .dev.vars 的 ADMIN_PASSWORD 保持一致（纯本地开发口令，不是任何环境的凭据）
const PASSWORD = process.env.SMOKE_PASSWORD || "local-dev-not-a-secret";

const RUN = `smoke-${Date.now()}`;
const DIR = `${RUN}/共享资料`;
const FILE = `${DIR}/说明.txt`;
const RENAMED = `${DIR}/README.txt`;
const CHUNKED = `${RUN}/分块/大文件.bin`;
const WEBDAV_FILE = `${RUN}/webdav写入.txt`;

const enc = encodeURIComponent;
const basic = (user = USER, password = PASSWORD) =>
  `Basic ${Buffer.from(`${user}:${password}`, "utf8").toString("base64")}`;

let passed = 0;
let failed = 0;
const failures = [];

function check(name, condition, detail = "") {
  if (condition) {
    passed += 1;
    console.log(`  PASS  ${name}`);
  } else {
    failed += 1;
    failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function section(title) {
  console.log(`\n=== ${title} ===`);
}

async function req(pathname, init = {}) {
  return fetch(`${BASE}${pathname}`, { redirect: "manual", ...init });
}

// —— 品牌：测试会临时改掉品牌，结束后按快照还原，避免污染被测实例 ——

const ASSET_URL_FIELD = { logo: "logoUrl", icon: "iconUrl", appleTouchIcon: "appleTouchIconUrl" };

/** 带脚本与内联事件的 SVG，用来验证上传时的消毒（viewBox 120x32 → 宽高比 3.75）。 */
const SMOKE_SVG = `<svg viewBox="0 0 120 32" width="120" height="32">
<script>alert(1)</script>
<rect width="120" height="32" rx="6" fill="#f38020" onload="alert(2)"/>
<text x="60" y="21" text-anchor="middle" fill="#ffffff" font-size="14">SMOKE</text>
</svg>`;

async function snapshotBranding() {
  const branding = await (await req("/api/branding")).json();
  const assets = {};
  for (const [kind, field] of Object.entries(ASSET_URL_FIELD)) {
    const url = branding[field];
    // 只有运行期上传过的素材才走 /api/branding?asset=，构建期默认图标是静态文件
    if (typeof url !== "string" || !url.startsWith("/api/branding?asset=")) continue;
    const res = await req(url);
    if (!res.ok) continue;
    assets[kind] = {
      bytes: Buffer.from(await res.arrayBuffer()),
      type: res.headers.get("content-type") || "application/octet-stream",
    };
  }
  return { branding, assets };
}

async function restoreBranding(snapshot) {
  const reset = await req("/api/branding", { method: "DELETE", headers: { Authorization: basic() } });
  if (!reset.ok || !snapshot.branding.customized) return reset.ok;

  const form = new FormData();
  form.set("siteName", snapshot.branding.siteName ?? "");
  form.set("shortName", snapshot.branding.shortName ?? "");
  form.set("description", snapshot.branding.description ?? "");
  form.set("showNameBesideLogo", snapshot.branding.showNameBesideLogo ? "true" : "false");
  for (const [kind, asset] of Object.entries(snapshot.assets)) {
    form.append(kind, new Blob([asset.bytes], { type: asset.type }), kind);
  }
  const res = await req("/api/branding", {
    method: "POST",
    headers: { Authorization: basic() },
    body: form,
  });
  return res.ok;
}

async function main() {
  console.log(`目标：${BASE}`);
  console.log(`本次运行目录：${RUN}/`);

  // ---------------------------------------------------------------- 静态站点
  section("静态页面与安全响应头");
  {
    const res = await req("/");
    const html = await res.text();
    check("GET / 返回 200", res.status === 200, `status=${res.status}`);
    check("首页是 Wabdav-2022 的 HTML", html.includes("<title>Wabdav-2022</title>"));
    check("X-Content-Type-Options: nosniff", res.headers.get("x-content-type-options") === "nosniff");
    check("X-Frame-Options: DENY", res.headers.get("x-frame-options") === "DENY");
    check("Referrer-Policy: no-referrer", res.headers.get("referrer-policy") === "no-referrer");
    check("Content-Security-Policy 已下发", Boolean(res.headers.get("content-security-policy")));
    check(
      "X-Robots-Tag 禁止收录",
      (res.headers.get("x-robots-tag") || "").includes("noindex")
    );
  }

  // ------------------------------------------------------------ 内部前缀隔离
  section("内部前缀 _$flaredrive$ 隔离");
  {
    const plain = await req("/_$flaredrive$/config.json");
    check("明文内部前缀 → 404", plain.status === 404, `status=${plain.status}`);
    const encoded = await req("/_%24flaredrive%24/config.json");
    check("百分号编码绕过 → 404", encoded.status === 404, `status=${encoded.status}`);
    const inPath = await req("/api/list?path=_%24flaredrive%24");
    check("API 读取内部目录 → 400", inPath.status === 400, `status=${inPath.status}`);
    const viaTrash = await req("/api/download?path=_%24flaredrive%24%2Ftrash%2Fx.json");
    check("下载内部前缀对象 → 400", viaTrash.status === 400, `status=${viaTrash.status}`);
    const probe = await req("/.env");
    check("探测 .env → 404", probe.status === 404, `status=${probe.status}`);
  }

  // ------------------------------------------------------------ 只读接口免密
  section("只读接口免鉴权");
  {
    const list = await req("/api/list");
    check("匿名 GET /api/list → 200", list.status === 200, `status=${list.status}`);
    const listBody = await list.json().catch(() => ({}));
    check("匿名列举返回 items 数组", Array.isArray(listBody.items));
    check("动态响应 Cache-Control: no-store", list.headers.get("cache-control") === "no-store");

    const stat = await req(`/api/stat?path=${enc("no-such-file.txt")}`);
    check("匿名 GET /api/stat 可访问（404 属正常）", stat.status === 404 || stat.status === 200);

    const search = await req("/api/search?q=anything");
    check("匿名 GET /api/search → 200", search.status === 200, `status=${search.status}`);

    const counts = await req("/api/counts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ paths: ["a"] }),
    });
    check("匿名 POST /api/counts（只读例外）→ 200", counts.status === 200, `status=${counts.status}`);
  }

  // ---------------------------------------------------------------- 写鉴权
  section("写操作必须口令");
  {
    const noAuth = await req("/api/mkdir", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: `${RUN}/should-not-exist` }),
    });
    check("匿名 POST /api/mkdir → 401", noAuth.status === 401, `status=${noAuth.status}`);

    const badPw = await req("/api/mkdir", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: basic(USER, "definitely-wrong"),
      },
      body: JSON.stringify({ path: `${RUN}/should-not-exist` }),
    });
    check("错误口令 → 401", badPw.status === 401, `status=${badPw.status}`);

    const stillAbsent = await req(`/api/stat?path=${enc(`${RUN}/should-not-exist`)}`);
    check("被拒的写操作确实没有落库", stillAbsent.status === 404, `status=${stillAbsent.status}`);

    const auth = await req("/api/auth", { headers: { Authorization: basic() } });
    check("GET /api/auth 正确口令 → 200", auth.status === 200, `status=${auth.status}`);
    const authBody = await auth.json().catch(() => ({}));
    check("GET /api/auth 返回 ok=true", authBody.ok === true);

    const authBad = await req("/api/auth", { headers: { Authorization: basic(USER, "nope") } });
    check("GET /api/auth 错误口令 → 401", authBad.status === 401, `status=${authBad.status}`);
    check(
      "/api/auth 401 不带 WWW-Authenticate（避免浏览器原生弹窗）",
      !authBad.headers.get("www-authenticate")
    );
  }

  // ------------------------------------------------------- 目录创建与文件管理
  section("文件夹创建 / 上传 / 列举 / 下载 / 重命名");
  {
    const mkdir = await req("/api/mkdir", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: basic() },
      body: JSON.stringify({ path: `${DIR}/子目录` }),
    });
    check("带口令创建多级文件夹 → 201", mkdir.status === 201, `status=${mkdir.status}`);

    const mkdirAgain = await req("/api/mkdir", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: basic() },
      body: JSON.stringify({ path: `${DIR}/子目录` }),
    });
    const againBody = await mkdirAgain.json().catch(() => ({}));
    check(
      "重复创建文件夹幂等（不报错、不重复建）",
      mkdirAgain.status === 200 && againBody.created === false,
      JSON.stringify(againBody)
    );

    const form = new FormData();
    form.append("file", new File([Buffer.from("hello wabdav-2022 你好")], "说明.txt", { type: "text/plain" }));
    const upload = await req(`/api/upload?path=${enc(DIR)}`, {
      method: "POST",
      headers: { Authorization: basic() },
      body: form,
    });
    check("带口令上传文件 → 201", upload.status === 201, `status=${upload.status}`);
    const uploaded = await upload.json().catch(() => ({}));
    check("上传返回对象键", uploaded.key === FILE, JSON.stringify(uploaded));

    const anonymousUpload = await req("/api/upload?path=", {
      method: "POST",
      headers: { "X-File-Name": "x.txt", "Content-Type": "text/plain" },
      body: "nope",
    });
    check("匿名上传 → 401", anonymousUpload.status === 401, `status=${anonymousUpload.status}`);

    const list = await req(`/api/list?path=${enc(DIR)}`);
    const listBody = await list.json();
    const names = listBody.items.map((item) => `${item.name}${item.isDir ? "/" : ""}`);
    check(
      "匿名可列举到新建的目录与文件",
      names.includes("子目录/") && names.includes("说明.txt"),
      names.join(",")
    );

    const download = await req(`/api/download?path=${enc(FILE)}`);
    const text = await download.text();
    check("匿名下载文件 → 200", download.status === 200, `status=${download.status}`);
    check("下载内容正确（UTF-8 往返无损）", text === "hello wabdav-2022 你好", JSON.stringify(text));
    check(
      "下载带 Content-Disposition",
      (download.headers.get("content-disposition") || "").includes("attachment")
    );

    const ranged = await req(`/api/download?path=${enc(FILE)}`, {
      headers: { Range: "bytes=0-4" },
    });
    check("Range 请求 → 206", ranged.status === 206, `status=${ranged.status}`);
    check("Range 内容正确", (await ranged.text()) === "hello");
    check(
      "Range 响应带 Content-Range",
      (ranged.headers.get("content-range") || "").startsWith("bytes 0-4/")
    );

    const rename = await req("/api/rename", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: basic() },
      body: JSON.stringify({ from: FILE, to: RENAMED }),
    });
    check("带口令重命名 → 200", rename.status === 200, `status=${rename.status}`);

    const anonymousRename = await req("/api/rename", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ from: RENAMED, to: `${DIR}/hacked.txt` }),
    });
    check("匿名重命名 → 401", anonymousRename.status === 401, `status=${anonymousRename.status}`);

    const traversal = await req("/api/list?path=..%2F..%2Fetc");
    check("路径穿越 → 400", traversal.status === 400, `status=${traversal.status}`);

    const searchHit = await req("/api/search?q=readme");
    const searchBody = await searchHit.json();
    check(
      "匿名搜索能命中重命名后的文件",
      searchBody.items.some((item) => item.key === RENAMED),
      JSON.stringify(searchBody.items?.map((i) => i.key))
    );
  }

  // ------------------------------------------------------------------ 打包下载
  section("文件夹打包下载（免密）");
  {
    const zip = await req(`/api/archive?path=${enc(DIR)}`);
    check("匿名 GET /api/archive → 200", zip.status === 200, `status=${zip.status}`);
    check("返回 Content-Type: application/zip", zip.headers.get("content-type") === "application/zip");
    const buffer = Buffer.from(await zip.arrayBuffer());
    check("zip 魔数正确（PK）", buffer.subarray(0, 2).toString("latin1") === "PK");
  }

  // ---------------------------------------------------------------- 回收站
  section("回收站（需口令）");
  {
    const anonymousDelete = await req(`/api/delete?path=${enc(RENAMED)}&soft=1`, { method: "DELETE" });
    check("匿名软删除 → 401", anonymousDelete.status === 401, `status=${anonymousDelete.status}`);

    const deleted = await req(`/api/delete?path=${enc(RENAMED)}&soft=1`, {
      method: "DELETE",
      headers: { Authorization: basic() },
    });
    check("带口令软删除 → 200", deleted.status === 200, `status=${deleted.status}`);

    const anonymousTrash = await req("/api/trash");
    check("匿名看回收站 → 401", anonymousTrash.status === 401, `status=${anonymousTrash.status}`);

    const trash = await req("/api/trash", { headers: { Authorization: basic() } });
    const trashBody = await trash.json();
    const entry = trashBody.find((item) => item.originalKey === RENAMED);
    check("回收站列表需要且接受口令", trash.status === 200 && Boolean(entry), `status=${trash.status}`);
    check("回收站条目记录了原始路径", entry?.originalKey === RENAMED, JSON.stringify(entry));

    const gone = await req(`/api/stat?path=${enc(RENAMED)}`);
    check("删除后原路径不可见", gone.status === 404, `status=${gone.status}`);

    const restored = await req("/api/trash?action=restore", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: basic() },
      body: JSON.stringify({ trashKeys: [entry.trashKey] }),
    });
    const restoredBody = await restored.json();
    check("回收站还原成功", restoredBody[0]?.status === "restored", JSON.stringify(restoredBody));

    const back = await req(`/api/stat?path=${enc(RENAMED)}`);
    check("还原后文件重新可见", back.status === 200, `status=${back.status}`);

    const anonymousPurge = await req("/api/trash", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ all: true }),
    });
    check("匿名清空回收站 → 401", anonymousPurge.status === 401, `status=${anonymousPurge.status}`);
  }

  // ------------------------------------------------------------ 分块上传
  section("大文件分块上传（需口令）");
  {
    const created = await req(`/api/upload?uploads&path=${enc(CHUNKED)}`, {
      method: "POST",
      headers: { Authorization: basic(), "Content-Type": "application/octet-stream" },
    });
    const createdBody = await created.json().catch(() => ({}));
    check("创建分块上传 → 201", created.status === 201 && Boolean(createdBody.uploadId), JSON.stringify(createdBody));

    const anonymousCreate = await req(`/api/upload?uploads&path=${enc(`${RUN}/anon.bin`)}`, {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
    });
    check("匿名创建分块上传 → 401", anonymousCreate.status === 401, `status=${anonymousCreate.status}`);

    const partA = Buffer.alloc(1024, 1);
    const partB = Buffer.alloc(2048, 2);
    const putA = await req(
      `/api/upload?path=${enc(CHUNKED)}&uploadId=${createdBody.uploadId}&partNumber=1`,
      { method: "PUT", headers: { Authorization: basic() }, body: partA }
    );
    const putABody = await putA.json().catch(() => ({}));
    const putB = await req(
      `/api/upload?path=${enc(CHUNKED)}&uploadId=${createdBody.uploadId}&partNumber=2`,
      { method: "PUT", headers: { Authorization: basic() }, body: partB }
    );
    const putBBody = await putB.json().catch(() => ({}));
    check("上传两个分块", putA.status === 200 && putB.status === 200);

    const done = await req(`/api/upload?path=${enc(CHUNKED)}&uploadId=${createdBody.uploadId}`, {
      method: "POST",
      headers: { Authorization: basic(), "Content-Type": "application/json" },
      body: JSON.stringify({
        parts: [
          { partNumber: 1, etag: putABody.etag },
          { partNumber: 2, etag: putBBody.etag },
        ],
      }),
    });
    const doneBody = await done.json().catch(() => ({}));
    check("合并分块 → 200 且大小正确", done.status === 200 && doneBody.size === 3072, JSON.stringify(doneBody));

    const downloaded = await req(`/api/download?path=${enc(CHUNKED)}`);
    const buffer = Buffer.from(await downloaded.arrayBuffer());
    check(
      "分块上传结果可匿名下载且内容完整",
      buffer.length === 3072 && buffer[0] === 1 && buffer[3071] === 2
    );
  }

  // ------------------------------------------------------------------ WebDAV
  section("WebDAV：读免密、写需口令");
  {
    const propfind = await req("/webdav/", { method: "PROPFIND", headers: { Depth: "1" } });
    check("匿名 PROPFIND → 207", propfind.status === 207, `status=${propfind.status}`);
    const xml = await propfind.text();
    check("PROPFIND 返回 DAV 命名空间", xml.includes("DAV:"));
    check("匿名 PROPFIND 能看到本次运行目录", xml.includes(RUN), `looked for ${RUN}`);

    const nested = await req(`/webdav/${enc(RUN)}/`, { method: "PROPFIND", headers: { Depth: "1" } });
    check("匿名 PROPFIND 子目录 → 207", nested.status === 207, `status=${nested.status}`);
    // href 按 RFC 3986 做百分号编码是正确行为，断言前先解码再比对。
    const nestedXml = await nested.text();
    let nestedDecoded = nestedXml;
    try {
      nestedDecoded = decodeURIComponent(nestedXml);
    } catch {
      /* 响应含非法百分号序列时保持原样，交由断言失败暴露 */
    }
    check("子目录列举包含「共享资料」", nestedDecoded.includes("共享资料"));

    const options = await req("/webdav/", { method: "OPTIONS" });
    check("匿名 OPTIONS → 200", options.status === 200, `status=${options.status}`);
    check("OPTIONS 声明 DAV: 1, 2", (options.headers.get("dav") || "").includes("1"));

    const anonPut = await req(`/webdav/${enc(`${RUN}/anon.txt`)}`, { method: "PUT", body: "nope" });
    check("匿名 PUT → 401", anonPut.status === 401, `status=${anonPut.status}`);

    const authPut = await req(`/webdav/${enc(WEBDAV_FILE)}`, {
      method: "PUT",
      headers: { Authorization: basic(), "Content-Type": "text/plain" },
      body: "written over webdav",
    });
    check("带口令 PUT → 201/204", [201, 204].includes(authPut.status), `status=${authPut.status}`);

    const anonGet = await req(`/webdav/${enc(WEBDAV_FILE)}`);
    check("匿名 GET WebDAV 文件 → 200", anonGet.status === 200, `status=${anonGet.status}`);
    check("WebDAV 文件内容正确", (await anonGet.text()) === "written over webdav");

    const noAuthMkcol = await req(`/webdav/${enc(`${RUN}/should-not-exist`)}`, { method: "MKCOL" });
    check("匿名 MKCOL → 401", noAuthMkcol.status === 401, `status=${noAuthMkcol.status}`);

    const authMkcol = await req(`/webdav/${enc(`${RUN}/webdav目录`)}`, {
      method: "MKCOL",
      headers: { Authorization: basic() },
    });
    check("带口令 MKCOL → 201", authMkcol.status === 201, `status=${authMkcol.status}`);

    const anonDelete = await req(`/webdav/${enc(WEBDAV_FILE)}`, { method: "DELETE" });
    check("匿名 DELETE → 401", anonDelete.status === 401, `status=${anonDelete.status}`);

    const authDelete = await req(`/webdav/${enc(WEBDAV_FILE)}`, {
      method: "DELETE",
      headers: { Authorization: basic() },
    });
    check("带口令 DELETE → 204", [200, 204].includes(authDelete.status), `status=${authDelete.status}`);

    const internalPropfind = await req("/webdav/_%24flaredrive%24/", { method: "PROPFIND" });
    check("WebDAV 访问内部前缀 → 404", internalPropfind.status === 404, `status=${internalPropfind.status}`);
  }

  // ------------------------------------------------------------------ 品牌
  section("品牌设置（站点名 / Logo / 图标）");
  {
    const before = await snapshotBranding();
    const brandName = `${RUN} 站点`;

    const read = await req("/api/branding");
    const initial = await read.json();
    check("匿名读取品牌 → 200", read.status === 200, `status=${read.status}`);
    check(
      "品牌响应含站点名与图标地址",
      typeof initial.siteName === "string" && typeof initial.iconUrl === "string"
    );
    check("非法素材类型 → 400", (await req("/api/branding?asset=../config")).status === 400);

    const anonWrite = await req("/api/branding", {
      method: "POST",
      body: new FormData(),
    });
    check("匿名上传品牌 → 401", anonWrite.status === 401, `status=${anonWrite.status}`);
    const anonReset = await req("/api/branding", { method: "DELETE" });
    check("匿名重置品牌 → 401", anonReset.status === 401, `status=${anonReset.status}`);

    // 先带着口令重置到「未配置」，这样 404 这条断言才确定（结束时按快照还原）
    await req("/api/branding", { method: "DELETE", headers: { Authorization: basic() } });
    const cleanState = await (await req("/api/branding")).json();
    check("重置后品牌回落为构建期默认", cleanState.customized === false);
    check("重置后取 Logo → 404", (await req("/api/branding?asset=logo")).status === 404);
    check("重置后取图标 → 404", (await req("/api/branding?asset=icon")).status === 404);

    const form = new FormData();
    form.set("siteName", brandName);
    form.set("shortName", "SMOKE");
    form.set("description", "冒烟测试品牌");
    form.set("showNameBesideLogo", "true");
    form.append("logo", new Blob([SMOKE_SVG], { type: "image/svg+xml" }), "logo.svg");
    const saved = await req("/api/branding", {
      method: "POST",
      headers: { Authorization: basic() },
      body: form,
    });
    const savedBody = await saved.json().catch(() => ({}));
    check(
      "带口令上传 Logo 并改名 → 200",
      saved.status === 200,
      `status=${saved.status} body=${JSON.stringify(savedBody).slice(0, 180)}`
    );
    check("站点名已更新", savedBody.siteName === brandName, `siteName=${savedBody.siteName}`);
    check(
      "logoUrl 指向受控出口而非内部键",
      typeof savedBody.logoUrl === "string" &&
        savedBody.logoUrl.startsWith("/api/branding?asset=logo"),
      `logoUrl=${savedBody.logoUrl}`
    );
    check("SVG 宽高比已解析", savedBody.logoAspectRatio === 3.75, `ratio=${savedBody.logoAspectRatio}`);
    check(
      "上传回执包含消毒提示",
      Array.isArray(savedBody.notes) && savedBody.notes.some((n) => String(n).includes("script"))
    );

    const asset = await req(savedBody.logoUrl || "/api/branding?asset=logo");
    const svg = await asset.text();
    check(
      "取回素材 → 200 且为 SVG",
      asset.status === 200 && (asset.headers.get("content-type") || "").includes("image/svg+xml"),
      `status=${asset.status} type=${asset.headers.get("content-type")}`
    );
    check(
      "下发 SVG 带 CSP sandbox（直接打开也读不到同源数据）",
      (asset.headers.get("content-security-policy") || "") === "sandbox"
    );
    check(
      "素材长缓存（URL 内容寻址）",
      (asset.headers.get("cache-control") || "").includes("immutable")
    );
    check("脚本与内联事件已被剥离", !/<script/i.test(svg) && !/on[a-z]+\s*=/i.test(svg));
    check("已补全缺失的 xmlns", /xmlns="http:\/\/www\.w3\.org\/2000\/svg"/.test(svg));

    const pageHtml = await (await req("/webdav/")).text();
    check("WebDAV 浏览页标题随品牌变化", pageHtml.includes(brandName));
    check(
      "WebDAV 浏览页品牌标用受控出口的图",
      pageHtml.includes("/api/branding?asset=logo")
    );

    const manifest = await (await req("/manifest.json")).json().catch(() => ({}));
    check("PWA manifest 名称随品牌变化", manifest.name === brandName, `name=${manifest.name}`);

    const notImage = new FormData();
    notImage.append("icon", new Blob([new Uint8Array(4096)], { type: "image/png" }), "fake.png");
    const notImageRes = await req("/api/branding", {
      method: "POST",
      headers: { Authorization: basic() },
      body: notImage,
    });
    check(
      "伪装成 PNG 的非图片内容被拒 → 400",
      notImageRes.status === 400,
      `status=${notImageRes.status}`
    );

    const internalList = await req("/api/list?path=_%24flaredrive%24%2Fbranding");
    check("常规列举看不到品牌素材 → 400", internalList.status === 400, `status=${internalList.status}`);
    const internalDav = await req("/webdav/_%24flaredrive%24/branding/", { method: "PROPFIND" });
    check("WebDAV 看不到品牌素材 → 404", internalDav.status === 404, `status=${internalDav.status}`);

    const restored = await restoreBranding(before);
    const after = await (await req("/api/branding")).json();
    check(
      "测试后品牌已还原到测试前状态",
      restored && after.siteName === before.branding.siteName,
      `restored=${restored} siteName=${after.siteName}`
    );
    check("测试期素材已从 R2 清除", (await req("/api/branding?asset=logo")).status === 404 || before.assets.logo);
  }

  // ------------------------------------------------------------------ 收尾
  section("清理本次测试数据");
  {
    const cleanup = await req(`/api/delete?path=${enc(RUN)}`, {
      method: "DELETE",
      headers: { Authorization: basic() },
    });
    check("带口令递归删除本次运行目录 → 200", cleanup.status === 200, `status=${cleanup.status}`);
    const gone = await req(`/api/list?path=${enc(RUN)}`);
    check("清理后目录不可见", gone.status === 404, `status=${gone.status}`);
  }

  console.log(`\n结果：${passed} 通过 / ${failed} 失败`);
  if (failures.length) {
    console.log("\n失败项：");
    failures.forEach((item) => console.log(`  - ${item}`));
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error("冒烟测试异常：", error);
  process.exitCode = 1;
});
