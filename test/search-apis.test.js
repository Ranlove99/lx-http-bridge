"use strict";

/**
 * 搜索适配层的纯函数单测（不联网）。
 * `node test/search-apis.test.js`
 */

const assert = require("node:assert");
const {
  parseKuwoJson,
  decodeEntities,
  unescapeUnicode,
  splitArtists,
  quoteSingleToDouble,
} = require("../search-apis");

let passed = 0;
const check = (name, fn) => {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
};

// 酷我真实返回的片段（单引号伪 JSON + 双重转义）
const KUWO_SAMPLE =
  "{'HIT':'1337','abslist':[{'MUSICRID':'MUSIC_91637031','SONGNAME':'稻香&nbsp;(Live)'," +
  "'ARTIST':'TFBOYS\\\\u0026TF家族','ALBUM':'魔杰座','DURATION':'209','PICPATH':''}," +
  "{'MUSICRID':'MUSIC_554198768','SONGNAME':'稻&nbsp;香','ARTIST':'沐云轩'," +
  "'ALBUM':'三角洲','DURATION':'182','web_albumpic_short':'120/s4s76/43/761738347.jpg'}]}";

check("单引号伪 JSON 能被转换成标准 JSON", () => {
  const converted = quoteSingleToDouble(KUWO_SAMPLE);
  assert.doesNotThrow(() => JSON.parse(converted));
});

check("parseKuwoJson 能解析出 abslist", () => {
  const data = parseKuwoJson(KUWO_SAMPLE);
  assert.ok(data, "应解析成功");
  assert.strictEqual(data.abslist.length, 2);
  assert.strictEqual(data.abslist[0].MUSICRID, "MUSIC_91637031");
});

check("标准 JSON 直接走快速路径", () => {
  const data = parseKuwoJson('{"abslist":[{"MUSICRID":"MUSIC_1"}]}');
  assert.strictEqual(data.abslist[0].MUSICRID, "MUSIC_1");
});

check("非法输入返回 null 而不是抛错", () => {
  assert.strictEqual(parseKuwoJson("not json at all {{{"), null);
  assert.strictEqual(parseKuwoJson(""), null);
});

check("解码 &nbsp; / &amp; 等实体", () => {
  assert.strictEqual(decodeEntities("稻香&nbsp;(Live)"), "稻香 (Live)");
  assert.strictEqual(decodeEntities("A&amp;B"), "A&B");
  assert.strictEqual(decodeEntities("&#39;q&#39;"), "'q'");
  assert.strictEqual(decodeEntities("<b>粗体</b>"), "粗体");
});

check("多层反斜杠的 \\uXXXX 能还原成字符", () => {
  assert.strictEqual(unescapeUnicode("TFBOYS\\u0026TF家族"), "TFBOYS&TF家族");
  assert.strictEqual(unescapeUnicode("TFBOYS\\\\u0026TF家族"), "TFBOYS&TF家族");
});

check("歌手字段按常见分隔符拆分", () => {
  assert.deepStrictEqual(splitArtists("周杰伦"), ["周杰伦"]);
  assert.deepStrictEqual(splitArtists("TFBOYS&TF家族"), ["TFBOYS", "TF家族"]);
  assert.deepStrictEqual(splitArtists("周杰伦、方文山"), ["周杰伦", "方文山"]);
  assert.deepStrictEqual(splitArtists([{ name: "周杰伦" }, "杨瑞代"]), ["周杰伦", "杨瑞代"]);
});

check("完整映射：rid 去前缀、封面路径拼成地址", () => {
  const data = parseKuwoJson(KUWO_SAMPLE);
  const rid = String(data.abslist[0].MUSICRID).replace(/^MUSIC_/, "");
  assert.strictEqual(rid, "91637031");
  assert.strictEqual(data.abslist[0].web_albumpic_short, undefined);
  assert.strictEqual(data.abslist[1].web_albumpic_short, "120/s4s76/43/761738347.jpg");
});

console.log(`\n通过 ${passed} 项检查`);
