"use strict";

/**
 * 原生搜索适配：不依赖 GD Studio，也不依赖洛雪脚本的 search 能力。
 *
 * 洛雪脚本基本只实现 musicUrl，搜索上游（api.chksz.top / oiapi.net）又经常不可达，
 * 所以这里直接对接各平台公开搜索接口，把结果映射成 GD Studio 的 RawApiTrack 形状：
 *   { id, name, artist[], album, pic_id, url_id, lyric_id, source }
 *
 * url_id 的取值必须和洛雪脚本 musicUrl 期望的字段一致：
 *   - 酷我  → 数字 rid（脚本里当 songmid 用）
 *   - 酷狗  → hash
 *   - QQ    → songmid
 *
 * pic_id 存的是一个令牌（px + sha1），真正的封面地址留在内存表里，
 * 由 `types=pic&id=<令牌>` 换回来 —— 这样 pic_id 在调用方看来始终是个不透明 id。
 */

const crypto = require("node:crypto");
const { DEFAULT_UA, isBlockedHost } = require("./lx-runtime");

const TIMEOUT = 12000;

async function fetchText(url, headers = {}, timeout = TIMEOUT) {
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

// ---------------------------------------------------------------------------
// 封面令牌
// ---------------------------------------------------------------------------

const picStore = new Map();

function makePicToken(url) {
  if (!url) return "";
  const token = "px" + crypto.createHash("sha1").update(url).digest("hex").slice(0, 24);
  if (picStore.size > 4000) picStore.clear();
  picStore.set(token, url);
  return token;
}

function readPicToken(token) {
  return picStore.get(String(token || "")) || null;
}

// ---------------------------------------------------------------------------
// 文本清洗
// ---------------------------------------------------------------------------

const ENTITIES = { nbsp: " ", amp: "&", quot: '"', apos: "'", lt: "<", gt: ">" };

function decodeEntities(value) {
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
function unescapeUnicode(value) {
  return String(value ?? "")
    .replace(/\\+u([0-9a-fA-F]{4})/g, (_m, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\'/g, "'")
    .replace(/\\\\/g, "\\");
}

function splitArtists(value) {
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

// ---------------------------------------------------------------------------
// 酷我
// ---------------------------------------------------------------------------

/** 酷我返回的是单引号伪 JSON，先试标准解析，失败再做字符级引号转换。 */
function parseKuwoJson(text) {
  const raw = String(text || "").trim();
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    /* 走宽松解析 */
  }
  try {
    return JSON.parse(quoteSingleToDouble(raw));
  } catch {
    return null;
  }
}

function quoteSingleToDouble(text) {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === "'") {
      let j = i + 1;
      let value = "";
      while (j < text.length) {
        const c = text[j];
        if (c === "\\") {
          value += c + (text[j + 1] ?? "");
          j += 2;
          continue;
        }
        if (c === "'") break;
        value += c;
        j += 1;
      }
      out += JSON.stringify(value);
      i = j + 1;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

async function searchKuwo(keyword, page, count) {
  const pn = Math.max(0, (Number(page) || 1) - 1);
  const url =
    "http://search.kuwo.cn/r.s" +
    `?all=${encodeURIComponent(keyword)}` +
    `&ft=music&itemset=web_2013&client=kt&pn=${pn}&rn=${count}` +
    "&rformat=json&encoding=utf8";

  const data = parseKuwoJson(await fetchText(url));
  const list = Array.isArray(data?.abslist) ? data.abslist : [];

  return list
    .map((it) => {
      const rid = String(it.MUSICRID || it.DC_TARGETID || "")
        .replace(/^MUSIC_/, "")
        .trim();
      if (!rid) return null;
      const picPath = it.web_albumpic_short || it.PICPATH || "";
      return {
        id: rid,
        name: decodeEntities(unescapeUnicode(it.SONGNAME || it.NAME)),
        artist: splitArtists(unescapeUnicode(it.ARTIST)),
        album: decodeEntities(unescapeUnicode(it.ALBUM)),
        pic_id: makePicToken(picPath ? `https://img2.kuwo.cn/star/albumcover/${picPath}` : ""),
        url_id: rid,
        lyric_id: rid,
        source: "kuwo",
        duration: Number(it.DURATION) || 0,
      };
    })
    .filter(Boolean);
}

// ---------------------------------------------------------------------------
// 酷狗
// ---------------------------------------------------------------------------

async function searchKugou(keyword, page, count) {
  // 注意：mobilecdn.kugou.com 的证书与域名不匹配，只能走 http。
  const url =
    "http://mobilecdn.kugou.com/api/v3/search/song" +
    `?format=json&keyword=${encodeURIComponent(keyword)}&page=${page}&pagesize=${count}&showtype=1`;

  const data = JSON.parse(await fetchText(url));
  const list = Array.isArray(data?.data?.info) ? data.data.info : [];

  return list
    .map((it) => ({
      id: String(it.hash || ""),
      name: decodeEntities(it.songname),
      artist: splitArtists(it.singername),
      album: decodeEntities(it.album_name),
      pic_id: "",
      url_id: String(it.hash || ""),
      lyric_id: String(it.hash || ""),
      source: "kugou",
      duration: Number(it.duration) || 0,
    }))
    .filter((x) => x.id);
}

// ---------------------------------------------------------------------------
// QQ 音乐
// ---------------------------------------------------------------------------

async function searchTencent(keyword, page, count) {
  const url =
    "https://c.y.qq.com/soso/fcgi-bin/client_search_cp" +
    `?format=json&p=${page}&n=${count}&w=${encodeURIComponent(keyword)}`;

  const data = JSON.parse(await fetchText(url, { Referer: "https://y.qq.com/" }));
  const list = Array.isArray(data?.data?.song?.list) ? data.data.song.list : [];

  return list
    .map((it) => {
      const mid = String(it.songmid || "");
      if (!mid) return null;
      const albumMid = it.albummid || "";
      return {
        id: mid,
        name: decodeEntities(it.songname),
        artist: splitArtists(it.singer),
        album: decodeEntities(it.albumname),
        pic_id: makePicToken(
          albumMid ? `https://y.gtimg.cn/music/photo_new/T002R300x300M000${albumMid}.jpg` : ""
        ),
        url_id: mid,
        lyric_id: mid,
        source: "qq",
        duration: Number(it.interval) || 0,
      };
    })
    .filter(Boolean);
}

// ---------------------------------------------------------------------------

const NATIVE_SEARCH = {
  kuwo: searchKuwo,
  kw: searchKuwo,
  kugou: searchKugou,
  kg: searchKugou,
  qq: searchTencent,
  tencent: searchTencent,
  tx: searchTencent,
};

/**
 * 返回 null 表示该音源没有原生实现（调用方应继续回退），
 * 返回数组表示有实现（可能为空数组）。
 */
async function searchNative(source, keyword, page, count) {
  const fn = NATIVE_SEARCH[String(source || "").trim().toLowerCase()];
  if (!fn) return null;
  try {
    return await fn(keyword, page, count);
  } catch (e) {
    console.warn("[search] native failed", source, e.message);
    return [];
  }
}

function hasNativeSearch(source) {
  return Boolean(NATIVE_SEARCH[String(source || "").trim().toLowerCase()]);
}

module.exports = {
  searchNative,
  hasNativeSearch,
  nativeSearchSources: Object.keys(NATIVE_SEARCH),
  makePicToken,
  readPicToken,
  // 导出给单测
  parseKuwoJson,
  decodeEntities,
  unescapeUnicode,
  splitArtists,
  quoteSingleToDouble,
};
