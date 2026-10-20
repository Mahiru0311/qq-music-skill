/**
 * example-host.mjs —— 最小宿主接线示例（干跑：不打真实网络、不连 QQ）
 *
 * 演示一个宿主如何把 music.mjs 挂进自己的消息循环：
 *   消息入口归一化/命令解析 → /网易云 命令 run → 选歌拦截 handleMusicPick
 *   → 最终消息 Markdown 先行发送（失败降级纯文本）→ settleMusicStep 答后撤回。
 * sender / recall 都是假实现（只 console.log），Meting / 清和请求被 stub 拦截
 * 返回内置假数据。真实宿主把 sender 换成 QQ 官方 SDK 的发送方法即可，
 * 签名对照见 SKILL.md「快速接入」。
 *
 * 注意：本示例的最终链接是占位域名 https://你的域名/ —— 真实部署时先照
 * SKILL.md 的「播放页部署向导」把播放页支起来，再把 music.mjs 里的
 * PLAYER_PAGE 改成你自己的地址，这里的链接才会真实可点。
 *
 * 运行：node example-host.mjs
 */
import {
  findCommand, parseCommand, handleMusicPick, hasMusicSession,
  noteMusicPromptId, peekMusicPromptId, settleMusicStep, setMusicLogger,
} from "./music.mjs";

// ── 假数据 + 网络 stub（保持全离线） ─────────────────────
const FAKE_SONGS = [
  { name: "晴天", artist: "周杰伦", url: "https://api.qijieya.cn/meting/?server=netease&type=url&id=2652647226", pic: "", lrc: "" },
  { name: "稻香", artist: "周杰伦", url: "https://api.qijieya.cn/meting/?server=netease&type=url&id=3357698666", pic: "", lrc: "" },
];
globalThis.fetch = async (url) => {
  const u = String(url);
  if (u.includes("api.qijieya.cn/meting/") && u.includes("type=search")) {
    return { ok: true, status: 200, json: async () => FAKE_SONGS };
  }
  if (u.includes("api.qhsou.com/api/wyy2.php")) {
    return { ok: true, status: 200, json: async () => [FAKE_SONGS[0]] };
  }
  throw new Error(`example-host 禁止真实网络：${u}`);
};

// ── 假 sender / recall / 审计（真实宿主换成官方 SDK 实现） ──
let seq = 0;
const sender = {
  async sendText(target, text) {
    const id = `fake-${++seq}`;
    console.log(`[sendText → ${target.scope}:${target.targetId}] id=${id}\n${text}\n`);
    return { id };
  },
  async sendMarkdown(target, content) {
    const id = `fake-${++seq}`;
    console.log(`[sendMarkdown → ${target.scope}:${target.targetId}] id=${id}\n${content}\n`);
    return { id };
  },
};
async function fakeRecall(target, messageId) {
  console.log(`[recall → ${target.scope}:${target.targetId}] 撤回上一条提示 ${messageId}\n`);
}
setMusicLogger((line) => console.log(`[audit] ${line}`));

/** 最终消息发送契约：先 Markdown，失败降级纯文本（与生产宿主的 sendMarkdownFirst 一致） */
async function sendMarkdownFirst(target, result) {
  try {
    const sent = await sender.sendMarkdown(target, result.markdown);
    return { via: "Markdown", sentId: sent?.id || null };
  } catch {
    const sent = await sender.sendText(target, result.text || result.markdown);
    return { via: "纯文本兜底", sentId: sent?.id || null };
  }
}

// ── 宿主消息处理（对照生产接线顺序简化；限流/黑名单等宿主策略不在本模块内） ──
async function onMessage(msg, rawText) {
  const parsed = parseCommand(rawText); // 内部已做占位符剥离 + 空白折叠 + 无空格命令拆分
  const text = (parsed?.clean ?? rawText).trim();

  // 1) 选歌拦截：有会话且是纯数字 → 先 peek 列表提示 id，再 handleMusicPick
  if (hasMusicSession(msg) && /^\d{1,4}$/.test(text)) {
    const prevPromptId = peekMusicPromptId(msg); // 必须在 handleMusicPick 之前取（选歌成功会清会话）
    const pick = await handleMusicPick(msg, text);
    if (pick?.markdown) {
      const { via, sentId } = await sendMarkdownFirst(msg.replyTarget, pick);
      console.log(`[host] 选歌 ${text} -> 成功（${via}）`);
      await settleMusicStep(msg, {
        prevPromptId, sentId,
        advanced: !!pick.advanced, final: !!pick.final,
        who: `${msg.senderName}(${msg.senderId})`,
      }, (id) => fakeRecall(msg.replyTarget, id)); // 先发后撤；选错 advanced/final 皆假 → 不撤
    } else if (pick?.text) {
      await sender.sendText(msg.replyTarget, pick.text);
    }
    return;
  }

  // 2) 命令：parseCommand + findCommand 命中才执行（白名单）
  const cmd = parsed && findCommand(parsed.head);
  if (cmd) {
    const result = await cmd.run({ msg, args: parsed.args });
    if (result.error) { await sender.sendText(msg.replyTarget, `❌ ${result.error}`); return; }
    if (result.markdown) { // 直达流：直接就是最终消息，无会话、不登记待撤回
      const { via } = await sendMarkdownFirst(msg.replyTarget, result);
      console.log(`[host] 直达 -> 成功（${via}）`);
      return;
    }
    const sent = await sender.sendText(msg.replyTarget, result.text || "完成");
    if (cmd.triggers.includes("/网易云")) noteMusicPromptId(msg, sent?.id || null); // 搜歌列表登记为待撤回
    return;
  }

  console.log("[host] 未命中命令（真实宿主可在此接关键词/聊天/兜底）");
}

// ── 干跑剧本：群聊里走完「搜歌 → 选错 → 选歌」，再来一条链接直达 ──
const groupMsg = {
  kind: "group", groupOpenid: "GROUP_OPENID_DEMO",
  senderId: "USER_OPENID_DEMO", senderName: "示例用户",
  replyTarget: { scope: "group", targetId: "GROUP_OPENID_DEMO" },
};
console.log("—— 用户发：/网易云晴天（故意无空格，验证前缀拆分） ——");
await onMessage(groupMsg, "/网易云晴天");
console.log("—— 用户回：9（故意选错，验证不撤回、会话保留） ——");
await onMessage(groupMsg, "9");
console.log("—— 用户回：1（选第 1 首） ——");
await onMessage(groupMsg, "1");
console.log("—— 用户发：/网易云 https://music.163.com/song?id=2652647226（链接直达） ——");
await onMessage(groupMsg, "/网易云 https://music.163.com/song?id=2652647226");
console.log("干跑完成：搜歌列表在选歌成功后被撤回，聊天里只留最终播放链接；直达流不建会话、不撤回。");
