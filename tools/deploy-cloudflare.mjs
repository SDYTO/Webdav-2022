/**
 * 一键部署到 Cloudflare Pages。
 *
 * 做四件事，全部幂等（重复执行安全）：
 *   1. 检查登录凭据（CLOUDFLARE_API_TOKEN 或 wrangler login）
 *   2. 确保 R2 桶存在（不存在就创建）
 *   3. 确保 Pages 项目存在（不存在就创建）
 *   4. 构建 → 部署，并把 ADMIN_PASSWORD 写进 Pages 项目
 *
 * 用法：
 *   node tools/deploy-cloudflare.mjs
 *   node tools/deploy-cloudflare.mjs --project-name my-drive --bucket-name my-bucket
 *   node tools/deploy-cloudflare.mjs --password '我的写入口令' --branch main
 *   node tools/deploy-cloudflare.mjs --dry-run      # 只打印将要执行的操作
 *
 * 凭据来源（按优先级）：
 *   --password 参数  →  ADMIN_PASSWORD 环境变量  →  交互式询问
 *   Cloudflare 鉴权走 CLOUDFLARE_API_TOKEN 环境变量，或本机已有的 wrangler login。
 *
 * 项目名与桶名的默认值取自 wrangler.toml；显式传参时会同步改写该文件，
 * 因为 wrangler 只从 wrangler.toml 读取 R2 绑定，没有对应的命令行开关。
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const wranglerToml = path.join(root, "wrangler.toml");
const buildDir = path.join(root, "build");

// ---------- 小工具 ----------

const log = {
  step: (msg) => console.log(`\n\x1b[1m▸ ${msg}\x1b[0m`),
  info: (msg) => console.log(`  ${msg}`),
  ok: (msg) => console.log(`  \x1b[32m✓\x1b[0m ${msg}`),
  warn: (msg) => console.log(`  \x1b[33m!\x1b[0m ${msg}`),
  fail: (msg) => console.error(`  \x1b[31m✗\x1b[0m ${msg}`),
};

function die(msg) {
  log.fail(msg);
  process.exit(1);
}

/** 执行命令；capture=true 时返回 stdout，不打印到终端。 */
function run(command, { capture = false } = {}) {
  const result = spawnSync(command, {
    cwd: root,
    shell: true,
    encoding: "utf8",
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
    env: { ...process.env, WRANGLER_SEND_METRICS: "false", CI: "1" },
  });
  if (result.error) throw result.error;
  return {
    code: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

/** 需要 stdin 的命令（wrangler pages secret put 从 stdin 读值）。 */
function runWithInput(command, input) {
  const result = spawnSync(command, {
    cwd: root,
    shell: true,
    encoding: "utf8",
    input,
    stdio: ["pipe", "inherit", "inherit"],
    env: { ...process.env, WRANGLER_SEND_METRICS: "false", CI: "1" },
  });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, (answer) => (rl.close(), resolve(answer))));
}

// ---------- 参数 ----------

const HELP = `
一键部署到 Cloudflare Pages

用法
  node tools/deploy-cloudflare.mjs [选项]

选项
  --project-name <名称>   Cloudflare Pages 项目名      （默认：wrangler.toml 的 name）
  --bucket-name <名称>    R2 桶名，只能小写字母/数字/连字符（默认：wrangler.toml 的 bucket_name）
  --branch <分支>         部署分支，生产环境用 main     （默认：main）
  --password <口令>       写操作口令，会写入 Pages 项目 Secret ADMIN_PASSWORD
                          （默认：读环境变量 ADMIN_PASSWORD；都没有则交互式询问）
  --skip-secret           不设置 ADMIN_PASSWORD
  --skip-build            跳过构建，直接部署已有的 build/ 目录
  --dry-run               只打印将要执行的操作，不实际执行
  -h, --help              显示本帮助

环境变量
  CLOUDFLARE_API_TOKEN    Cloudflare API 令牌（需 Pages:Edit；自动建桶还需 Workers R2 Storage:Edit）
  CLOUDFLARE_ACCOUNT_ID   账号 ID（账号下有多个账号时建议设置）
  ADMIN_PASSWORD          写操作口令
`.trim();

function parseArgs(argv) {
  const options = {
    projectName: null,
    bucketName: null,
    branch: "main",
    password: process.env.ADMIN_PASSWORD || null,
    skipSecret: false,
    skipBuild: false,
    dryRun: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      const value = argv[i + 1];
      if (!value || value.startsWith("--")) die(`${arg} 后面缺少取值`);
      i += 1;
      return value;
    };
    switch (arg) {
      case "--project-name": options.projectName = next(); break;
      case "--bucket-name": options.bucketName = next(); break;
      case "--branch": options.branch = next(); break;
      case "--password": options.password = next(); break;
      case "--skip-secret": options.skipSecret = true; break;
      case "--skip-build": options.skipBuild = true; break;
      case "--dry-run": options.dryRun = true; break;
      case "-h":
      case "--help": console.log(HELP); process.exit(0); break;
      default: die(`未知参数：${arg}（用 --help 查看用法）`);
    }
  }
  return options;
}

// ---------- wrangler.toml 读写 ----------

function readWranglerToml() {
  if (!fs.existsSync(wranglerToml)) die("找不到 wrangler.toml，请在项目根目录执行本脚本。");
  const text = fs.readFileSync(wranglerToml, "utf8");
  const name = text.match(/^\s*name\s*=\s*"([^"]*)"/m)?.[1];
  const bucket = text.match(/^\s*bucket_name\s*=\s*"([^"]*)"/m)?.[1];
  return { text, name, bucket };
}

/** 把项目名/桶名写回 wrangler.toml（wrangler 只认这个文件，没有命令行开关）。 */
function applyNames(toml, projectName, bucketName, dryRun) {
  let next = toml;
  const changes = [];

  if (projectName !== null && projectName !== undefined) {
    const updated = next.replace(/^(\s*name\s*=\s*")[^"]*(")/m, `$1${projectName}$2`);
    if (updated !== next) {
      next = updated;
      changes.push(`name → ${projectName}`);
    }
  }
  if (bucketName !== null && bucketName !== undefined) {
    const updated = next.replace(/^(\s*bucket_name\s*=\s*")[^"]*(")/m, `$1${bucketName}$2`);
    if (updated !== next) {
      next = updated;
      changes.push(`bucket_name → ${bucketName}`);
    }
  }

  if (changes.length && !dryRun) fs.writeFileSync(wranglerToml, next, "utf8");
  return changes;
}

// ---------- 主流程 ----------

function assertBucketName(name) {
  if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(name)) {
    die(`R2 桶名不合法：${name}。只允许小写字母、数字、连字符，长度 3–63 位，且不能以连字符开头或结尾。`);
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const toml = readWranglerToml();

  const projectName = options.projectName || toml.name;
  const bucketName = options.bucketName || toml.bucket;
  if (!projectName) die("无法确定 Pages 项目名：wrangler.toml 里没有 name，也没有传 --project-name。");
  if (!bucketName) die("无法确定 R2 桶名：wrangler.toml 里没有 bucket_name，也没有传 --bucket-name。");
  assertBucketName(bucketName);

  console.log("\x1b[1mWabdav-2022 → Cloudflare Pages 一键部署\x1b[0m");
  log.info(`Pages 项目：${projectName}`);
  log.info(`R2 桶　　：${bucketName}`);
  log.info(`分支　　 ：${options.branch}`);
  if (options.dryRun) log.warn("dry-run 模式：只打印，不执行");

  const changed = applyNames(toml.text, projectName, bucketName, options.dryRun);
  if (changed.length) {
    log.info(`${options.dryRun ? "[dry-run] 将同步 wrangler.toml：" : "已同步 wrangler.toml："}${changed.join("，")}`);
  }

  // 1. 凭据
  log.step("检查 Cloudflare 凭据");
  const hasToken = Boolean(process.env.CLOUDFLARE_API_TOKEN);
  if (hasToken) {
    log.ok("使用环境变量 CLOUDFLARE_API_TOKEN");
  } else {
    const whoami = run("npx wrangler whoami", { capture: true });
    if (whoami.code !== 0) {
      die(
        "没有可用的 Cloudflare 凭据。请二选一：\n" +
          "    a) 设置环境变量 CLOUDFLARE_API_TOKEN（推荐，需 Pages:Edit 权限）\n" +
          "    b) 先在本机执行 npx wrangler login 完成浏览器授权"
      );
    }
    log.ok("使用本机已有的 wrangler 登录态");
  }

  // 2. R2 桶
  log.step(`确保 R2 桶存在：${bucketName}`);
  const bucketInfo = run(`npx wrangler r2 bucket info ${bucketName}`, { capture: true });
  if (bucketInfo.code === 0) {
    log.ok("桶已存在");
  } else if (options.dryRun) {
    log.info(`[dry-run] npx wrangler r2 bucket create ${bucketName}`);
  } else {
    log.info("桶不存在，创建中…");
    if (run(`npx wrangler r2 bucket create ${bucketName}`).code !== 0) {
      die("创建 R2 桶失败。请确认令牌带有 Workers R2 Storage:Edit 权限。");
    }
    log.ok("桶已创建");
  }

  // 3. Pages 项目
  log.step(`确保 Pages 项目存在：${projectName}`);
  const projectList = run("npx wrangler pages project list", { capture: true });
  const exists = projectList.code === 0 && new RegExp(`(^|\\s)${projectName}(\\s|$)`, "m").test(projectList.stdout);
  if (exists) {
    log.ok("项目已存在");
  } else if (options.dryRun) {
    log.info(`[dry-run] npx wrangler pages project create ${projectName} --production-branch ${options.branch}`);
  } else {
    log.info("项目不存在，创建中…");
    if (run(`npx wrangler pages project create ${projectName} --production-branch ${options.branch}`).code !== 0) {
      die("创建 Pages 项目失败。请确认令牌带有 Cloudflare Pages:Edit 权限。");
    }
    log.ok("项目已创建");
  }

  // 4. 写操作口令
  if (options.skipSecret) {
    log.step("跳过设置写操作口令（--skip-secret）");
    log.warn("未配置 ADMIN_PASSWORD 时，所有写操作会返回 503（只读浏览不受影响）");
  } else {
    log.step("设置写操作口令 ADMIN_PASSWORD");
    let password = options.password;
    if (!password) {
      log.info("口令用于「上传 / 新建文件夹 / 删除」等写操作，建议 ≥ 20 位随机串。");
      password = (await ask("  请输入口令（回车留空则跳过）：")).trim();
    }
    if (!password) {
      log.warn("未输入口令，跳过。之后可用 wrangler pages secret put 补上。");
    } else if (options.dryRun) {
      log.info("[dry-run] npx wrangler pages secret put ADMIN_PASSWORD --project-name …");
    } else {
      const code = runWithInput(
        `npx wrangler pages secret put ADMIN_PASSWORD --project-name ${projectName}`,
        password
      );
      if (code !== 0) die("写入 ADMIN_PASSWORD 失败。");
      log.ok("口令已写入（存为加密 Secret，不会出现在构建日志里）");
    }
  }

  // 5. 构建
  if (options.skipBuild) {
    log.step("跳过构建（--skip-build）");
    if (!fs.existsSync(buildDir)) die("build/ 目录不存在，请去掉 --skip-build 先构建一次。");
  } else {
    log.step("构建");
    if (options.dryRun) {
      log.info("[dry-run] npm run build");
    } else if (run("npm run build").code !== 0) {
      die("构建失败。请先修复错误再部署。");
    } else {
      log.ok("构建完成");
    }
  }

  // 6. 部署
  log.step("部署到 Cloudflare Pages");
  const deployCmd = `npx wrangler pages deploy build --project-name ${projectName} --branch ${options.branch}`;
  if (options.dryRun) {
    log.info(`[dry-run] ${deployCmd}`);
    console.log("\n\x1b[1m干跑结束。去掉 --dry-run 即可真正部署。\x1b[0m");
    return;
  }
  if (run(deployCmd).code !== 0) die("部署失败。");

  console.log("\n\x1b[32m\x1b[1m部署完成\x1b[0m");
  log.info(`访问地址：https://${projectName}.pages.dev （自定义域名可在 Pages 项目里绑定）`);
  log.info("首次部署后建议立刻做的事：");
  log.info("  ① 确认 R2 桶未开启公共访问（公共开发域名会让鉴权全部失效）");
  log.info("  ② 给自定义域开启 Always Use HTTPS（Basic 凭据是明文头）");
  log.info(`  ③ 到 https://dash.cloudflare.com 给 /api/* 加一条限速规则`);
}

main().catch((error) => die(error?.message || String(error)));
