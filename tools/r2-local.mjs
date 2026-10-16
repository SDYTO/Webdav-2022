/**
 * 本地 R2 模拟层（仅用于本地预览，不参与部署）。
 *
 * 为什么需要它：本机的 workerd 运行时无法启动（Windows 缺少 VC++ 运行库，
 * 表现为 access violation），wrangler pages dev 用不了。为了让"本地预览"
 * 能真正验证后端逻辑，这里按 R2 的接口语义实现一个文件系统后端。
 *
 * 覆盖本项目用到的全部 API：
 *   get(key[, {range}]) / head(key) / put / delete
 *   list({prefix, delimiter, cursor, limit, include})
 *   createMultipartUpload / resumeMultipartUpload(uploadPart/complete/abort)
 *
 * 存储布局（默认在系统临时目录，见 local-preview.mjs 的 stateDir）：
 *   objects/<encodeURIComponent(key)>.bin        对象内容
 *   objects/<encodeURIComponent(key)>.meta.json  httpMetadata / customMetadata
 *   multipart/<uploadId>/<partNumber>.bin        分块上传中转
 * 用扁平编码而非目录树：R2 允许 "foo" 与 "foo/bar" 同时存在，
 * 而文件系统里同名文件与目录互斥，目录树会破坏本项目的目录标记语义。
 */

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { Readable } from "node:stream";

const DEFAULT_LIST_LIMIT = 1000;

function encodeKey(key) {
  return encodeURIComponent(key);
}

function decodeKey(encoded) {
  return decodeURIComponent(encoded);
}

function toWebStream(buffer) {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(buffer));
      controller.close();
    },
  });
}

/**
 * 组装 R2ObjectBody：除元数据外还必须有 body 流与
 * json/text/arrayBuffer/blob/bytes 这些读取方法 —— 业务代码（如回收站元数据）
 * 直接调 object.json()，缺了就会静默失败。
 */
function makeBody(object, buffer) {
  return {
    ...object,
    body: toWebStream(buffer),
    async arrayBuffer() {
      return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
    },
    async text() {
      return buffer.toString("utf8");
    },
    async json() {
      return JSON.parse(buffer.toString("utf8"));
    },
    async blob() {
      return new Blob([buffer]);
    },
    async bytes() {
      return new Uint8Array(buffer);
    },
  };
}

/** 把各种可能的请求体形态收敛成 Buffer。 */
async function readBody(body) {
  if (body === null || body === undefined) return Buffer.alloc(0);
  if (Buffer.isBuffer(body)) return body;
  if (body instanceof Uint8Array) return Buffer.from(body);
  if (body instanceof ArrayBuffer) return Buffer.from(body);
  if (typeof body === "string") return Buffer.from(body);
  if (typeof body.arrayBuffer === "function") {
    return Buffer.from(await body.arrayBuffer());
  }
  if (typeof body.getReader === "function") {
    const chunks = [];
    for await (const chunk of Readable.fromWeb(body)) chunks.push(chunk);
    return Buffer.concat(chunks);
  }
  if (typeof body[Symbol.asyncIterator] === "function") {
    const chunks = [];
    for await (const chunk of body) chunks.push(chunk);
    return Buffer.concat(chunks);
  }
  throw new TypeError("不支持的请求体类型");
}

function etagFor(buffer) {
  return `"${crypto.createHash("md5").update(buffer).digest("hex")}"`;
}

/** 把 R2 的 range 参数（Headers 或 {offset,length}/{suffix}）解析成字节区间。 */
function resolveRange(spec, size) {
  if (!spec) return null;
  if (typeof spec.get === "function") {
    const header = spec.get("range");
    if (!header) return null;
    const match = /^bytes=(\d*)-(\d*)$/.exec(String(header).trim());
    if (!match) return null;
    const [, rawStart, rawEnd] = match;
    if (rawStart === "" && rawEnd === "") return null;
    if (rawStart === "") {
      const suffix = Number(rawEnd);
      if (!Number.isFinite(suffix) || suffix <= 0) return null;
      const offset = Math.max(size - suffix, 0);
      return { offset, length: size - offset, shape: { suffix } };
    }
    const offset = Number(rawStart);
    if (!Number.isFinite(offset) || offset >= size) return null;
    const end = rawEnd === "" ? size - 1 : Math.min(Number(rawEnd), size - 1);
    if (!Number.isFinite(end) || end < offset) return null;
    const length = end - offset + 1;
    return { offset, length, shape: { offset, length } };
  }
  if (typeof spec.suffix === "number") {
    const offset = Math.max(size - spec.suffix, 0);
    return { offset, length: size - offset, shape: { suffix: spec.suffix } };
  }
  if (spec.offset !== undefined || spec.length !== undefined) {
    const offset = spec.offset ?? 0;
    const length = Math.min(spec.length ?? size - offset, size - offset);
    return { offset, length, shape: { offset, length } };
  }
  return null;
}

export class LocalR2Bucket {
  /** @param {string} root 存储根目录 */
  constructor(root) {
    this.root = root;
    this.objectsDir = path.join(root, "objects");
    this.multipartDir = path.join(root, "multipart");
    fs.mkdirSync(this.objectsDir, { recursive: true });
    fs.mkdirSync(this.multipartDir, { recursive: true });
  }

  #binPath(key) {
    return path.join(this.objectsDir, `${encodeKey(key)}.bin`);
  }

  #metaPath(key) {
    return path.join(this.objectsDir, `${encodeKey(key)}.meta.json`);
  }

  #readMetaSync(key) {
    try {
      return JSON.parse(fs.readFileSync(this.#metaPath(key), "utf8"));
    } catch {
      return { httpMetadata: null, customMetadata: null };
    }
  }

  #describe(key, stat, meta) {
    const bufferSize = stat.size;
    return {
      key,
      size: bufferSize,
      uploaded: stat.mtime,
      httpEtag: meta.etag || `"${stat.mtimeMs.toString(16)}"`,
      etag: (meta.etag || "").replace(/"/g, ""),
      httpMetadata: meta.httpMetadata || undefined,
      customMetadata: meta.customMetadata || undefined,
      range: undefined,
    };
  }

  async get(key, options = {}) {
    const stat = await this.#statOrNull(key);
    if (!stat) return null;
    const meta = this.#readMetaSync(key);
    const whole = await fsp.readFile(this.#binPath(key));
    const total = whole.length;

    const range = resolveRange(options.range, total);
    const slice = range ? whole.subarray(range.offset, range.offset + range.length) : whole;

    const object = this.#describe(key, stat, meta);
    // 与 R2 一致：size 始终是对象整体大小，range 单独说明本次返回的是哪一段
    object.size = total;
    if (range) object.range = range.shape;

    return makeBody(object, slice);
  }

  async head(key) {
    const stat = await this.#statOrNull(key);
    if (!stat) return null;
    return this.#describe(key, stat, this.#readMetaSync(key));
  }

  async put(key, value, options = {}) {
    const buffer = await readBody(value);
    await fsp.writeFile(this.#binPath(key), buffer);
    const httpMetadata = options.httpMetadata ?? null;
    const customMetadata = options.customMetadata ?? null;
    const meta = { httpMetadata, customMetadata, etag: etagFor(buffer) };
    await fsp.writeFile(this.#metaPath(key), JSON.stringify(meta), "utf8");
    const stat = await fsp.stat(this.#binPath(key));
    return this.#describe(key, stat, meta);
  }

  async delete(key) {
    await fsp.rm(this.#binPath(key), { force: true });
    await fsp.rm(this.#metaPath(key), { force: true });
  }

  async #statOrNull(key) {
    try {
      const stat = await fsp.stat(this.#binPath(key));
      return stat.isFile() ? stat : null;
    } catch {
      return null;
    }
  }

  async #allKeys() {
    const names = await fsp.readdir(this.objectsDir);
    return names
      .filter((name) => name.endsWith(".bin"))
      .map((name) => decodeKey(name.slice(0, -".bin".length)));
  }

  async list(options = {}) {
    const prefix = options.prefix ?? "";
    const delimiter = options.delimiter;
    const limit = options.limit ?? DEFAULT_LIST_LIMIT;
    const include = options.include ?? [];

    let keys = (await this.#allKeys()).filter((key) => key.startsWith(prefix));
    keys.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

    const delimitedPrefixes = new Set();
    if (delimiter) {
      const plain = [];
      for (const key of keys) {
        const rest = key.slice(prefix.length);
        const at = rest.indexOf(delimiter);
        if (at === -1) plain.push(key);
        else delimitedPrefixes.add(prefix + rest.slice(0, at + delimiter.length));
      }
      keys = plain;
    }

    let start = 0;
    if (options.cursor) {
      const [cursorKey] = String(options.cursor).split("\u0000");
      start = keys.findIndex((key) => key > cursorKey);
      if (start === -1) start = keys.length;
    }
    const page = keys.slice(start, start + limit);
    const truncated = start + limit < keys.length;

    const objects = [];
    for (const key of page) {
      const stat = await fsp.stat(this.#binPath(key));
      const meta = this.#readMetaSync(key);
      const described = this.#describe(key, stat, meta);
      // include 未声明时不下发元数据，与 R2 行为一致
      if (!include.includes("httpMetadata")) delete described.httpMetadata;
      if (!include.includes("customMetadata")) delete described.customMetadata;
      objects.push(described);
    }

    return {
      objects,
      delimitedPrefixes: [...delimitedPrefixes].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
      truncated,
      cursor: truncated && page.length ? page[page.length - 1] : undefined,
    };
  }

  #multipart(key, uploadId) {
    const dir = path.join(this.multipartDir, uploadId);
    const bucket = this;
    return {
      key,
      uploadId,
      async uploadPart(partNumber, value) {
        const buffer = await readBody(value);
        fs.mkdirSync(dir, { recursive: true });
        await fsp.writeFile(path.join(dir, `${partNumber}.bin`), buffer);
        return { partNumber, etag: etagFor(buffer) };
      },
      async complete(parts) {
        const chunks = [];
        for (const part of parts) {
          chunks.push(await fsp.readFile(path.join(dir, `${part.partNumber}.bin`)));
        }
        const merged = Buffer.concat(chunks);
        const result = await bucket.put(key, merged, {});
        await fsp.rm(dir, { recursive: true, force: true });
        return result;
      },
      async abort() {
        await fsp.rm(dir, { recursive: true, force: true });
      },
    };
  }

  async createMultipartUpload(key, options = {}) {
    const uploadId = crypto.randomUUID().replace(/-/g, "");
    const dir = path.join(this.multipartDir, uploadId);
    fs.mkdirSync(dir, { recursive: true });
    if (options.httpMetadata) {
      // 记录待写入的元数据，complete 时使用
      await fsp.writeFile(
        path.join(dir, "__httpMetadata.json"),
        JSON.stringify(options.httpMetadata),
        "utf8"
      );
    }
    return this.#multipart(key, uploadId);
  }

  resumeMultipartUpload(key, uploadId) {
    return this.#multipart(key, uploadId);
  }
}
