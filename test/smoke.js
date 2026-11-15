"use strict";

/**
 * 本地冒烟测试：拉起真实服务，检查脚本加载、接口约定与鉴权。
 * 不依赖任何测试框架，`node test/smoke.js` 即可。
 */

const { spawn } = require("node:child_process");
const path = require("node:path");
const assert = require("node:assert");

const PORT = Number(process.env.SMOKE_PORT) || 8899;
const BASE = `http://127.0.0.1:${PORT}`;
const root = path.join(__dirname, "..");

function waitForServer(timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  return (async () => {
    while (Date.now() < deadline) {
      try {
        const res = await fetch(`${BASE}/health`);
        if (res.ok) return await res.json();
      } catch {
        /* not up yet */
      }
      await new Promise((r) => setTimeout(r, 400));
    }
    throw new Error("服务启动超时");
  })();
}

(async () => {
  const child = spawn(process.execPath, ["server.js"], {
    cwd: root,
    env: { ...process.env, PORT: String(PORT), HOST: "127.0.0.1", NODE_OPTIONS: "" },
    stdio: ["ignore", "pipe", "pipe"],
  });

  const logs = [];
  child.stdout.on("data", (d) => logs.push(d.toString()));
  child.stderr.on("data", (d) => logs.push(d.toString()));

  let passed = 0;
  const check = (name, fn) => {
    fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  };

  try {
    const health = await waitForServer();
    check("健康检查返回 ok", () => assert.strictEqual(health.ok, true));
    check("至少加载了一个脚本", () => assert.ok(health.scripts.length >= 1, "没有脚本被加载"));
    check(
      "脚本声明了 musicUrl 能力",
      () =>
        assert.ok(
          health.scripts.some((s) =>
            Object.values(s.sources).some((v) => (v.actions || []).includes("musicUrl"))
          )
        )
    );

    const unsupported = await fetch(`${BASE}/api.php?types=playlist&source=wy`);
    check("未实现的 types 返回 404（便于调用方回退）", () =>
      assert.strictEqual(unsupported.status, 404)
    );

    const noId = await fetch(`${BASE}/api.php?types=url&source=wy`);
    check("types=url 缺 id 返回 400", () => assert.strictEqual(noId.status, 400));

    const noSource = await fetch(`${BASE}/api.php?types=url&id=1`);
    check("types=url 缺 source 返回 400", () => assert.strictEqual(noSource.status, 400));

    const adminNoToken = await fetch(`${BASE}/admin/scripts`, { method: "POST" });
    check("管理接口无令牌返回 401/403", () =>
      assert.ok([401, 403].includes(adminNoToken.status))
    );

    const notFound = await fetch(`${BASE}/nope`);
    check("未知路径返回 404 JSON", () => assert.strictEqual(notFound.status, 404));

    const home = await fetch(`${BASE}/`);
    check("首页返回 HTML", () =>
      assert.match(home.headers.get("content-type") || "", /text\/html/)
    );

    if (process.env.SMOKE_SKIP_NETWORK !== "1") {
      const res = await fetch(`${BASE}/api.php?types=url&source=wy&id=3404293607&br=320`);
      const body = await res.json().catch(() => ({}));
      if (res.ok) {
        check("types=url 返回可播放地址", () => assert.match(body.url, /^https?:\/\//));
        console.log(`    → ${String(body.url).slice(0, 100)}… (script=${body.script})`);
      } else {
        console.log(`  ! 上游当前不可用，跳过取链断言：HTTP ${res.status} ${JSON.stringify(body).slice(0, 160)}`);
      }

      const sr = await fetch(
        `${BASE}/api.php?types=search&source=kuwo&name=${encodeURIComponent("稻香")}&count=3&pages=1`
      );
      const list = await sr.json().catch(() => null);
      if (sr.ok && Array.isArray(list) && list.length) {
        check("原生搜索（酷我）返回可用结果", () => {
          assert.ok(list[0].url_id, "缺少 url_id");
          assert.ok(list[0].name, "缺少歌名");
        });
        console.log(`    → ${list[0].name} / ${(list[0].artist || []).join("、")} (url_id=${list[0].url_id})`);
      } else {
        console.log(`  ! 酷我搜索上游不可用，跳过：HTTP ${sr.status}`);
      }
    }

    console.log(`\n通过 ${passed} 项检查`);
  } catch (e) {
    console.error("\n冒烟测试失败:", e.message);
    console.error(logs.join("").slice(-3000));
    process.exitCode = 1;
  } finally {
    child.kill("SIGTERM");
    setTimeout(() => child.kill("SIGKILL"), 2000).unref();
  }
})();
