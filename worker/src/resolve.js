/**
 * 原生取链：不跑洛雪脚本，直接调用各平台自己的播放地址接口。
 *
 * 为什么 CF 版不能跑脚本：Workers 没有 node:vm，且禁止动态代码执行
 * （eval / new Function 会被 CSP 拦掉），无法承载 .js 音源脚本。
 * 好在三个平台都有可用的公开取链接口，覆盖了绝大多数免费曲目。
 *
 * 已知限制：VIP / 付费曲目三个平台都会拒绝（返回空地址），这与洛雪脚本的表现一致。
 */

import { DEFAULT_UA, fetchText } from "./util.js";

const TIMEOUT = 12000;

// ---------------------------------------------------------------------------
// 酷我：antiserver 直接返回明文地址，无需任何鉴权
// ---------------------------------------------------------------------------

export async function resolveKuwo(rid) {
  const url =
    "https://antiserver.kuwo.cn/anti.s" +
    `?type=convert_url&format=mp3&response=url&rid=MUSIC_${encodeURIComponent(rid)}`;

  const text = (await fetchText(url, { Referer: "https://www.kuwo.cn/" }, TIMEOUT)).trim();
  // 失败时会返回提示文本而不是地址
  if (!/^https?:\/\//i.test(text)) throw new Error(`酷我未返回地址: ${text.slice(0, 60)}`);
  return { url: text, via: "kuwo-antiserver" };
}

// ---------------------------------------------------------------------------
// QQ：musicu.fcg 的 vkey 接口，纯 JSON POST，不需要签名
// ---------------------------------------------------------------------------

export async function resolveTencent(mid) {
  const guid = String(Math.floor(Math.random() * 9e9) + 1e9);
  const payload = {
    req_0: {
      module: "vkey.GetVkeyServer",
      method: "CgiGetVkey",
      param: {
        guid,
        songmid: [mid],
        songtype: [0],
        uin: "0",
        loginflag: 1,
        platform: "20",
      },
    },
    loginUin: "0",
    comm: { uin: "0", format: "json", ct: 24, cv: 0 },
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT);
  let data;
  try {
    const res = await fetch("https://u.y.qq.com/cgi-bin/musicu.fcg", {
      method: "POST",
      headers: {
        "User-Agent": DEFAULT_UA,
        "Content-Type": "application/json",
        Referer: "https://y.qq.com/",
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    data = await res.json();
  } finally {
    clearTimeout(timer);
  }

  const info = data?.req_0?.data?.midurlinfo?.[0];
  const purl = String(info?.purl || "");
  if (!purl) {
    // 104003 = 需要付费购买；其它 result 码含义未公开
    const code = info?.result;
    throw new Error(code === 104003 ? "QQ 音乐：该曲目需要付费" : `QQ 音乐未返回 vkey（result=${code}）`);
  }
  const sip = data?.req_0?.data?.sip?.[0] || "https://aqqmusic.tc.qq.com/";
  return { url: sip.replace(/\/?$/, "/") + purl, via: "qq-vkey" };
}

// ---------------------------------------------------------------------------
// 酷狗：m.kugou.com 的 getSongInfo 直接返回播放地址
// ---------------------------------------------------------------------------

export async function resolveKugou(hash) {
  const url = `https://m.kugou.com/app/i/getSongInfo.php?cmd=playInfo&hash=${encodeURIComponent(hash)}`;
  const text = await fetchText(url, { Referer: "https://m.kugou.com/" }, TIMEOUT);

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`酷狗返回非 JSON: ${text.slice(0, 60)}`);
  }

  const playUrl = String(data?.url || "");
  if (!playUrl) throw new Error(data?.error ? `酷狗：${data.error}` : "酷狗未返回地址");
  return { url: playUrl, via: "kugou-songinfo" };
}

// ---------------------------------------------------------------------------

const RESOLVERS = {
  kuwo: resolveKuwo,
  kw: resolveKuwo,
  kugou: resolveKugou,
  kg: resolveKugou,
  qq: resolveTencent,
  tencent: resolveTencent,
  tx: resolveTencent,
};

export const nativeUrlSources = Object.keys(RESOLVERS);

export function hasNativeUrl(source) {
  return Boolean(RESOLVERS[String(source || "").trim().toLowerCase()]);
}

/** 取不到地址时抛错，由调用方转成 404 / 502。 */
export async function resolveNative(source, id) {
  const fn = RESOLVERS[String(source || "").trim().toLowerCase()];
  if (!fn) throw new Error(`不支持的音源: ${source}`);
  return await fn(id);
}
