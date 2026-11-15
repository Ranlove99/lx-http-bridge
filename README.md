# lx-http-bridge

把音源脚本 / 平台接口包装成 **GD Studio 兼容的 HTTP 接口**（`/api.php?types=search|url|pic`），
可以直接填进 otter-music 一类客户端的「音源地址」。

仓库里有两个实现，按场景选一个：

| 版本 | 目录 | 能力 | 部署方式 |
| --- | --- | --- | --- |
| **Node 版** | 根目录 | 运行洛雪（LX Music）`.js` 音源脚本，覆盖 9 个平台 + 原生搜索兜底 | VPS / 本机 / 任意 Node 环境 |
| **Workers 版** | [`worker/`](worker/) | 不跑脚本，用平台原生接口做搜索与取链，覆盖酷我 / 酷狗 / QQ | Cloudflare Workers（免费额度足够） |

> **为什么 Workers 版不跑脚本**：Cloudflare Workers 没有 `node:vm`，并且禁止动态代码执行
> （`eval` / `new Function` 会被 CSP 拦掉），无法承载任意 `.js` 脚本。
> 因此 Workers 版改为直接对接平台接口 —— 好处是零依赖、免维护、无需内网穿透；
> 代价是只覆盖三个平台，且 VIP / 付费曲目同样取不到（这一点与洛雪脚本的表现一致）。

---

## 一、Workers 版（推荐，免服务器）

### 部署

**方式 A：Cloudflare 控制台连接本仓库（推荐，不用装任何东西）**

1. Cloudflare Dashboard → **Workers & Pages** → **Create** → **Workers** → **Connect to Git**
2. 授权并选择仓库 `Ranlove99/lx-http-bridge`
3. 按下表填写：

| 字段 | 填什么 |
| --- | --- |
| Worker name | `lx-http-bridge` |
| Root directory（Advanced settings 里） | **留空**即可（仓库根目录已有 `wrangler.jsonc`）；填 `worker` 也等价 |
| Build command | `npm install` |
| Deploy command | `npx wrangler deploy` |
| Build variable（可选，建议加） | `NODE_VERSION` = `22` |

4. 保存并部署，得到 `https://lx-http-bridge.<你的子域>.workers.dev`

> 根目录的 `wrangler.jsonc` 把 `main` 指向 `worker/src/index.js`，所以即使 Root directory 留空，
> `wrangler deploy` 也会正确打包 Workers 版，而不会去动 Node 版的 `server.js`。
> `wrangler` 已在 `worker/package.json` 里钉到 `4.162.0` 并提交了 `package-lock.json`，
> 构建用的版本是确定的，不会因为平台默认版本比 `compatibility_date` 旧而报错。

**方式 B：命令行**

```bash
cd worker
npm install
npx wrangler login     # 只需一次
npx wrangler deploy
```

**方式 C：本地预览**

```bash
cd worker
npm install
npx wrangler dev       # 默认 http://127.0.0.1:8787
```

### 验证

```bash
BASE=https://lx-http-bridge.<你的子域>.workers.dev

curl "$BASE/health"
curl "$BASE/api.php?types=search&source=kuwo&name=%E7%A8%BB%E9%A6%99&count=5"
curl "$BASE/api.php?types=url&source=kuwo&id=91637031&br=192"
```

### 测试

```bash
cd worker
npm test        # 11 项纯函数单测 + 16 项真实接口 smoke
```

`test/smoke.js` 直接把 Worker 的 `fetch` handler 跑在 Node 里（Node 18+ 自带 `Request`/`Response`/`fetch`），
所以**不需要 workerd 也能测真实链路**。

---

## 二、Node 版（完整洛雪脚本支持）

```bash
npm start                     # 默认 3000 端口
PORT=8787 HOST=0.0.0.0 npm start
```

### 配置 `config.json`

仓库里只提交了 `config.example.json`（`config.json` 含管理口令，已在 `.gitignore` 中排除）：

```bash
cp config.example.json config.json
```

```jsonc
{
  "adminToken": "改成你自己的随机串",   // /admin/scripts 导入脚本的口令
  "env": "desktop",
  "version": "2.0.0",
  "timeoutMs": 12000,        // 单次脚本调用超时
  "initTimeoutMs": 8000,     // 脚本注册 inited 的超时
  "urlCacheTtlMs": 300000,   // 取链结果缓存 5 分钟
  "proxyStream": false,      // true 则所有音频都经本服务中转
  "sourceUrls": [],          // 远程脚本地址，启动时自动拉取
  "priority": ["xinghai", "huibq", "hyw", "jiexiang", "qingliang"]
}
```

`priority` 决定询问顺序：取链时依次问脚本，**第一个成功的胜出**。

### 导入 / 管理脚本

```bash
# 查看已加载脚本
curl http://127.0.0.1:8787/sources

# 导入一个 .js 音源脚本
curl -X POST http://127.0.0.1:8787/admin/scripts \
  -H "X-Admin-Token: $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"name\":\"my-source\",\"code\":\"$(cat source.js | python3 -c 'import json,sys;print(json.dumps(sys.stdin.read()))')\"}"
```

导入的脚本会落盘到 `data/scripts.json`，重启后仍在。

---

## 三、接口

所有接口都在 `/api.php`（也接受 `/api`、`/music-api`），响应带 `Access-Control-Allow-Origin: *`。

### `types=search`

| 参数 | 说明 |
| --- | --- |
| `name` | 关键词（也接受 `keyword` / `q`） |
| `source` | `kuwo` / `kugou` / `qq`（Node 版还支持脚本声明的其它平台） |
| `pages` / `count` | 页码（从 1 开始）/ 每页条数 |

返回数组，每项形如：

```json
{
  "id": "91637031",
  "name": "稻香",
  "artist": ["周杰伦"],
  "album": "魔杰座",
  "pic_id": "pxaHR0cHM6...",
  "url_id": "91637031",
  "lyric_id": "91637031",
  "source": "kuwo",
  "duration": 223
}
```

`url_id` 就是下一步取链要传的 `id`。`pic_id` 是不透明令牌，用 `types=pic` 换回封面地址。

### `types=url`

| 参数 | 说明 |
| --- | --- |
| `source` | 音源 |
| `id` | 搜索返回的 `url_id` |
| `br` | 期望码率，如 `128` / `320` |

```json
{
  "url": "https://kw-er.kuwo.cn/.../M500004PbtOD3b2whF.mp3",
  "br": 192,
  "source": "kuwo",
  "quality": "192k",
  "via": "kuwo-antiserver",
  "raw": "https://kw-er.kuwo.cn/...",
  "proxied": false
}
```

- 取不到地址时返回 **404**（带 `error` 说明），调用方应继续回退下一个音源。
- `proxied: true` 表示该地址是明文 http，已改走本服务的 `/stream` 中转（Range 透传），
  避免 https 页面被混合内容拦截。

### `types=pic`

`id` 传 `pic_id`，返回 `{ "url": "https://..." }`。

### 其它

- `GET /health` — 存活与能力自检
- `GET /sources` — 支持的音源与端点
- `GET /stream?u=<令牌>` — 音频中转（仅当 `proxied` 为 true 时使用）
- `GET /` — 简单说明页

---

## 四、接到 otter-music

在 `https://<你的 otter-music 域名>/admin` → 音源管理里新增一条：

```
名称：lx-http-bridge
地址：https://lx-http-bridge.<你的子域>.workers.dev/api.php
```

排到第一位即可（first success wins）。GD Studio 之类的公共接口可以作为兜底排在后面。

### ⚠️ 如果客户端本身也是 Worker：必须用 Service Binding

**一个 Worker 不能 fetch 另一个 Worker 的 `*.workers.dev` 地址**（同一账号下）。
Cloudflare 会判定为同 zone 回环，返回 `error code: 1042`，表现为上游恒 404、
请求静默回退到下一个音源——看起来就像「桥接没生效」。

正确做法是 service binding（内部调用，不走公网）：

```jsonc
// 客户端 Worker 的 wrangler.jsonc
{
  "services": [
    { "binding": "LX_BRIDGE", "service": "lx-http-bridge" }
  ]
}
```

```ts
// 命中桥接域名时走绑定，其余照常 fetch
const bridge = c.env.LX_BRIDGE;
const res =
  bridge && /(^|\.)lx-http-bridge\./i.test(new URL(targetUrl).hostname)
    ? await bridge.fetch(targetUrl, { headers: { "User-Agent": UA } })
    : await fetch(targetUrl, { headers: { "User-Agent": UA } });
```

otter-music 仓库已按此实现（`functions/routes/music.ts` 的 `fetchUpstream()`）。
若客户端部署在 Pages 或本地 dev（没有 binding），代码会自动回退到公网 fetch。

> 另外：otter-music 的 Worker 对 `/music-api` 响应做了 Cache API 缓存，
> 但 `types=url`（播放地址）已排除在缓存之外 —— 带签名的地址缓存会导致「点了没声音」。

---

## 五、已知限制

- **VIP / 付费曲目**：三个平台都会拒绝，返回 404。这与洛雪脚本一致，不是本服务的 bug。
- **Workers 版没有歌词**：`types=lyric` 恒返回 404。
- **Workers 版不支持脚本**：需要更多平台或需要脚本特有逻辑时，用 Node 版。
- **酷狗搜索走 http**：`mobilecdn.kugou.com` 的证书与域名不匹配，只能明文请求（服务端发起，无混合内容问题）。
- **Node 版的公网暴露**：如果放在家里 / 内网，需要自己做内网穿透或反向代理，并给 `/admin/*` 设好 `adminToken`。

## 六、目录结构

```
.
├── server.js            # Node 版入口（HTTP 服务 + GD Studio 兼容路由）
├── lx-runtime.js        # 洛雪脚本运行时（vm 沙箱 + globalThis.lx）
├── search-apis.js       # 原生搜索（酷我 / 酷狗 / QQ）
├── sources/             # 内置洛雪脚本
├── test/                # Node 版测试（8 项单测 + 11 项 smoke）
└── worker/              # Cloudflare Workers 版
    ├── src/index.js     # fetch 入口与路由
    ├── src/search.js    # 原生搜索
    ├── src/resolve.js   # 原生取链
    ├── src/util.js      # 抓取 / 清洗 / 令牌 / CORS
    ├── wrangler.jsonc
    └── test/            # 11 项单测 + 16 项 smoke
```

## 许可

仅供个人学习与自用。音源数据版权归各平台所有，请勿用于商业用途。
