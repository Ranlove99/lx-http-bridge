/**
 * 纯函数单测：不联网，验证令牌与文本解析。
 * 用 node:test 跑，不引入任何依赖。
 */

import test from "node:test";
import assert from "node:assert/strict";

import { makeToken, readToken, decodeEntities, unescapeUnicode, splitArtists, preferHttps } from "../src/util.js";
import { parseKuwoJson, quoteSingleToDouble } from "../src/search.js";

test("封面令牌可往返，且能处理中文与特殊字符", () => {
  const url = "https://y.gtimg.cn/music/photo_new/T002R300x300M000003aAYrm3GE0Ac.jpg?a=1&b=中文";
  const token = makeToken(url);
  assert.ok(token.startsWith("px"));
  assert.equal(readToken(token), url);
});

test("取流令牌与封面令牌前缀隔离", () => {
  const url = "https://example.com/a.mp3";
  const stream = makeToken(url, "st");
  assert.equal(readToken(stream, "st"), url);
  assert.equal(readToken(stream, "px"), null);
});

test("非法令牌返回 null 而不是抛错", () => {
  assert.equal(readToken("px!!!!"), null);
  assert.equal(readToken(""), null);
  assert.equal(readToken(null), null);
  assert.equal(readToken(makeToken("javascript:alert(1)")), null);
});

test("单引号伪 JSON 能转成标准 JSON", () => {
  const raw = `{"abslist":[{'SONGNAME':'稻香','ARTIST':'周杰伦'}]}`;
  const parsed = parseKuwoJson(raw);
  assert.equal(parsed.abslist[0].SONGNAME, "稻香");
  assert.equal(parsed.abslist[0].ARTIST, "周杰伦");
});

test("标准 JSON 直接走快速路径", () => {
  assert.deepEqual(parseKuwoJson('{"a":1}'), { a: 1 });
});

test("非法输入返回 null 而不是抛错", () => {
  assert.equal(parseKuwoJson(""), null);
  assert.equal(parseKuwoJson("not json at all"), null);
});

test("\\uXXXX 与多层反斜杠能还原", () => {
  assert.equal(unescapeUnicode("\\u7a3b\\u9999"), "稻香");
  assert.equal(unescapeUnicode("\\\\u7a3b\\u9999"), "稻香");
});

test("HTML 实体与标签被清理", () => {
  assert.equal(decodeEntities("A&nbsp;&amp;&nbsp;B"), "A & B");
  assert.equal(decodeEntities("<b>稻香</b>"), "稻香");
  assert.equal(decodeEntities("&#x7a3b;&#39321;"), "稻香");
});

test("歌手字段按常见分隔符拆分", () => {
  assert.deepEqual(splitArtists("周杰伦&方文山"), ["周杰伦", "方文山"]);
  assert.deepEqual(splitArtists("周杰伦、方文山"), ["周杰伦", "方文山"]);
  assert.deepEqual(splitArtists([{ name: "周杰伦" }, { name: "方文山" }]), ["周杰伦", "方文山"]);
});

test("http 地址会被升级为 https，https 保持不变", () => {
  assert.equal(preferHttps("http://a.com/x.mp3"), "https://a.com/x.mp3");
  assert.equal(preferHttps("https://a.com/x.mp3"), "https://a.com/x.mp3");
  assert.equal(preferHttps(""), "");
});

test("引号转换保留转义字符", () => {
  const out = quoteSingleToDouble("'a\\'b'");
  assert.equal(JSON.parse(out), "a'b");
});
