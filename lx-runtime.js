"use strict";

/**
 * Minimal, dependency-free host runtime for LX Music (洛雪音乐) source scripts.
 *
 * A source script is a plain .js file that talks to the host through `globalThis.lx`:
 *   const { EVENT_NAMES, request, on, send, utils, env, version } = globalThis.lx
 *   send(EVENT_NAMES.inited, { sources: { kw: { name, type, actions, qualitys } } })
 *   on(EVENT_NAMES.request, ({ source, action, info }) => Promise<result>)
 *
 * `lx.request` in the wild is CALLBACK based: request(url, options, (err, resp) => {}).
 * Some scripts use the Promise form instead. We support both: the function always
 * returns a Promise and additionally invokes the callback when one is supplied.
 * `resp.body` is auto-parsed JSON (LX desktop behaves this way), with `resp.raw`
 * always holding the original text.
 */

const vm = require("node:vm");
const crypto = require("node:crypto");
const zlib = require("node:zlib");
const { Buffer } = require("node:buffer");

const DEFAULT_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

function clamp(n, min, max, fallback) {
  const v = Number(n);
  return Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback;
}

/** Block requests to loopback / link-local / private networks (basic SSRF guard). */
function isBlockedHost(hostname) {
  const h = String(hostname || "").toLowerCase().replace(/^\[|\]$/g, "");
  if (!h) return true;
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local")) return true;
  if (h === "::1" || h.startsWith("fd") || h.startsWith("fe80")) return true;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h)) {
    const p = h.split(".").map(Number);
    if (p[0] === 10 || p[0] === 127 || p[0] === 0) return true;
    if (p[0] === 192 && p[1] === 168) return true;
    if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return true;
    if (p[0] === 169 && p[1] === 254) return true;
    if (p[0] === 100 && p[1] >= 64 && p[1] <= 127) return true;
  }
  return false;
}

function parseResponseBody(text, contentType) {
  const trimmed = typeof text === "string" ? text.trim() : "";
  const looksJson =
    String(contentType || "").toLowerCase().includes("json") ||
    trimmed.startsWith("{") ||
    trimmed.startsWith("[");
  if (looksJson && trimmed) {
    try {
      return JSON.parse(trimmed);
    } catch {
      /* fall through to raw text */
    }
  }
  return text;
}

function serializeBody(body, headers) {
  if (body === undefined || body === null) return undefined;
  if (typeof body === "string" || Buffer.isBuffer(body)) return body;
  if (!headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json; charset=utf-8");
  }
  return JSON.stringify(body);
}

function buildUtils() {
  const digest = (alg, data, encoding = "hex") =>
    crypto.createHash(alg).update(toBytes(data)).digest(encoding);

  function toBytes(data) {
    if (Buffer.isBuffer(data)) return data;
    if (data instanceof ArrayBuffer) return Buffer.from(data);
    if (typeof data === "object" && data !== null) return Buffer.from(JSON.stringify(data));
    return Buffer.from(String(data ?? ""));
  }

  const cryptoUtils = {
    md5: (d, e) => digest("md5", d, e),
    sha1: (d, e) => digest("sha1", d, e),
    sha256: (d, e) => digest("sha256", d, e),
    sha512: (d, e) => digest("sha512", d, e),
    createHash: (alg) => crypto.createHash(alg),
    createHmac: (alg, key) => crypto.createHmac(alg, key),
    randomBytes: (n) => crypto.randomBytes(n),
    randomUUID: () => crypto.randomUUID(),
    aesEncrypt: (data, key, iv, algorithm = "aes-128-cbc") => {
      const cipher = crypto.createCipheriv(algorithm, toBytes(key), toBytes(iv));
      return Buffer.concat([cipher.update(toBytes(data)), cipher.final()]);
    },
    aesDecrypt: (data, key, iv, algorithm = "aes-128-cbc") => {
      const decipher = crypto.createDecipheriv(algorithm, toBytes(key), toBytes(iv));
      return Buffer.concat([decipher.update(toBytes(data)), decipher.final()]);
    },
    rsaEncrypt: (data, publicKey) => crypto.publicEncrypt(publicKey, toBytes(data)),
    base64Encode: (d) => toBytes(d).toString("base64"),
    base64Decode: (d) => Buffer.from(String(d), "base64"),
  };

  return {
    buffer: Buffer,
    Buffer,
    crypto: cryptoUtils,
    zlib: {
      gzipSync: zlib.gzipSync,
      gunzipSync: zlib.gunzipSync,
      deflateSync: zlib.deflateSync,
      inflateSync: zlib.inflateSync,
    },
    base64: {
      encode: (d) => toBytes(d).toString("base64"),
      decode: (d) => Buffer.from(String(d), "base64"),
    },
  };
}

function buildConsole(label, sink) {
  const write = (level, args) => {
    const text = args
      .map((a) => {
        if (typeof a === "string") return a;
        try {
          return JSON.stringify(a);
        } catch {
          return String(a);
        }
      })
      .join(" ");
    sink?.(level, `[${label}] ${text}`.slice(0, 800));
  };
  return {
    log: (...a) => write("log", a),
    info: (...a) => write("info", a),
    warn: (...a) => write("warn", a),
    error: (...a) => write("error", a),
    debug: (...a) => write("debug", a),
    group: () => {},
    groupCollapsed: () => {},
    groupEnd: () => {},
    table: () => {},
    trace: () => {},
    time: () => {},
    timeEnd: () => {},
    assert: () => {},
  };
}

function withTimeout(promise, ms, message) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message || "timeout")), ms);
    Promise.resolve(promise).then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      }
    );
  });
}

/**
 * Load one LX source script into an isolated vm context.
 * Returns a runtime object with `inited`, `dispatch()` and `dispose()`.
 */
function createRuntime(code, meta = {}) {
  const id = String(meta.id || "script");
  const label = meta.name || id;
  const logs = [];
  const sink = (level, text) => {
    logs.push({ level, text, at: Date.now() });
    if (logs.length > 100) logs.shift();
  };

  const handlers = new Map();
  let inited = null;
  let resolveInited;
  const initedPromise = new Promise((r) => {
    resolveInited = r;
  });
  let pendingResponse = null;

  const on = (event, handler) => {
    const key = String(event);
    if (!handlers.has(key)) handlers.set(key, []);
    handlers.get(key).push(handler);
    return () => {
      const list = handlers.get(key) || [];
      const i = list.indexOf(handler);
      if (i >= 0) list.splice(i, 1);
    };
  };

  const send = (event, data) => {
    const key = String(event);
    if (key === "inited") {
      inited = data || null;
      resolveInited(inited);
      return;
    }
    if (/response|result|callback/i.test(key) && pendingResponse) {
      const fn = pendingResponse;
      pendingResponse = null;
      fn(data);
      return;
    }
    sink("info", `send(${key}) ${JSON.stringify(data)?.slice(0, 200) ?? ""}`);
  };

  const doFetch = async (rawUrl, options) => {
    const u = new URL(String(rawUrl));
    if (u.protocol !== "http:" && u.protocol !== "https:") {
      throw new Error(`Unsupported protocol: ${u.protocol}`);
    }
    if (isBlockedHost(u.hostname)) throw new Error(`Blocked host: ${u.hostname}`);

    const headers = new Headers(
      options.headers && typeof options.headers === "object" ? options.headers : {}
    );
    if (!headers.has("User-Agent")) headers.set("User-Agent", DEFAULT_UA);
    const body = serializeBody(options.body, headers);
    const method = String(options.method || (body ? "POST" : "GET")).toUpperCase();
    const timeout = clamp(options.timeout, 500, 30000, 10000);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const res = await fetch(u.toString(), {
        method,
        headers,
        body: method === "GET" || method === "HEAD" ? undefined : body,
        redirect: "follow",
        signal: controller.signal,
      });
      if (isBlockedHost(new URL(res.url || u.toString()).hostname)) {
        throw new Error("Blocked redirect target");
      }
      const text = await res.text();
      const contentType = res.headers.get("content-type") || "";
      return {
        statusCode: res.status,
        statusMessage: res.statusText || "",
        headers: Object.fromEntries(res.headers.entries()),
        body: parseResponseBody(text, contentType),
        raw: text,
      };
    } catch (e) {
      if (e?.name === "AbortError") throw new Error(`Request timeout (${timeout}ms)`);
      throw e;
    } finally {
      clearTimeout(timer);
    }
  };

  const request = (rawUrl, options, callback) => {
    if (typeof options === "function") {
      callback = options;
      options = {};
    }
    const promise = doFetch(rawUrl, options || {});
    // Scripts commonly ignore the returned Promise when they pass a callback.
    // Attach a no-op rejection handler so a failed upstream cannot crash the host.
    promise.catch(() => {});
    if (typeof callback === "function") {
      promise.then(
        (resp) => {
          try {
            callback(null, resp);
          } catch (e) {
            sink("warn", `request callback threw: ${e.message}`);
          }
        },
        (err) => {
          try {
            callback(err, null);
          } catch (e) {
            sink("warn", `request error callback threw: ${e.message}`);
          }
        }
      );
    }
    return promise;
  };

  const EVENT_NAMES = new Proxy(
    {},
    {
      get: (_t, key) => (typeof key === "symbol" ? key : String(key)),
      has: () => true,
    }
  );

  const lx = {
    EVENT_NAMES,
    on,
    send,
    request,
    utils: buildUtils(),
    env: meta.env || "desktop",
    version: meta.version || "2.0.0",
    currentScriptInfo: { name: label, id, version: meta.version || "2.0.0" },
  };

  const sandbox = {
    lx,
    console: buildConsole(label, sink),
    Buffer,
    URL,
    URLSearchParams,
    TextEncoder,
    TextDecoder,
    AbortController,
    AbortSignal,
    Headers,
    fetch,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    setImmediate,
    clearImmediate,
    queueMicrotask,
    atob: (s) => Buffer.from(String(s), "base64").toString("binary"),
    btoa: (s) => Buffer.from(String(s), "binary").toString("base64"),
    crypto: crypto.webcrypto,
    process: { env: {}, platform: "linux", version: process.version },
  };
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  sandbox.global = sandbox;
  sandbox.globalThis = sandbox;

  const context = vm.createContext(sandbox, {
    name: `lx-source:${id}`,
    codeGeneration: { strings: true, wasm: false },
  });

  const compiled = new vm.Script(String(code), { filename: `${id}.js` });
  compiled.runInContext(context, { timeout: 5000 });

  const runtime = {
    id,
    name: label,
    origin: meta.origin || "local",
    logs,
    get inited() {
      return inited;
    },
    get handlers() {
      return Object.fromEntries(
        [...handlers.entries()].map(([k, v]) => [k, v.length])
      );
    },
    /** Wait for the script to register its `inited` payload. */
    async waitForInit(ms = 7000) {
      if (inited) return inited;
      try {
        return await withTimeout(initedPromise, ms, "inited timeout");
      } catch {
        return null;
      }
    },
    /** Registered sources, e.g. { wy: { actions: ["musicUrl"], qualitys: [...] } }. */
    sources() {
      return inited?.sources && typeof inited.sources === "object"
        ? inited.sources
        : {};
    },
    /** Invoke on(EVENT_NAMES.request, handler) and await its result. */
    async dispatch(payload, ms = 12000) {
      const list = handlers.get("request") || [];
      if (!list.length) throw new Error("Script has no request handler");

      let lastError = null;
      for (const handler of list) {
        try {
          const result = await withTimeout(
            Promise.resolve().then(() => handler(payload)),
            ms,
            "Script request timed out"
          );
          if (result !== undefined && result !== null) return result;
        } catch (e) {
          lastError = e;
        }
      }

      // Some scripts answer through send(EVENT_NAMES.response, data) instead.
      if (pendingResponse === null) {
        const viaSend = await Promise.race([
          new Promise((resolve) => {
            pendingResponse = resolve;
          }),
          new Promise((resolve) => setTimeout(() => resolve(undefined), 150)),
        ]);
        pendingResponse = null;
        if (viaSend !== undefined) return viaSend;
      }

      throw lastError || new Error("Script returned no result");
    },
    dispose() {
      handlers.clear();
    },
  };

  return runtime;
}

module.exports = {
  createRuntime,
  isBlockedHost,
  parseResponseBody,
  DEFAULT_UA,
};
