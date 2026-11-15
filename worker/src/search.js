/**
 * 原生搜索：直接对接各平台公开搜索接口，不依赖 GD Studio，也不依赖洛雪脚本。
 *
 * 输出 GD Studio 的 RawApiTrack 形状：
 *   { id, name, artist[], album, pic_id, url_id, lyric_id, source, duration }
 *
 * url_id 必须与「取链」期望的字段一致：
 *   - 酷我 → 数字 rid
 *   - 酷狗 → hash
 *   - QQ   → songmid
 */

import { fetchText, decodeEntities, unescapeUnicode, splitArtists, makeToken } from "./util.js";

// ---------------------------------------------------------------------------
// 酷我
// ---------------------------------------------------------------------------

/** 酷我返回单引号伪 JSON，先试标准解析，失败再做字符级引号转换。 */
export function parseKuwoJson(text) {
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

/**
 * 把单引号字符串字面量转成双引号（JSON 兼容）。
 * 正则处理不了 `\\'` 这类转义，只能逐字符扫描。
 */
export function quoteSingleToDouble(text) {
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
          const next = text[j + 1] ?? "";
          // 转义的单引号在 JSON 里没有意义，直接还原成字符
          value += next === "'" ? "'" : c + next;
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

export async function searchKuwo(keyword, page, count) {
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
        pic_id: makeToken(picPath ? `https://img2.kuwo.cn/star/albumcover/${picPath}` : ""),
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

export async function searchKugou(keyword, page, count) {
  // mobilecdn.kugou.com 的证书与域名不匹配，只能走 http。
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

export async function searchTencent(keyword, page, count) {
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
        pic_id: makeToken(
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

export const nativeSearchSources = Object.keys(NATIVE_SEARCH);

export function hasNativeSearch(source) {
  return Boolean(NATIVE_SEARCH[String(source || "").trim().toLowerCase()]);
}

/** 返回 null 表示没有原生实现（调用方应回退），返回数组表示有实现（可能为空）。 */
export async function searchNative(source, keyword, page, count) {
  const fn = NATIVE_SEARCH[String(source || "").trim().toLowerCase()];
  if (!fn) return null;
  try {
    return await fn(keyword, page, count);
  } catch (e) {
    console.warn("[search] native failed", source, e.message);
    return [];
  }
}
