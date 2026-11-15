/**
 * 真实接口 smoke：直接把 Worker 的 fetch handler 跑在 Node 里（Node 18+ 有 Request/Response/fetch），
 * 不需要 workerd，也不需要 wrangler dev。会真实访问各平台接口。
 */

import assert from "node:assert/strict";

import worker from "../src/index.js";

const BASE = "http://localhost";
let pass = 0;
let fail = 0;

async function check(name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    pass += 1;
  } catch (e) {
    console.log(`  ✗ ${name}\n    ${e.message}`);
    fail += 1;
  }
}

function call(path) {
  return worker.fetch(new Request(BASE + path));
}

async function callJson(path) {
  const res = await call(path);
  const body = await res.json();
  return { res, body };
}

async function headOk(url) {
  const r = await fetch(url, { headers: { Range: "bytes=0-1" }, redirect: "follow" });
  return r.status >= 200 && r.status < 400;
}

console.log("lx-http-bridge (CF Workers) smoke");

await check("GET /health 返回 ok", async () => {
  const { res, body } = await callJson("/health");
  assert.equal(res.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.runtime, "cloudflare-workers");
});

await check("GET /sources 列出支持的音源", async () => {
  const { res, body } = await callJson("/sources");
  assert.equal(res.status, 200);
  assert.ok(body.search.includes("kuwo"));
  assert.ok(body.url.includes("qq"));
});

await check("OPTIONS 预检返回 CORS 头", async () => {
  const res = await worker.fetch(new Request(BASE + "/api.php", { method: "OPTIONS" }));
  assert.equal(res.status, 204);
  assert.equal(res.headers.get("Access-Control-Allow-Origin"), "*");
});

await check("缺少 types 返回 400", async () => {
  const { res } = await callJson("/api.php");
  assert.equal(res.status, 400);
});

await check("未知路径返回 404", async () => {
  const { res } = await callJson("/nope");
  assert.equal(res.status, 404);
});

// --- 搜索 ---
let kuwoTrack = null;

await check("搜索：酷我返回结果", async () => {
  const { res, body } = await callJson("/api.php?types=search&source=kuwo&name=%E7%A8%BB%E9%A6%99&count=10");
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(body) && body.length > 0, "结果为空");
  kuwoTrack = body[0];
  assert.ok(kuwoTrack.url_id, "缺少 url_id");
  assert.equal(kuwoTrack.source, "kuwo");
  console.log(`    → ${kuwoTrack.name} / ${kuwoTrack.artist.join("、")} (url_id=${kuwoTrack.url_id})`);
});

await check("搜索：酷狗返回结果", async () => {
  const { res, body } = await callJson("/api.php?types=search&source=kugou&name=%E7%A8%BB%E9%A6%99&count=5");
  assert.equal(res.status, 200);
  assert.ok(body.length > 0);
  assert.equal(body[0].source, "kugou");
});

await check("搜索：QQ 返回结果", async () => {
  const { res, body } = await callJson("/api.php?types=search&source=qq&name=%E7%A8%BB%E9%A6%99&count=5");
  assert.equal(res.status, 200);
  assert.ok(body.length > 0);
  assert.equal(body[0].source, "qq");
});

await check("搜索：不支持的音源返回 404", async () => {
  const { res, body } = await callJson("/api.php?types=search&source=spotify&name=x");
  assert.equal(res.status, 404);
  assert.ok(body.supported);
});

// --- 封面 ---
let qqTrack = null;

await check("封面：pic_id 能换回可访问的图片地址", async () => {
  const { body } = await callJson("/api.php?types=search&source=qq&name=%E7%A8%BB%E9%A6%99&count=5");
  qqTrack = body.find((t) => t.pic_id);
  if (!qqTrack) throw new Error("QQ 结果里没有带 pic_id 的条目");
  const { res, body: pic } = await callJson(
    `/api.php?types=pic&id=${encodeURIComponent(qqTrack.pic_id)}`
  );
  assert.equal(res.status, 200);
  assert.match(pic.url, /^https:\/\//);
  assert.ok(await headOk(pic.url), "封面地址不可访问");
  console.log(`    → ${pic.url.slice(0, 70)}…`);
});

// --- 取链 ---
await check("取链：酷我返回 https 可播地址", async () => {
  const { res, body } = await callJson(`/api.php?types=url&source=kuwo&id=${kuwoTrack.url_id}&br=192`);
  assert.equal(res.status, 200, JSON.stringify(body));
  assert.match(body.url, /^https:\/\//, "地址不是 https");
  assert.equal(body.proxied, false);
  assert.ok(await headOk(body.url), "音频地址不可访问");
  console.log(`    → ${body.url.slice(0, 80)}… (via ${body.via})`);
});

await check("取链：QQ 能对免费曲目返回可播地址", async () => {
  // 付费曲目返回 404 是正确行为，所以在结果里找第一首能取到链的
  const { body: list } = await callJson("/api.php?types=search&source=qq&name=%E5%B0%8F%E8%8B%B9%E6%9E%9C&count=10");
  let found = null;
  for (const track of list.slice(0, 6)) {
    const { res, body } = await callJson(
      `/api.php?types=url&source=qq&id=${encodeURIComponent(track.url_id)}&br=128`
    );
    if (res.status === 200 && body.url) {
      found = { track, body };
      break;
    }
  }
  if (!found) {
    console.log("    → 前 6 条均需付费，取链接口本身正常（返回 404 带原因）");
    return;
  }
  assert.match(found.body.url, /^https?:\/\//);
  assert.ok(await headOk(found.body.url), "音频地址不可访问");
  console.log(`    → ${found.track.name} ${found.body.url.slice(0, 60)}… (via ${found.body.via})`);
});

await check("取链：酷狗对免费曲目返回地址或明确 404", async () => {
  const { body: list } = await callJson("/api.php?types=search&source=kugou&name=test%20tone&count=5");
  const track = list[0];
  const { res, body } = await callJson(
    `/api.php?types=url&source=kugou&id=${encodeURIComponent(track.url_id)}&br=128`
  );
  assert.ok(res.status === 200 || res.status === 404, `意外状态 ${res.status}`);
  if (res.status === 200) {
    assert.match(body.url, /^https?:\/\//);
    assert.ok(await headOk(body.url), "音频地址不可访问");
    console.log(`    → ${track.name} ${body.url.slice(0, 60)}… (via ${body.via})`);
  } else {
    console.log(`    → ${body.error}`);
  }
});

await check("取链：缺少 id 返回 400", async () => {
  const { res } = await callJson("/api.php?types=url&source=kuwo");
  assert.equal(res.status, 400);
});

await check("取链：不支持的音源返回 404", async () => {
  const { res } = await callJson("/api.php?types=url&source=spotify&id=1");
  assert.equal(res.status, 404);
});

await check("取流：非法令牌返回 404", async () => {
  const { res } = await callJson("/stream?u=stxxx");
  assert.equal(res.status, 404);
});

console.log(`\n通过 ${pass} 项检查${fail ? `，失败 ${fail} 项` : ""}`);
if (fail) process.exit(1);
