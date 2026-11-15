"use strict";

/**
 * LX Music (洛雪音乐) .js 音源脚本 → HTTP 接口 包装服务
 *
 * 单端口、零外部依赖（只用 Node 内置模块），对外提供 GD Studio 兼容的
 * `GET /api.php?types=url&source=wy&id=xxx&br=320` 接口，可直接填进
 * otter-music 的 /admin → 音源管理。
 *
 * 设计取舍：
 *  - 洛雪脚本只被当作「取播放直链」的后端（大多数脚本也只实现 musicUrl）；
 *  - 脚本不支持的类型（search / pic / lyric 等）返回 404，让调用方继续回退到
 *    列表里的下一个上游，而不是返回 200 + 空数组把后面的音源挡住。
 */

const http = require("node:http");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { Readable } = require("node:stream");
const { pipeline } = require("node:stream/promises");
const { createRuntime, isBlockedHost, DEFAULT_UA } = require("./lx-runtime");
const { searchNative, hasNativeSearch, nativeSearchSources, readPicToken } = require("./search-apis");

// 脚本里的异步异常不应该拖垮整个进程。
process.on("unhandledRejection", (e) => {
  console.warn("[unhandledRejection]", String(e?.message || e).slice(0, 200));
});
process.on("uncaughtException", (e) => {
  console.error("[uncaughtException]", String(e?.stack || e).slice(0, 400));
});

const ROOT = __dirname;
const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || "0.0.0.0";

const DEFAULTS = {
  adminToken: "",
  env: "desktop",
  version: "2.0.0",
  timeoutMs: 12000,
  initTimeoutMs: 8000,
  urlCacheTtlMs: 5 * 60 * 1000,
  proxyStream: false,
  fallbackApi: "",
  sourceUrls: [],
  priority: [],
};

function loadConfig() {
  let file = {};
  try {
    file = JSON.parse(fs.readFileSync(path.join(ROOT, "config.json"), "utf8"));
  } catch {
    /* config.json 可选 */
  }
  const cfg = { ...DEFAULTS, ...file };
  if (process.env.ADMIN_TOKEN) cfg.adminToken = process.env.ADMIN_TOKEN;
  if (process.env.LX_SOURCE_URLS) {
    cfg.sourceUrls = String(process.env.LX_SOURCE_URLS)
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }
  if (process.env.LX_PROXY_STREAM) cfg.proxyStream = /^(1|true|yes)$/i.test(process.env.LX_PROXY_STREAM);
  return cfg;
}

const config = loadConfig();
const startedAt = Date.now();

// ---------------------------------------------------------------------------
// 脚本注册表
// ---------------------------------------------------------------------------

/** @type {Array<ReturnType<typeof createRuntime>>} */
const runtimes = [];
const runtimeErrors = [];

function baseUrlOf(req) {
  const proto = (req.headers["x-forwarded-proto"] || "http").toString().split(",")[0].trim();
  const host = (req.headers["x-forwarded-host"] || req.headers.host || `localhost:${PORT}`)
    .toString()
    .split(",")[0]
    .trim();
  return `${proto}://${host}`;
}

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

/** 加载单个脚本并等待它注册 inited。 */
async function loadScript(code, meta) {
  let rt;
  try {
    rt = createRuntime(code, {
      id: meta.id,
      name: meta.name,
      origin: meta.origin,
      env: config.env,
      version: config.version,
    });
  } catch (e) {
    const msg = `脚本执行失败: ${e.message}`;
    runtimeErrors.push({ id: meta.id, origin: meta.origin, error: msg });
    log(`[load] ${meta.id} ✗ ${msg}`);
    return null;
  }

  const inited = await rt.waitForInit(config.initTimeoutMs);
  if (!inited) {
    runtimeErrors.push({ id: meta.id, origin: meta.origin, error: "未收到 inited 事件（脚本可能初始化失败）" });
    log(`[load] ${meta.id} ✗ inited timeout`);
    rt.dispose();
    return null;
  }

  const sources = Object.keys(rt.sources());
  log(`[load] ${meta.id} ✓ sources=${sources.join(",")}`);
  runtimes.push(rt);
  return rt;
}

async function fetchScriptText(url, timeoutMs = 15000) {
  const u = new URL(url);
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("只支持 http(s) 地址");
  if (isBlockedHost(u.hostname)) throw new Error(`不允许的地址: ${u.hostname}`);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(u.toString(), {
      headers: { "User-Agent": DEFAULT_UA },
      redirect: "follow",
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    if (text.length > 2 * 1024 * 1024) throw new Error("脚本超过 2MB 上限");
    return text;
  } finally {
    clearTimeout(timer);
  }
}

function scriptIdFromUrl(url, index) {
  try {
    const u = new URL(url);
    const base = path.basename(u.pathname).replace(/\.js$/i, "") || "script";
    const dir = path.basename(path.dirname(u.pathname)) || "";
    const raw = dir && dir !== "." ? `${dir}-${base}` : base;
    return `${raw}-${index}`.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 60);
  } catch {
    return `script-${index}`;
  }
}

/** 用 URL 猜一个可读名字：.../suyin/latest.js → suyin，.../foo/bar.js → bar */
function scriptNameFromUrl(url) {
  try {
    const u = new URL(url);
    const base = path.basename(u.pathname).replace(/\.js$/i, "");
    const dir = path.basename(path.dirname(u.pathname));
    if (!base || /^latest$/i.test(base)) return dir || base || "script";
    return base;
  } catch {
    return "script";
  }
}

/** 启动时加载：本地 sources/*.js + config.sourceUrls + data/scripts.json 里导入过的脚本。 */
async function bootstrap() {
  const sourcesDir = path.join(ROOT, "sources");
  let localFiles = [];
  try {
    localFiles = (await fsp.readdir(sourcesDir)).filter((f) => f.endsWith(".js")).sort();
  } catch {
    localFiles = [];
  }

  for (const file of localFiles) {
    const full = path.join(sourcesDir, file);
    try {
      const code = await fsp.readFile(full, "utf8");
      await loadScript(code, {
        id: file.replace(/\.js$/i, ""),
        name: file.replace(/\.js$/i, ""),
        origin: `local:${file}`,
      });
    } catch (e) {
      runtimeErrors.push({ id: file, origin: `local:${file}`, error: e.message });
    }
  }

  const urls = [...(config.sourceUrls || [])];
  const persisted = readImportedScripts();
  for (const item of persisted) {
    if (!urls.includes(item.url)) urls.push(item.url);
  }

  const results = await Promise.allSettled(
    urls.map(async (url, i) => {
      const stored = persisted.find((x) => x.url === url);
      const code = await fetchScriptText(url);
      return loadScript(code, {
        id: stored?.id || scriptIdFromUrl(url, i),
        name: stored?.name || scriptNameFromUrl(url),
        origin: url,
      });
    })
  );
  results.forEach((r, i) => {
    if (r.status === "rejected") {
      runtimeErrors.push({ id: `remote-${i}`, origin: urls[i], error: r.reason?.message || String(r.reason) });
      log(`[load] ${urls[i]} ✗ ${r.reason?.message || r.reason}`);
    }
  });

  log(`[boot] 就绪，已加载 ${runtimes.length} 个脚本，失败 ${runtimeErrors.length} 个`);
}

// ---------------------------------------------------------------------------
// 导入脚本的持久化（只存 URL，重启后重新拉取）
// ---------------------------------------------------------------------------

const DATA_DIR = path.join(ROOT, "data");
const IMPORTED_FILE = path.join(DATA_DIR, "scripts.json");

function readImportedScripts() {
  try {
    const raw = JSON.parse(fs.readFileSync(IMPORTED_FILE, "utf8"));
    return Array.isArray(raw) ? raw.filter((x) => x && typeof x.url === "string") : [];
  } catch {
    return [];
  }
}

async function writeImportedScripts(list) {
  await fsp.mkdir(DATA_DIR, { recursive: true });
  await fsp.writeFile(IMPORTED_FILE, JSON.stringify(list, null, 2));
}

// ---------------------------------------------------------------------------
// 音源解析与调用
// ---------------------------------------------------------------------------

const SOURCE_ALIASES = {
  netease: "wy",
  _netease: "wy",
  wy: "wy",
  kugou: "kg",
  kg: "kg",
  kuwo: "kw",
  kw: "kw",
  tencent: "tx",
  qq: "tx",
  qqmusic: "tx",
  tx: "tx",
  migu: "mg",
  mg: "mg",
  bilibili: "bili",
  bili: "bili",
  joox: "joox",
  qs: "qs",
  qsvip: "qsvip",
};

function normalizeSource(source) {
  const key = String(source || "").trim().toLowerCase();
  return SOURCE_ALIASES[key] || key;
}

const QUALITY_ORDER = [
  "128k",
  "192k",
  "320k",
  "flac",
  "flac24bit",
  "24bit",
  "hires",
  "atmos",
  "atmos_plus",
  "master",
  "spatial",
];

function pickQuality(available, br) {
  const list = Array.isArray(available) && available.length ? available : ["128k"];
  const kbps = Number(br) || 128;
  const wanted = kbps >= 740 ? "flac" : kbps >= 256 ? "320k" : kbps >= 160 ? "192k" : "128k";
  if (list.includes(wanted)) return wanted;

  // 向下找最接近的档位，找不到就取列表第一个。
  const wantedIndex = QUALITY_ORDER.indexOf(wanted);
  for (let i = wantedIndex; i >= 0; i--) {
    if (list.includes(QUALITY_ORDER[i])) return QUALITY_ORDER[i];
  }
  for (let i = wantedIndex + 1; i < QUALITY_ORDER.length; i++) {
    if (list.includes(QUALITY_ORDER[i])) return QUALITY_ORDER[i];
  }
  return list[0];
}

function buildMusicInfo(query, source) {
  const id =
    query.get("id") ||
    query.get("songmid") ||
    query.get("hash") ||
    query.get("songId") ||
    query.get("mid") ||
    "";
  const info = {
    id,
    songmid: id,
    songId: id,
    hash: id,
    mid: id,
    strMediaMid: id,
    mediaMid: id,
    copyrightId: id,
    albumId: query.get("album_id") || "",
    album_id: query.get("album_id") || "",
    name: query.get("name") || "",
    singer: query.get("artist") || query.get("singer") || "",
    artist: query.get("artist") || "",
    album: query.get("album") || "",
    source,
  };
  // 允许调用方透传额外的 musicInfo 字段（JSON 字符串）。
  const extra = query.get("musicInfo") || query.get("info");
  if (extra) {
    try {
      Object.assign(info, JSON.parse(extra));
    } catch {
      /* 忽略非法 JSON */
    }
  }
  return info;
}

function candidateRuntimes(source, action) {
  const wanted = normalizeSource(source);
  const list = runtimes.filter((rt) => {
    const s = rt.sources()[wanted];
    if (!s) return false;
    const actions = Array.isArray(s.actions) ? s.actions : [];
    return actions.includes(action);
  });

  if (!config.priority?.length) return list;
  const rank = (rt) => {
    const i = config.priority.indexOf(rt.id);
    return i === -1 ? config.priority.length : i;
  };
  return [...list].sort((a, b) => rank(a) - rank(b));
}

function extractUrl(result) {
  if (!result) return null;
  if (typeof result === "string") return result.trim();
  if (typeof result === "object") {
    for (const key of ["url", "link", "src", "playUrl", "musicUrl"]) {
      const v = result[key];
      if (typeof v === "string" && v.trim()) return v.trim();
    }
  }
  return null;
}

const urlCache = new Map(); // key -> { url, at, script }

function cacheGet(key) {
  const hit = urlCache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > config.urlCacheTtlMs) {
    urlCache.delete(key);
    return null;
  }
  return hit;
}

function cacheSet(key, value) {
  if (urlCache.size > 800) urlCache.clear();
  urlCache.set(key, { ...value, at: Date.now() });
}

/** 依次询问支持该音源的脚本，first success wins。 */
async function resolveMusicUrl(source, musicInfo, quality) {
  const candidates = candidateRuntimes(source, "musicUrl");
  if (!candidates.length) {
    return { ok: false, code: 404, message: `没有脚本声明支持 ${normalizeSource(source)} 的 musicUrl` };
  }

  const cacheKey = `${normalizeSource(source)}|${musicInfo.id}|${quality}`;
  const cached = cacheGet(cacheKey);
  if (cached) return { ok: true, url: cached.url, script: cached.script, cached: true };

  const errors = [];
  for (const rt of candidates) {
    try {
      const result = await rt.dispatch(
        {
          source: normalizeSource(source),
          action: "musicUrl",
          info: { musicInfo, type: quality },
        },
        config.timeoutMs
      );
      const url = extractUrl(result);
      if (!url) {
        errors.push(`${rt.id}: 返回空地址`);
        continue;
      }
      if (!/^https?:\/\//i.test(url)) {
        errors.push(`${rt.id}: 非法地址 ${url.slice(0, 60)}`);
        continue;
      }
      cacheSet(cacheKey, { url, script: rt.id });
      return { ok: true, url, script: rt.id };
    } catch (e) {
      errors.push(`${rt.id}: ${String(e?.message || e).slice(0, 120)}`);
    }
  }

  return { ok: false, code: 502, message: errors.join(" | ") || "所有脚本均取链失败" };
}

// ---------------------------------------------------------------------------
// 播放地址规范化：跟随 302，并把明文 http 升级为 https
// 很多脚本返回的是「跳转器」（如 kwplay.php），它 302 到 http:// CDN。
// HTTPS 页面里的 <audio> 跟随到 http 会被浏览器按混合内容拦截（net::ERR_FAILED）。
// ---------------------------------------------------------------------------

const RESOLVED_URL_TTL = 30 * 60 * 1000;
const resolvedUrlCache = new Map(); // raw url -> { url, at }

async function probeUrl(target, timeoutMs = 6000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(target, {
      method: "GET",
      headers: { "User-Agent": DEFAULT_UA, Accept: "*/*", Range: "bytes=0-1" },
      redirect: "manual",
      signal: controller.signal,
    });
    const status = res.status;
    const location = res.headers.get("location");
    try {
      await res.body?.cancel?.();
    } catch {
      /* 忽略取消异常 */
    }
    return { status, location };
  } finally {
    clearTimeout(timer);
  }
}

async function normalizePlayableUrl(rawUrl, timeoutMs = 6000) {
  const hit = resolvedUrlCache.get(rawUrl);
  if (hit && Date.now() - hit.at < RESOLVED_URL_TTL) return hit.url;

  let current = rawUrl;
  try {
    for (let hop = 0; hop < 5; hop += 1) {
      const probe = await probeUrl(current, timeoutMs);
      if (probe.status >= 300 && probe.status < 400 && probe.location) {
        let next = new URL(probe.location, current).toString();
        if (/^http:\/\//i.test(next)) {
          const upgraded = next.replace(/^http:/i, "https:");
          const up = await probeUrl(upgraded, timeoutMs);
          if (up.status >= 200 && up.status < 400) next = upgraded;
        }
        current = next;
        continue;
      }
      break;
    }
  } catch {
    // 探测失败就退回原始地址，交给浏览器或 /stream 代理
  }

  // 终点仍是明文 http：再试一次 https 变体，成功就让浏览器直连 CDN（省掉隧道带宽）
  if (/^http:\/\//i.test(current)) {
    try {
      const upgraded = current.replace(/^http:/i, "https:");
      const up = await probeUrl(upgraded, timeoutMs);
      if (up.status >= 200 && up.status < 400) current = upgraded;
    } catch {
      /* 保持原地址 */
    }
  }

  if (resolvedUrlCache.size > 2000) resolvedUrlCache.clear();
  resolvedUrlCache.set(rawUrl, { url: current, at: Date.now() });
  return current;
}

// ---------------------------------------------------------------------------
// 取流代理（可选）：把上游地址换成一个稳定的自有地址，顺带解决混合内容
// ---------------------------------------------------------------------------

const streamTokens = new Map(); // token -> { url, at }
const STREAM_TTL = 12 * 60 * 60 * 1000;

function makeStreamToken(url) {
  const token = crypto.createHash("sha256").update(url).digest("hex").slice(0, 32);
  if (streamTokens.size > 5000) streamTokens.clear();
  streamTokens.set(token, { url, at: Date.now() });
  return token;
}

function readStreamToken(token) {
  const hit = streamTokens.get(String(token || ""));
  if (!hit) return null;
  if (Date.now() - hit.at > STREAM_TTL) {
    streamTokens.delete(token);
    return null;
  }
  return hit.url;
}

// ---------------------------------------------------------------------------
// HTTP 工具
// ---------------------------------------------------------------------------

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,DELETE,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Range, X-Admin-Token",
  "Access-Control-Expose-Headers": "Content-Length, Content-Range, Accept-Ranges",
};

function json(res, status, payload, extraHeaders = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(body),
    ...CORS_HEADERS,
    ...extraHeaders,
  });
  res.end(body);
}

function readJsonBody(req, limit = 256 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error("请求体过大"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error("请求体不是合法 JSON"));
      }
    });
    req.on("error", reject);
  });
}

// 轻量限流：每 IP 每分钟 240 次
const rateBuckets = new Map();
function rateLimited(ip) {
  const now = Date.now();
  const bucket = rateBuckets.get(ip) || { count: 0, reset: now + 60000 };
  if (now > bucket.reset) {
    bucket.count = 0;
    bucket.reset = now + 60000;
  }
  bucket.count += 1;
  rateBuckets.set(ip, bucket);
  if (rateBuckets.size > 2000) rateBuckets.clear();
  return bucket.count > 240;
}

function clientIp(req) {
  return (
    String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() ||
    req.socket.remoteAddress ||
    "unknown"
  );
}

// ---------------------------------------------------------------------------
// 路由
// ---------------------------------------------------------------------------

function statusPayload(req) {
  return {
    ok: true,
    service: "lx-http-bridge",
    uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
    scripts: runtimes.map((rt) => ({
      id: rt.id,
      name: rt.name,
      origin: rt.origin,
      sources: Object.fromEntries(
        Object.entries(rt.sources()).map(([k, v]) => [
          k,
          {
            name: v?.name,
            actions: v?.actions || [],
            qualitys: v?.qualitys || [],
          },
        ])
      ),
    })),
    errors: runtimeErrors,
    endpoints: {
      gdStudioCompatible: `${baseUrlOf(req)}/api.php`,
      health: `${baseUrlOf(req)}/health`,
      sources: `${baseUrlOf(req)}/sources`,
    },
    config: {
      proxyStream: config.proxyStream,
      fallbackApi: config.fallbackApi || null,
      timeoutMs: config.timeoutMs,
      nativeSearch: nativeSearchSources,
    },
  };
}

async function handleApi(req, res, url) {
  const query = url.searchParams;
  const types = (query.get("types") || "").toLowerCase();
  const source = query.get("source") || "";

  if (!types) {
    return json(res, 400, { error: "缺少 types 参数", examples: ["types=url&source=wy&id=xxx&br=320"] });
  }

  if (types === "url") {
    if (!source) return json(res, 400, { error: "缺少 source 参数" });

    const lxSource = normalizeSource(source);
    const quality = pickQuality(
      (candidateRuntimes(source, "musicUrl")[0]?.sources()?.[lxSource]?.qualitys) || ["128k"],
      query.get("br")
    );
    const musicInfo = buildMusicInfo(query, lxSource);

    if (!musicInfo.id) return json(res, 400, { error: "缺少 id 参数" });

    const result = await resolveMusicUrl(source, musicInfo, quality);
    if (!result.ok) {
      return json(res, result.code || 502, {
        error: result.message,
        source: lxSource,
        id: musicInfo.id,
        quality,
      });
    }

    const resolvedUrl = await normalizePlayableUrl(result.url);
    const shouldProxy =
      config.proxyStream || query.get("proxy") === "1" || /^http:\/\//i.test(resolvedUrl);
    const playUrl = shouldProxy
      ? `${baseUrlOf(req)}/stream?u=${makeStreamToken(resolvedUrl)}`
      : resolvedUrl;

    return json(res, 200, {
      url: playUrl,
      br: Number(query.get("br")) || 128,
      source: lxSource,
      quality,
      script: result.script,
      raw: result.url,
      resolved: resolvedUrl,
      proxied: shouldProxy,
      cached: Boolean(result.cached),
    });
  }

  if (types === "search") {
    const keyword = query.get("name") || query.get("keyword") || query.get("q") || "";
    const page = Number(query.get("pages") || query.get("page") || 1) || 1;
    const count = Number(query.get("count") || 20) || 20;
    if (!keyword) return json(res, 400, { error: "缺少 name 参数" });

    // 1) 原生搜索：直接对接平台公开接口，不依赖 GD Studio，也不依赖脚本的 search
    if (hasNativeSearch(source)) {
      const native = await searchNative(source, keyword, page, count);
      if (native && native.length) {
        return json(res, 200, native, { "X-Otter-Search-Via": "native" });
      }
    }

    // 2) 脚本自带的搜索能力（少数脚本实现了 search / musicSearch）
    const candidates = candidateRuntimes(source, "search").concat(
      candidateRuntimes(source, "musicSearch")
    );
    for (const rt of candidates) {
      const action = (rt.sources()[normalizeSource(source)]?.actions || []).includes("search")
        ? "search"
        : "musicSearch";
      try {
        const result = await rt.dispatch(
          {
            source: normalizeSource(source),
            action,
            info: { keyword, name: keyword, page, pages: page, count, limit: count },
          },
          config.timeoutMs
        );
        const list = normalizeSearchResult(result, normalizeSource(source));
        if (list.length) return json(res, 200, list, { "X-Otter-Search-Via": "script" });
      } catch {
        /* 试下一个脚本 */
      }
    }
    // 都没有结果，交给调用方回退到下一个上游。
    return json(res, 404, { error: "当前脚本未提供可用的搜索能力", source: normalizeSource(source) });
  }

  if (types === "lyric") {
    const id = query.get("id") || "";
    const candidates = candidateRuntimes(source, "lyric");
    for (const rt of candidates) {
      try {
        const result = await rt.dispatch(
          {
            source: normalizeSource(source),
            action: "lyric",
            info: { musicInfo: buildMusicInfo(query, normalizeSource(source)), type: "128k" },
          },
          config.timeoutMs
        );
        if (result) {
          const lyric =
            typeof result === "string" ? result : result.lyric || result.lrc || result.lyrics || "";
          if (lyric) return json(res, 200, { lyric, tlyric: result.tlyric || "" });
        }
      } catch {
        /* 试下一个 */
      }
    }
    return json(res, 404, { error: "当前脚本未提供可用的歌词能力", id });
  }

  if (types === "pic") {
    // 原生搜索结果里的 pic_id 是令牌，直接换回封面地址。
    const picToken = readPicToken(query.get("id"));
    if (picToken) return json(res, 200, { url: picToken });

    const candidates = candidateRuntimes(source, "pic");
    for (const rt of candidates) {
      try {
        const result = await rt.dispatch(
          {
            source: normalizeSource(source),
            action: "pic",
            info: { musicInfo: buildMusicInfo(query, normalizeSource(source)), type: "128k" },
          },
          config.timeoutMs
        );
        const pic = extractUrl(result);
        if (pic) return json(res, 200, { url: pic });
      } catch {
        /* 试下一个 */
      }
    }
    return json(res, 404, { error: "当前脚本未提供封面能力" });
  }

  // 其余类型（playlist / album / artist ...）本服务不实现，返回 404 让上游回退。
  return json(res, 404, {
    error: `不支持的 types: ${types}`,
    supported: ["url", "search", "lyric", "pic"],
  });
}

function normalizeSearchResult(result, source) {
  const raw = Array.isArray(result)
    ? result
    : result?.list || result?.data || result?.songs || result?.result || [];
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item) => {
      const id =
        item?.songmid || item?.hash || item?.songId || item?.id || item?.mid || item?.rid || "";
      if (!id) return null;
      const artist = item?.singer || item?.artist || item?.artists || "";
      return {
        id: String(id),
        name: item?.name || item?.songname || item?.title || "",
        artist: Array.isArray(artist)
          ? artist.map((a) => (typeof a === "string" ? a : a?.name)).filter(Boolean)
          : String(artist).split(/[、,&]/).map((s) => s.trim()).filter(Boolean),
        album: item?.albumName || item?.album || item?.albumname || "",
        pic_id: item?.pic_id || String(id),
        url_id: item?.url_id || String(id),
        lyric_id: item?.lyric_id || String(id),
        source,
      };
    })
    .filter(Boolean);
}

async function handleStream(req, res, url) {
  const token = url.searchParams.get("u") || url.searchParams.get("url");
  const direct = url.searchParams.get("url");
  const target = token ? readStreamToken(token) || (direct && token === direct ? direct : null) : null;
  if (!target) return json(res, 404, { error: "取流令牌无效或已过期" });

  let u;
  try {
    u = new URL(target);
  } catch {
    return json(res, 400, { error: "非法地址" });
  }
  if (isBlockedHost(u.hostname)) return json(res, 403, { error: "不允许的地址" });

  const headers = { "User-Agent": DEFAULT_UA, Accept: "*/*" };
  const range = req.headers.range;
  if (range) headers.Range = range;

  const controller = new AbortController();
  const onClose = () => controller.abort();
  req.on("close", onClose);

  try {
    const upstream = await fetch(u.toString(), {
      method: req.method === "HEAD" ? "HEAD" : "GET",
      headers,
      redirect: "follow",
      signal: controller.signal,
    });

    const passthrough = [
      "content-type",
      "content-length",
      "content-range",
      "accept-ranges",
      "last-modified",
      "etag",
    ];
    const outHeaders = { ...CORS_HEADERS, "Cache-Control": "no-store" };
    for (const key of passthrough) {
      const v = upstream.headers.get(key);
      if (v) outHeaders[key] = v;
    }
    if (!outHeaders["content-type"]) outHeaders["content-type"] = "application/octet-stream";

    res.writeHead(upstream.status, outHeaders);
    if (req.method === "HEAD" || !upstream.body) {
      res.end();
      return;
    }
    await pipeline(Readable.fromWeb(upstream.body), res);
  } catch (e) {
    if (res.headersSent) {
      res.destroy();
      return;
    }
    json(res, 502, { error: `取流失败: ${e.message}` });
  } finally {
    req.off("close", onClose);
  }
}

function requireAdmin(req, res) {
  if (!config.adminToken) {
    json(res, 403, {
      error: "未配置管理令牌，脚本导入接口已关闭。请在 config.json 设置 adminToken 后重新部署。",
    });
    return false;
  }
  const token = req.headers["x-admin-token"] || new URL(req.url, "http://x").searchParams.get("token");
  if (String(token || "") !== config.adminToken) {
    json(res, 401, { error: "管理令牌无效" });
    return false;
  }
  return true;
}

async function handleAdmin(req, res, url, pathname) {
  if (!requireAdmin(req, res)) return;

  if (pathname === "/admin/scripts" && req.method === "GET") {
    return json(res, 200, {
      scripts: runtimes.map((rt) => ({ id: rt.id, name: rt.name, origin: rt.origin })),
      errors: runtimeErrors,
      imported: readImportedScripts(),
    });
  }

  if (pathname === "/admin/scripts" && req.method === "POST") {
    let body;
    try {
      body = await readJsonBody(req);
    } catch (e) {
      return json(res, 400, { error: e.message });
    }
    const scriptUrl = String(body.url || "").trim();
    if (!scriptUrl) return json(res, 400, { error: "缺少 url" });

    try {
      const code = await fetchScriptText(scriptUrl);
      const id = String(body.id || scriptIdFromUrl(scriptUrl, runtimes.length)).replace(
        /[^a-zA-Z0-9._-]/g,
        "_"
      );
      if (runtimes.some((rt) => rt.id === id)) return json(res, 409, { error: `脚本 id 已存在: ${id}` });

      const rt = await loadScript(code, {
        id,
        name: body.name || scriptNameFromUrl(scriptUrl) || id,
        origin: scriptUrl,
      });
      if (!rt) return json(res, 422, { error: "脚本加载失败或未注册任何音源" });

      const list = readImportedScripts();
      if (!list.some((x) => x.url === scriptUrl)) {
        list.push({ url: scriptUrl, id: rt.id, name: rt.name, importedAt: new Date().toISOString() });
        await writeImportedScripts(list);
      }

      return json(res, 200, {
        ok: true,
        script: { id: rt.id, name: rt.name, origin: rt.origin },
        sources: Object.keys(rt.sources()),
      });
    } catch (e) {
      return json(res, 502, { error: `导入失败: ${e.message}` });
    }
  }

  if (pathname.startsWith("/admin/scripts/") && req.method === "DELETE") {
    const id = decodeURIComponent(pathname.slice("/admin/scripts/".length));
    const index = runtimes.findIndex((rt) => rt.id === id);
    if (index === -1) return json(res, 404, { error: "脚本不存在" });
    runtimes[index].dispose();
    runtimes.splice(index, 1);
    const list = readImportedScripts().filter((x) => x.id !== id);
    await writeImportedScripts(list);
    return json(res, 200, { ok: true, removed: id });
  }

  return json(res, 404, { error: "未知的管理接口" });
}

function renderHome(req) {
  const payload = statusPayload(req);
  const rows = payload.scripts
    .map((s) => {
      const platforms = Object.entries(s.sources)
        .map(([k, v]) => `<span class="chip">${k}</span>`)
        .join(" ");
      const actions = [
        ...new Set(Object.values(s.sources).flatMap((v) => v.actions || [])),
      ].join(" / ");
      return `<tr><td><code>${escapeHtml(s.id)}</code></td><td>${platforms || "-"}</td><td>${escapeHtml(actions || "-")}</td></tr>`;
    })
    .join("");

  const errorRows = payload.errors
    .map((e) => `<li><code>${escapeHtml(e.origin || e.id)}</code> — ${escapeHtml(e.error)}</li>`)
    .join("");

  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>洛雪音源 HTTP 桥接</title>
<style>
  :root{color-scheme:light}
  *{box-sizing:border-box}
  body{margin:0;background:#f6f7f9;color:#1b1d21;font:15px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif}
  .wrap{max-width:920px;margin:0 auto;padding:40px 20px 64px}
  h1{font-size:24px;margin:0 0 6px}
  .sub{color:#666c76;margin:0 0 28px;font-size:14px}
  .card{background:#fff;border:1px solid #e6e8ec;border-radius:12px;padding:20px;margin-bottom:18px}
  h2{font-size:15px;margin:0 0 12px;color:#3a3f47;letter-spacing:.02em}
  table{width:100%;border-collapse:collapse;font-size:13.5px}
  th,td{text-align:left;padding:8px 10px;border-bottom:1px solid #eef0f3;vertical-align:top}
  th{color:#7a808a;font-weight:500;font-size:12.5px}
  tr:last-child td{border-bottom:none}
  code{background:#f2f4f7;padding:2px 6px;border-radius:5px;font-size:12.5px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;word-break:break-all}
  pre{background:#f7f8fa;border:1px solid #eceef2;border-radius:8px;padding:12px;overflow:auto;font-size:12.5px;margin:0}
  .chip{display:inline-block;background:#eef4ff;color:#2b5bd7;border-radius:999px;padding:1px 8px;font-size:12px;margin:0 2px 2px 0}
  .ok{color:#0f7b3e;font-weight:600}
  .warn{color:#a4560a;font-weight:600}
  ul{margin:0;padding-left:20px}
  .muted{color:#7a808a;font-size:13px}
</style></head>
<body><div class="wrap">
  <h1>洛雪音源 HTTP 桥接</h1>
  <p class="sub">把 LX Music 的 <code>.js</code> 音源脚本包装成 GD Studio 兼容的 HTTP 接口。运行中 <span class="ok">${payload.scripts.length}</span> 个脚本，已运行 ${payload.uptimeSeconds}s。</p>

  <div class="card">
    <h2>填进 otter-music 的地址</h2>
    <p class="muted" style="margin:0 0 10px">打开 <code>/admin</code> → 音源管理 → 新增，把下面这条作为音源地址：</p>
    <pre>${escapeHtml(payload.endpoints.gdStudioCompatible)}</pre>
  </div>

  <div class="card">
    <h2>已加载脚本</h2>
    <table><thead><tr><th>脚本</th><th>平台</th><th>actions</th></tr></thead>
    <tbody>${rows || '<tr><td colspan="3" class="muted">暂无脚本</td></tr>'}</tbody></table>
    ${errorRows ? `<h2 style="margin-top:18px">加载失败</h2><ul class="muted">${errorRows}</ul>` : ""}
  </div>

  <div class="card">
    <h2>接口示例</h2>
    <pre>GET ${escapeHtml(payload.endpoints.gdStudioCompatible)}?types=search&amp;source=kuwo&amp;name=%E7%A8%BB%E9%A6%99&amp;count=20&amp;pages=1
GET ${escapeHtml(payload.endpoints.gdStudioCompatible)}?types=url&amp;source=kuwo&amp;id=91637031&amp;br=320
GET ${escapeHtml(payload.endpoints.gdStudioCompatible)}?types=url&amp;source=wy&amp;id=3404293607&amp;br=320
GET ${escapeHtml(payload.endpoints.health)}
GET ${escapeHtml(payload.endpoints.sources)}</pre>
    <p class="muted" style="margin:10px 0 0">搜索走各平台公开接口（酷我 / 酷狗 / QQ），取链走洛雪脚本；脚本未实现的类型返回 404，让调用方继续回退到下一个上游，而不是用空结果挡住后面的音源。</p>
  </div>
</div></body></html>`;
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ---------------------------------------------------------------------------
// 主处理
// ---------------------------------------------------------------------------

const server = http.createServer(async (req, res) => {
  let url;
  try {
    url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  } catch {
    return json(res, 400, { error: "非法请求地址" });
  }
  const pathname = url.pathname.replace(/\/+$/, "") || "/";

  if (req.method === "OPTIONS") {
    res.writeHead(204, CORS_HEADERS);
    return res.end();
  }

  if (rateLimited(clientIp(req))) {
    return json(res, 429, { error: "请求过于频繁" });
  }

  try {
    if (pathname === "/health") return json(res, 200, statusPayload(req));
    if (pathname === "/sources") {
      return json(res, 200, {
        scripts: runtimes.map((rt) => ({
          id: rt.id,
          name: rt.name,
          origin: rt.origin,
          sources: rt.sources(),
        })),
        errors: runtimeErrors,
      });
    }

    if (pathname === "/api.php" || pathname === "/api" || pathname === "/music-api") {
      return await handleApi(req, res, url);
    }

    if (pathname === "/stream") return await handleStream(req, res, url);

    if (pathname.startsWith("/admin/")) return await handleAdmin(req, res, url, pathname);

    if (pathname === "/" || pathname === "/index.html") {
      const html = renderHome(req);
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Content-Length": Buffer.byteLength(html),
        ...CORS_HEADERS,
      });
      return res.end(html);
    }

    return json(res, 404, {
      error: "Not Found",
      endpoints: ["/", "/health", "/sources", "/api.php?types=url&source=wy&id=xxx"],
    });
  } catch (e) {
    console.error("[request]", e);
    if (!res.headersSent) json(res, 500, { error: e.message });
    else res.destroy();
  }
});

server.keepAliveTimeout = 65000;
server.headersTimeout = 70000;

bootstrap()
  .then(() => {
    server.listen(PORT, HOST, () => {
      log(`[boot] listening on http://${HOST}:${PORT}`);
    });
  })
  .catch((e) => {
    console.error("[boot] failed", e);
    server.listen(PORT, HOST, () => log(`[boot] listening (degraded) on ${PORT}`));
  });

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    log(`[exit] ${sig}`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  });
}
