/**
 * 共用工具：HTTP 抓取、文本清洗、不透明令牌、CORS。
 *
 * 与 Node 版的差异：
 *   - 没有 node:crypto，改用 Web Crypto / btoa 生成不透明令牌；
 *   - 令牌是**无状态**的（URL 本身编进令牌），因为 Worker 实例随时会被回收，
 *     内存表在多个 isolate 之间并不共享。
 */

export const DEFAULT_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

export const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Range",
  "Access-Control-Expose-Headers": "Content-Length, Content-Range, Accept-Ranges",
};

const TIMEOUT = 12000;

const PRIVATE_HOST =
  /^(localhost|127\.|0\.0\.0\.0|10\.|192\.168\.|169\.254\.|::1$|\[::1\]$)|^172\.(1[6-9]|2\d|3[01])\./i;

export function isBlockedHost(hostname) {
  return PRIVATE_HOST.test(String(hostname || ""));
}

export async function fetchText(url, headers = {}, timeout = TIMEOUT) {
  const u = new URL(url);
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("只支持 http(s)");
  if (isBlockedHost(u.hostname)) throw new Error(`不允许的地址: ${u.hostname}`);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(u.toString(), {
      headers: { "User-Agent": DEFAULT_UA, Accept: "*/*", ...headers },
      redirect: "follow",
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

export function json(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...CORS_HEADERS,
      ...extraHeaders,
    },
  });
}

// ---------------------------------------------------------------------------
// 不透明令牌：把目标地址编码进令牌本身，任何实例都能还原
// ---------------------------------------------------------------------------

function toBase64Url(text) {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(token) {
  const padded = token.replace(/-/g, "+").replace(/_/g, "/");
  const pad = (4 - (padded.length % 4)) % 4;
  const binary = atob(padded + "=".repeat(pad));
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

export function makeToken(url, prefix = "px") {
  if (!url) return "";
  return prefix + toBase64Url(url);
}

export function readToken(token, prefix = "px") {
  const raw = String(token || "");
  if (!raw.startsWith(prefix)) return null;
  try {
    const url = fromBase64Url(raw.slice(prefix.length));
    return /^https?:\/\//i.test(url) ? url : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// 文本清洗
// ---------------------------------------------------------------------------

const ENTITIES = { nbsp: " ", amp: "&", quot: '"', apos: "'", lt: "<", gt: ">" };

export function decodeEntities(value) {
  return String(value ?? "")
    .replace(/<[^>]*>/g, "")
    .replace(/&(#[xX]?[0-9a-fA-F]+|[a-zA-Z]+);/g, (m, code) => {
      if (code[0] === "#") {
        const n =
          code[1] === "x" || code[1] === "X"
            ? parseInt(code.slice(2), 16)
            : parseInt(code.slice(1), 10);
        return Number.isFinite(n) ? String.fromCodePoint(n) : m;
      }
      const v = ENTITIES[code.toLowerCase()];
      return v !== undefined ? v : m;
    })
    .replace(/\s+/g, " ")
    .trim();
}

/** 酷我接口会把中文转义成 \\u0026 这种形式，且可能叠加多层反斜杠。 */
export function unescapeUnicode(value) {
  return String(value ?? "")
    .replace(/\\+u([0-9a-fA-F]{4})/g, (_m, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\'/g, "'")
    .replace(/\\\\/g, "\\");
}

export function splitArtists(value) {
  if (Array.isArray(value)) {
    return value
      .map((v) => (typeof v === "string" ? v : v?.name))
      .filter(Boolean)
      .map((v) => decodeEntities(v));
  }
  return decodeEntities(value)
    .split(/[&、,，/;；]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** 把 http 地址升级成 https：页面是 https，明文音频会被浏览器拦。 */
export function preferHttps(url) {
  return /^http:\/\//i.test(String(url || "")) ? String(url).replace(/^http:/i, "https:") : url;
}

/** 轻量探测：只取 1 字节，判断这个地址是否真的可播。 */
export async function probePlayable(url, timeout = 6000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: { "User-Agent": DEFAULT_UA, Accept: "*/*", Range: "bytes=0-1" },
      redirect: "manual",
      signal: controller.signal,
    });
    try {
      await res.body?.cancel?.();
    } catch {
      /* 忽略取消异常 */
    }
    return res.status >= 200 && res.status < 400;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}
