/**
 * lx-http-bridge · Cloudflare Workers 版
 *
 * 与 Node 版（../server.js）接口完全兼容，但**不运行洛雪脚本**：
 * Workers 没有 node:vm 且禁止动态代码执行，所以这里改用三个平台的原生接口
 * 做搜索 + 取链。适合「只想要酷我/酷狗/QQ 免费曲目，不要维护隧道」的场景。
 *
 *   GET /api.php?types=search&source=kuwo&name=稻香&count=20
 *   GET /api.php?types=url&source=kuwo&id=91637031&br=192
 *   GET /api.php?types=pic&id=<令牌>
 *   GET /health   /sources   /stream?u=<令牌>
 */

import {
  CORS_HEADERS,
  DEFAULT_UA,
  isBlockedHost,
  json,
  makeToken,
  preferHttps,
  probePlayable,
  readToken,
} from "./util.js";
import { hasNativeSearch, nativeSearchSources, searchNative } from "./search.js";
import { hasNativeUrl, nativeUrlSources, resolveNative } from "./resolve.js";

const VERSION = "1.0.0-cf";
const API_PATHS = new Set(["/api.php", "/api", "/music-api"]);

export default {
  async fetch(request) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    const path = url.pathname.replace(/\/+$/, "") || "/";

    if (path === "/health") {
      return json({
        ok: true,
        service: "lx-http-bridge",
        runtime: "cloudflare-workers",
        version: VERSION,
        scripts: [],
        native: { search: nativeSearchSources, url: nativeUrlSources },
        note: "CF 版不运行洛雪脚本，改用平台原生接口",
      });
    }

    if (path === "/sources") {
      return json({
        search: nativeSearchSources,
        url: nativeUrlSources,
        endpoints: { gdStudioCompatible: `${url.origin}/api.php`, health: `${url.origin}/health` },
      });
    }

    if (path === "/stream") {
      return handleStream(request, url);
    }

    if (path === "/") {
      return new Response(INDEX_HTML, {
        headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
      });
    }

    if (API_PATHS.has(path)) {
      return handleApi(request, url);
    }

    return json(
      {
        error: "Not Found",
        endpoints: ["/", "/health", "/sources", "/api.php?types=url&source=kuwo&id=91637031"],
      },
      404
    );
  },
};

// ---------------------------------------------------------------------------
// /api.php
// ---------------------------------------------------------------------------

async function handleApi(request, url) {
  const q = url.searchParams;
  const types = (q.get("types") || "").toLowerCase();
  const source = q.get("source") || "";

  if (!types) {
    return json(
      {
        error: "缺少 types 参数",
        examples: ["types=url&source=kuwo&id=91637031&br=192", "types=search&source=qq&name=稻香"],
      },
      400
    );
  }

  if (types === "search") {
    const keyword = q.get("name") || q.get("keyword") || q.get("q") || "";
    if (!keyword) return json({ error: "缺少 name 参数" }, 400);

    if (!hasNativeSearch(source)) {
      return json({ error: `不支持的搜索音源: ${source}`, supported: nativeSearchSources }, 404);
    }

    const page = Number(q.get("pages") || q.get("page") || 1) || 1;
    const count = Math.min(50, Number(q.get("count") || 20) || 20);
    const list = await searchNative(source, keyword, page, count);

    if (!list || !list.length) {
      return json({ error: "未找到结果", source, keyword }, 404);
    }
    return json(list, 200, { "X-Otter-Search-Via": "native" });
  }

  if (types === "url") {
    if (!source) return json({ error: "缺少 source 参数" }, 400);
    const id = q.get("id") || q.get("url_id") || "";
    if (!id) return json({ error: "缺少 id 参数" }, 400);

    if (!hasNativeUrl(source)) {
      return json({ error: `不支持的取链音源: ${source}`, supported: nativeUrlSources }, 404);
    }

    let result;
    try {
      result = await resolveNative(source, id);
    } catch (e) {
      // 取不到地址时返回 404，让调用方（otter-music）继续回退下一个音源
      return json({ error: String(e?.message || e), source, id }, 404);
    }

    let playUrl = result.url;
    let proxied = false;

    // 明文 http 在 https 页面里会被浏览器按混合内容拦掉：
    // 先试 https 变体，不行就走自己的 /stream 代理。
    if (/^http:\/\//i.test(playUrl)) {
      const upgraded = preferHttps(playUrl);
      if (await probePlayable(upgraded)) {
        playUrl = upgraded;
      } else {
        proxied = true;
        playUrl = `${url.origin}/stream?u=${makeToken(result.url, "st")}`;
      }
    }

    const br = Number(q.get("br")) || 128;
    return json({
      url: playUrl,
      br,
      source: String(source).toLowerCase(),
      quality: `${br}k`,
      via: result.via,
      raw: result.url,
      proxied,
    });
  }

  if (types === "pic") {
    const picUrl = readToken(q.get("id"), "px");
    if (!picUrl) return json({ error: "封面令牌无效" }, 404);
    return json({ url: picUrl });
  }

  if (types === "lyric") {
    return json({ error: "CF 版暂不提供歌词" }, 404);
  }

  return json({ error: `不支持的 types: ${types}` }, 404);
}

// ---------------------------------------------------------------------------
// /stream：给 http-only 的地址兜底（Range 透传）
// ---------------------------------------------------------------------------

async function handleStream(request, url) {
  const target = readToken(url.searchParams.get("u"), "st");
  if (!target) return json({ error: "取流令牌无效" }, 404);

  let u;
  try {
    u = new URL(target);
  } catch {
    return json({ error: "非法地址" }, 400);
  }
  if (isBlockedHost(u.hostname)) return json({ error: "不允许的地址" }, 403);

  const headers = { "User-Agent": DEFAULT_UA, Accept: "*/*" };
  const range = request.headers.get("Range");
  if (range) headers.Range = range;

  let upstream;
  try {
    upstream = await fetch(u.toString(), {
      method: request.method === "HEAD" ? "HEAD" : "GET",
      headers,
      redirect: "follow",
    });
  } catch (e) {
    return json({ error: `取流失败: ${e.message}` }, 502);
  }

  const out = new Headers(CORS_HEADERS);
  for (const key of ["content-type", "content-length", "content-range", "accept-ranges", "last-modified", "etag"]) {
    const v = upstream.headers.get(key);
    if (v) out.set(key, v);
  }
  out.set("Cache-Control", "no-store");
  if (!out.get("content-type")) out.set("content-type", "application/octet-stream");

  return new Response(request.method === "HEAD" ? null : upstream.body, {
    status: upstream.status,
    headers: out,
  });
}

// ---------------------------------------------------------------------------

const INDEX_HTML = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>lx-http-bridge (CF Workers)</title>
<style>
  body{font:15px/1.7 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;max-width:760px;margin:48px auto;padding:0 20px;color:#1f2328}
  code{background:#f3f4f6;padding:2px 6px;border-radius:4px;font-size:13px}
  pre{background:#f3f4f6;padding:14px;border-radius:8px;overflow:auto;font-size:13px}
  h1{font-size:22px}li{margin:4px 0}
</style></head><body>
<h1>lx-http-bridge · Cloudflare Workers</h1>
<p>GD Studio 兼容接口。此版本不运行洛雪脚本，改用平台原生搜索与取链接口。</p>
<ul>
  <li><code>GET /api.php?types=search&amp;source=kuwo&amp;name=稻香</code></li>
  <li><code>GET /api.php?types=url&amp;source=kuwo&amp;id=91637031&amp;br=192</code></li>
  <li><code>GET /api.php?types=pic&amp;id=&lt;令牌&gt;</code></li>
  <li><code>GET /health</code> · <code>GET /sources</code></li>
</ul>
<p>支持的 source：<code>kuwo / kw</code>、<code>kugou / kg</code>、<code>qq / tx</code>。</p>
</body></html>`;
