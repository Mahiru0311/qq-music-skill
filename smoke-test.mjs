/**
 * smoke-test.mjs —— qq-netease-music 离线自检（随包走）
 *
 * 用法：node smoke-test.mjs
 * 全部离线：不打 Meting / 清和接口、不连 QQ（fetch 被 stub 拦截）。
 * 覆盖：命令解析（归一化/无空格拆分）、extractNeteaseId 直达解析、
 * searchNetease 自动重试（空结果/异常/预算内成功）、搜歌→选歌全流程、
 * musicPlayUrl 拼播放页链接（带 &v= 版本参数）与无 id 回退、答后撤回编排、
 * 会话过期。全绿（exit 0）才算包是好的，接入前先跑一遍。
 */
import {
  cleanHtml, parseCommand, findCommand, extractNeteaseId, searchNetease,
  neteaseById, musicPlayUrl, musicFinalResult, handleMusicPick, hasMusicSession,
  noteMusicPromptId, peekMusicPromptId, settleMusicStep, setMusicLogger,
  __test_setMusicSearchRetryDelays, __test_backdateMusicSession,
  PLAYER_PAGE, PLAYER_PAGE_VERSION, MUSIC_TTL_MS,
} from "./music.mjs";

let pass = 0, fail = 0;
function check(name, cond, extra = "") {
  if (cond) { pass++; console.log(` ✔ ${name}`); }
  else { fail++; console.log(` ✘ ${name} ${extra}`); }
}

// ── 网络 stub（保持全离线） ──────────────────────────────
const SEARCH_SONGS = [
  { name: "晴天", artist: "周杰伦", url: "https://api.qijieya.cn/meting/?server=netease&type=url&id=2652647226", pic: "https://api.qijieya.cn/meting/?server=netease&type=pic&id=2652647226", lrc: "https://api.qijieya.cn/meting/?server=netease&type=lrc&id=2652647226" },
  { name: "稻香", artist: "周杰伦", url: "https://api.qijieya.cn/meting/?server=netease&type=url&id=3357698666", pic: "", lrc: "" },
];
let searchScript = [];
globalThis.fetch = async (url) => {
  const u = String(url);
  if (u.includes("api.qijieya.cn/meting/") && u.includes("type=search")) {
    const next = searchScript.length ? searchScript.shift() : SEARCH_SONGS;
    if (next === "ERR") throw new Error("mock boom");
    return { ok: true, status: 200, json: async () => next };
  }
  if (u.includes("api.qhsou.com/api/wyy2.php")) {
    return { ok: true, status: 200, json: async () => [SEARCH_SONGS[0]] };
  }
  throw new Error(`smoke-test 禁止真实网络：${u}`);
};
__test_setMusicSearchRetryDelays([1, 1]); // 自检里把重试间隔压到 1ms，不真等

console.log("== 1. 命令解析（归一化 / 无空格拆分 / 防误伤） ==");
{
  const p1 = parseCommand("<@ABC123DEF> /网易云 晴天");
  check("占位符剥离+归一化", p1?.head === "/网易云" && p1?.args === "晴天", JSON.stringify(p1));
  const p2 = parseCommand("/网易云晴天");
  check("无空格命令拆分", p2?.head === "/网易云" && p2?.args === "晴天" && !!findCommand(p2.head), JSON.stringify(p2));
  const p3 = parseCommand("／网易云 稻香");
  check("全角斜杠归一化", p3?.head === "/网易云" && p3?.args === "稻香", JSON.stringify(p3));
  const p4 = parseCommand("/网易云台");
  check("防误伤：余下 1 字不拆", p4?.head === "/网易云台" && !findCommand(p4.head), JSON.stringify(p4));
}

console.log("== 2. extractNeteaseId（链接 / ID 直达解析） ==");
{
  check("?id= 链接", extractNeteaseId("https://music.163.com/song?id=2652647226") === "2652647226");
  check("/song/123 链接", extractNeteaseId("https://music.163.com/song/186016") === "186016");
  check("分享文案里嵌链接", extractNeteaseId("分享周杰伦的单曲《晴天》: https://music.163.com/#/song?id=12345 好听") === "12345");
  check("纯数字 ID（≥5 位）", extractNeteaseId("186016") === "186016");
  check("歌名不提 id", extractNeteaseId("晴天") === null);
  check("4 位数字不算 ID", extractNeteaseId("1234") === null);
}

console.log("== 3. musicPlayUrl（拼播放页 + v 参数 / 无 id 回退） ==");
{
  check("占位播放页地址", PLAYER_PAGE === "https://你的域名/", PLAYER_PAGE);
  check("有 id 拼播放页且带 &v=", musicPlayUrl(SEARCH_SONGS[0]) === `https://你的域名/?id=2652647226&v=${PLAYER_PAGE_VERSION}`, musicPlayUrl(SEARCH_SONGS[0]));
  check("无 id 回退 Meting url 原样", musicPlayUrl({ name: "x", url: "https://example.com/a.mp3" }) === "https://example.com/a.mp3");
  const fin = musicFinalResult(SEARCH_SONGS[0]);
  check("最终消息 markdown+text+final", fin.final === true && fin.markdown.includes("[▶ 点我播放](https://你的域名/?id=2652647226") && fin.text.includes("《晴天》 - 周杰伦"), JSON.stringify(fin));
}

console.log("== 4. searchNetease 自动重试 ==");
{
  searchScript = [[], SEARCH_SONGS];
  const r1 = await searchNetease("晴天");
  check("第一次空、重试后拿到结果", r1.length === 2 && r1[0].name === "晴天");
  searchScript = ["ERR", SEARCH_SONGS];
  const r2 = await searchNetease("晴天");
  check("第一次异常、重试后拿到结果", r2.length === 2);
  searchScript = [[], [], []];
  const r3 = await searchNetease("不存在的歌xyz");
  check("三次全空返回 []（走没搜到）", Array.isArray(r3) && r3.length === 0);
  searchScript = ["ERR", "ERR", "ERR"];
  let threw = false;
  try { await searchNetease("晴天"); } catch { threw = true; }
  check("三次全异常抛错（走开小差）", threw);
  const byId = await neteaseById("2652647226");
  check("neteaseById 按 ID 取元信息", byId.length === 1 && byId[0].name === "晴天");
}

console.log("== 5. 全流程：搜歌 → 选错 → 选歌（群聊） ==");
const gmsg = { kind: "group", groupOpenid: "g-smoke", senderId: "smoke-user", senderName: "烟测", replyTarget: { scope: "group", targetId: "g-smoke" } };
{
  const cmd = findCommand("/网易云");
  searchScript = [SEARCH_SONGS];
  const r = await cmd.run({ msg: gmsg, args: "晴天" });
  check("搜歌列表带编号与群提示", r.text.includes("1. 晴天 - 周杰伦") && r.text.includes("2. 稻香 - 周杰伦") && r.text.includes("（下一步请 @我 再回序号"), r.text);
  check("会话已建立", hasMusicSession(gmsg));
  noteMusicPromptId(gmsg, "id-list");
  check("peek 拿到列表提示 id", peekMusicPromptId(gmsg) === "id-list");
  const bad = await handleMusicPick(gmsg, "9");
  check("选错报错且保留会话", bad.text.includes("没有第 9 首") && hasMusicSession(gmsg) && !bad.final, bad.text);
  const prev = peekMusicPromptId(gmsg);
  const pick = await handleMusicPick(gmsg, "2");
  check("选歌出最终消息且清会话", pick.final === true && pick.markdown.includes("《稻香》") && pick.markdown.includes("id=3357698666") && !hasMusicSession(gmsg), JSON.stringify(pick));
  const recalled = [];
  const settled = await settleMusicStep(gmsg, { prevPromptId: prev, sentId: "id-final", advanced: false, final: true, who: "烟测(smoke-user)" }, async (id) => { recalled.push(id); });
  check("settle 撤回搜歌列表、最终消息不撤", settled === "id-list" && recalled.join() === "id-list", recalled.join());
}

console.log("== 6. 直达流（链接入参跳过搜索、不建会话） ==");
{
  const cmd = findCommand("/网易云");
  const r = await cmd.run({ msg: gmsg, args: "https://music.163.com/song?id=2652647226" });
  check("链接直达直接出最终消息", r.final === true && r.markdown.includes("id=2652647226") && !hasMusicSession(gmsg), JSON.stringify(r));
  const e = await cmd.run({ msg: gmsg, args: "" });
  check("空入参回用法报错", !!e.error && e.error.includes("用法"), JSON.stringify(e));
  searchScript = [[], [], []];
  const none = await cmd.run({ msg: gmsg, args: "不存在的歌xyz" });
  check("搜不到回没搜到文案且不建会话", none.text.includes("没搜到") && !hasMusicSession(gmsg), JSON.stringify(none));
}

console.log("== 7. 会话过期 + 撤回失败不阻塞 ==");
{
  const m = { kind: "c2c", groupOpenid: "", senderId: "smoke-user-2", senderName: "烟测2" };
  const cmd = findCommand("/网易云");
  searchScript = [SEARCH_SONGS];
  await cmd.run({ msg: m, args: "晴天" });
  __test_backdateMusicSession(m, MUSIC_TTL_MS + 1000);
  const r = await handleMusicPick(m, "1");
  check("超 5 分钟回超时提示且清会话", r.text.includes("选歌超时了") && !hasMusicSession(m), r.text);
  const settled = await settleMusicStep(m, { prevPromptId: "id-x", sentId: "id-y", advanced: false, final: true, who: "烟测2" }, async () => { throw new Error("平台拒绝"); });
  check("撤回失败返回 null 不抛错", settled === null);
}

console.log("== 8. 审计 logger 注入 ==");
{
  const logs = [];
  setMusicLogger((line) => logs.push(line));
  searchScript = [[], SEARCH_SONGS];
  await searchNetease("晴天");
  check("重试轨迹写进注入的 logger", logs.some((l) => l.includes("music search") && l.includes("retried=true")), logs.join(" | "));
  setMusicLogger(null);
  check("cleanHtml 仍可用", cleanHtml("&amp;nbsp;歌") === "歌");
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
