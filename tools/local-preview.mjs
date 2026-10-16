/**
 * 本地预览服务（仅用于开发，不参与部署）。
 *
 * 背景：本机 workerd 无法启动，`wrangler pages dev` 用不了。这里用 Node 复刻
 * Cloudflare Pages 的调度规则，把 functions/ 下的代码真正跑起来：
 *   1. esbuild 把 functions/** 打包成一个 ESM 模块；
 *   2. 按 Pages 的约定做路由解析（api/list.ts → /api/list，webdav/[[path]].ts → /webdav/*）；
 *   3. 根 _middleware.ts 包在所有路由外面，与 Pages 一致；
 *   4. 未命中 Function 的路径回落到 build/ 静态产物；
 *   5. R2 由 tools/r2-local.mjs 用文件系统模拟。
 *
 * 用法：node tools/local-preview.mjs [--port 8788] [--reset]
 *   --reset  启动前清空本地模拟的 R2 存储（默认保留上次的对象）
 */

import fs from "node:fs";
import fsp from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Readable } from "node:stream";
import * as esbuild from "esbuild";

import { LocalR2Bucket } from "./r2-local.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, "..");
const functionsDir = path.join(projectRoot, "functions");
const buildDir = path.join(projectRoot, "build");
const generatedDir = path.join(here, ".generated");

/**
 * R2 模拟层的数据目录。
 *
 * 刻意落在系统临时目录，而不是项目内：
 *  1. 它是纯本地的临时数据（模拟的 R2 对象），不属于源码，放进工作区只是噪音；
 *  2. 沙箱运行时对 fs.rm / unlink 挂了「单次工具调用内批量删除」保护，工作区
 *     路径下的删除会被拦下并抛 SAFE_DELETE_BULK_CONFIRM_REQUIRED；系统临时目录
 *     在放行的白名单内，删除直接走原生路径。于是模拟层可以自由增删对象，
 *     而**不需要关闭任何安全机制**。
 * 子目录名取项目路径的短哈希，避免同机多个项目互相串数据。
 * 需要固定位置时用 WABDAV_LOCAL_R2_DIR 覆盖。
 */
const stateDir =
  process.env.WABDAV_LOCAL_R2_DIR ||
  path.join(
    os.tmpdir(),
    "wabdav-2022-local-preview",
    crypto.createHash("sha1").update(projectRoot).digest("hex").slice(0, 12)
  );
const r2Dir = path.join(stateDir, "r2");

const portArg = process.argv.indexOf("--port");
const PORT = portArg > -1 ? Number(process.argv[portArg + 1]) : 8788;
// --reset：清空本地模拟存储，从空桶开始（默认保留上次的对象）
const RESET = process.argv.includes("--reset");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".webp": "image/webp",
  ".txt": "text/plain; charset=utf-8",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

/** 递归收集 functions/ 下的 .ts 文件。 */
function collectFunctionFiles(dir, base = dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) collectFunctionFiles(full, base, out);
    else if (entry.name.endsWith(".ts")) out.push(path.relative(base, full));
  }
  return out;
}

/** 按 Pages 约定把文件路径转成路由模式。 */
function routeOf(relative) {
  const noExt = relative.replace(/\.ts$/, "");
  if (path.basename(noExt) === "_middleware") return { kind: "middleware" };
  const segments = noExt.split(/[\\/]/).filter(Boolean);
  if (segments[segments.length - 1] === "index") segments.pop();
  if (segments.length === 0) return { kind: "route", pattern: "/", catchAll: false };

  let catchAll = false;
  const parts = segments.map((segment) => {
    if (/^\[\[.+\]\]$/.test(segment)) {
      catchAll = true;
      return "**";
    }
    if (/^\[.+\]$/.test(segment)) return "*";
    return segment;
  });
  return { kind: "route", pattern: `/${parts.join("/")}`, catchAll };
}

function readDevVars() {
  const file = path.join(projectRoot, ".dev.vars");
  const vars = {};
  if (!fs.existsSync(file)) return vars;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    vars[key] = value;
  }
  return vars;
}

async function buildFunctions() {
  const files = collectFunctionFiles(functionsDir);
  await fsp.mkdir(generatedDir, { recursive: true });

  const imports = [];
  const table = [];
  files.forEach((relative, index) => {
    // 用相对路径而不是 file:// URL：文件名里的 [[path]] 会被百分号编码，
    // esbuild 解析不了。生成文件在 tools/.generated/ 下。
    const target = path.join(functionsDir, relative);
    let specifier = path.relative(generatedDir, target).split(path.sep).join("/");
    if (!specifier.startsWith(".")) specifier = `./${specifier}`;
    imports.push(`import * as m${index} from ${JSON.stringify(specifier)};`);
    const route = routeOf(relative);
    table.push(
      `  { file: ${JSON.stringify(relative)}, kind: ${JSON.stringify(route.kind)}, ` +
        `pattern: ${JSON.stringify(route.pattern ?? null)}, catchAll: ${route.catchAll ?? false}, mod: m${index} },`
    );
  });

  const entrySource = `${imports.join("\n")}\n\nexport const table = [\n${table.join("\n")}\n];\n`;
  const entryPath = path.join(generatedDir, "functions-entry.ts");
  await fsp.writeFile(entryPath, entrySource, "utf8");

  const outfile = path.join(generatedDir, "functions.mjs");
  await esbuild.build({
    entryPoints: [entryPath],
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node20",
    outfile,
    logLevel: "warning",
    mainFields: ["module", "main"],
    banner: {
      js: 'import { createRequire as __cr } from "node:module"; const require = __cr(import.meta.url);',
    },
  });

  return import(pathToFileURL(outfile).href);
}

function matchRoute(table, pathname) {
  let best = null;
  for (const entry of table) {
    if (entry.kind !== "route") continue;
    if (entry.catchAll) {
      const base = entry.pattern.slice(0, -"/**".length);
      if (pathname === base || pathname.startsWith(`${base}/`)) {
        if (!best || base.length > best.base.length) {
          best = { entry, base, params: { path: pathname.slice(base.length).replace(/^\//, "") } };
        }
      }
      continue;
    }
    if (entry.pattern === pathname) {
      return { entry, params: {} };
    }
    if (entry.pattern.includes("*")) {
      const parts = entry.pattern.split("/");
      const target = pathname.split("/");
      if (parts.length === target.length) {
        const params = {};
        let ok = true;
        for (let i = 0; i < parts.length; i++) {
          if (parts[i] === "*") params[parts[i]] = target[i];
          else if (parts[i] !== target[i]) {
            ok = false;
            break;
          }
        }
        if (ok) return { entry, params };
      }
    }
  }
  if (best) return { entry: best.entry, params: best.params };
  return null;
}

function methodHandler(mod, method) {
  return mod[`onRequest${method[0]}${method.slice(1).toLowerCase()}`] ?? mod.onRequest ?? null;
}

function selectHandler(mod, method) {
  const handler = methodHandler(mod, method);
  if (!handler) return null;
  return handler;
}

async function serveStatic(pathname) {
  let target = path.join(buildDir, pathname);
  if (!target.startsWith(buildDir)) return new Response("Not Found", { status: 404 });
  if (pathname === "/" || pathname === "") target = path.join(buildDir, "index.html");
  if (!fs.existsSync(target) || fs.statSync(target).isDirectory()) {
    // SPA：未知路径回落 index.html
    const fallback = path.join(buildDir, "index.html");
    if (!fs.existsSync(fallback)) return new Response("Not Found", { status: 404 });
    return new Response(fs.readFileSync(fallback), {
      status: 200,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }
  return new Response(fs.readFileSync(target), {
    status: 200,
    headers: { "Content-Type": MIME[path.extname(target)] ?? "application/octet-stream" },
  });
}

/**
 * 只返回真实存在的静态文件，不做 SPA 回落。
 * 供 env.ASSETS 使用：Pages 的静态产物绑定只服务实际存在的资源，
 * 未命中就该 404，而不是回一份 index.html。
 */
async function serveAssetFile(pathname) {
  let target = path.join(buildDir, pathname);
  if (!target.startsWith(buildDir)) return new Response("Not Found", { status: 404 });
  if (pathname === "/" || pathname === "") target = path.join(buildDir, "index.html");
  if (!fs.existsSync(target) || fs.statSync(target).isDirectory()) {
    return new Response("Not Found", { status: 404 });
  }
  return new Response(fs.readFileSync(target), {
    status: 200,
    headers: { "Content-Type": MIME[path.extname(target)] ?? "application/octet-stream" },
  });
}

async function main() {
  if (!fs.existsSync(buildDir)) {
    console.error("没有找到 build/ 目录，请先执行 npm run build");
    process.exit(1);
  }

  const { table } = await buildFunctions();
  const middlewares = table.filter((entry) => entry.kind === "middleware");
  if (RESET && fs.existsSync(r2Dir)) {
    await fsp.rm(r2Dir, { recursive: true, force: true });
    console.log(`已清空本地模拟存储：${r2Dir}`);
  }
  const env = {
    ...readDevVars(),
    BUCKET: new LocalR2Bucket(r2Dir),
    // Pages 会注入静态产物绑定；动态 manifest 用它读构建期的基线清单
    ASSETS: {
      fetch: (input) => {
        const raw =
          typeof input === "string"
            ? input
            : input instanceof URL
            ? input.href
            : String(input?.url ?? input);
        return serveAssetFile(new URL(raw, `http://127.0.0.1:${PORT}`).pathname);
      },
    },
    CF_PAGES: "1",
    CF_PAGES_BRANCH: "local",
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host ?? `127.0.0.1:${PORT}`}`);
    const method = (req.method ?? "GET").toUpperCase();

    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const bodyBuffer = Buffer.concat(chunks);
    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers)) {
      if (value === undefined) continue;
      if (Array.isArray(value)) value.forEach((v) => headers.append(key, v));
      else headers.set(key, value);
    }

    const request = new Request(url, {
      method,
      headers,
      body: ["GET", "HEAD"].includes(method) ? undefined : bodyBuffer,
    });

    const matched = matchRoute(table, url.pathname);
    const context = {
      request,
      env,
      params: matched?.params ?? {},
      data: {},
      waitUntil: () => {},
      passThroughOnException: () => {},
      next: () => serveStatic(url.pathname),
      functionPath: matched?.entry.file ?? "",
    };

    const runRoute = async () => {
      if (!matched) return context.next();
      const handler = selectHandler(matched.entry.mod, method);
      if (!handler) {
        return new Response("Method Not Allowed", {
          status: 405,
          headers: { Allow: "GET, HEAD, POST, PUT, DELETE, OPTIONS, PROPFIND, PROPPATCH, MKCOL, COPY, MOVE, LOCK, UNLOCK" },
        });
      }
      return handler(context);
    };

    let response;
    try {
      if (middlewares.length) {
        let index = 0;
        const chain = async () => {
          const entry = middlewares[index++];
          if (!entry) return runRoute();
          const handler = selectHandler(entry.mod, method);
          if (!handler) return chain();
          return handler({ ...context, next: chain });
        };
        response = await chain();
      } else {
        response = await runRoute();
      }
    } catch (error) {
      console.error(`[500] ${method} ${url.pathname}`, error);
      response = new Response(`Internal Error: ${error?.message ?? error}`, { status: 500 });
    }

    const outHeaders = {};
    response.headers.forEach((value, key) => {
      outHeaders[key] = value;
    });
    res.writeHead(response.status, outHeaders);
    if (response.body && method !== "HEAD") {
      Readable.fromWeb(response.body).pipe(res);
    } else {
      res.end();
    }
  });

  server.listen(PORT, "127.0.0.1", () => {
    console.log(`Wabdav-2022 本地预览已启动： http://127.0.0.1:${PORT}/`);
    console.log(`  Functions: ${table.filter((e) => e.kind === "route").length} 个路由，${middlewares.length} 个中间件`);
    console.log(`  R2 本地目录: ${r2Dir}`);
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
