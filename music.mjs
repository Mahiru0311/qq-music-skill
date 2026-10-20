/**
 * music.mjs —— /网易云 点歌功能（独立抽取版）
 *
 * 本文件自 QQ 机器人 commands.mjs 抽取音乐相关代码：函数体与线上原文逐字
 * 一致（抽取时按行区间机械切取、逐函数与原文对照过），仅做必要的解耦，
 * 使其可独立于原机器人运行/复用：
 *  1. 原文件的 audit() 直写审计文件 → 这里改为可注入的 log 回调：宿主调用
 *     setMusicLogger(fn) 注入（fn 收到与原审计完全相同的行文本，时间戳/落盘
 *     由宿主负责）；未注入时静默。searchNetease / settleMusicStep 内部仍以
 *     audit(...) 形式调用，函数体与原文一致。
 *  2. 命令注册表只保留 /网易云 本命令：parseCommand / splitGluedCommand /
 *     findCommand 的算法与原文一致，只是候选触发词来自本文件内的 COMMANDS。
 *  3. musicSessionKey 线上是转调同文件的 movieSessionKey → 这里内联同一条
 *     key 公式（kind:groupOpenid:senderId），结果完全一致。
 *  4. PLAYER_PAGE 线上是部署者的自有域名 → 包内改为占位符「https://你的域名/」，
 *     部署时改成你自己的播放页地址即可（怎么来，见 SKILL.md 的部署向导）。
 *  5. 不 import 原机器人目录下的任何文件，零第三方依赖（仅用 Node 内置
 *     全局 fetch / AbortSignal）。凭证与本模块无关，模块内不含任何凭证。
 *
 * 宿主需要提供的运行时形状（详见 SKILL.md 的「宿主集成契约」）：
 *  - msg：{ kind: "group"|"c2c", groupOpenid, senderId, senderName, replyTarget }
 *  - target（replyTarget）：{ scope: "group"|"c2c", targetId }
 *  - sender：sendText(target, text) / sendMarkdown(target, content)，
 *    均返回带 id 的发送结果；最终消息（markdown 字段）先 Markdown、失败降级纯文本
 *  - recall：(messageId) => Promise，由宿主在 settleMusicStep 调用时注入
 */

// ── 可注入审计 logger（解耦点 1） ────────────────────────
let _musicLogger = () => {};
export function setMusicLogger(fn) {
  _musicLogger = typeof fn === "function" ? fn : () => {};
}
function audit(line) {
  _musicLogger(line);
}

// ── HTML 清理：清和 API 的简介混着 HTML 实体/标签，且有双重编码 ──
export function cleanHtml(s) {
  let t = String(s || "");
  for (let i = 0; i < 3; i++) {
    t = t.replace(/<[^>]*>/g, "");
    const next = t
      .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
      .replace(/&nbsp;|&#160;/g, " ")
      .replace(/&quot;/g, '"')
      .replace(/&#39;|&#x27;/g, "'")
      .replace(/&#(\d+);/g, (_, n) => {
        try { return String.fromCharCode(Number(n)); } catch { return ""; }
      })
      .replace(/&amp;/g, "&");
    if (next === t) break;
    t = next;
  }
  return t.replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();
}

// ── 命令解析：先剥掉开头的 <@...> 提及，再做命令归一化 ────
// 归一化（用户 2026-10-20 要求）：全角斜杠 ／ → /；"/ 电影" 这类斜杠后带空格
// （含全角空格）→ "/电影"，避免 "/ 电影 蜘蛛侠" 掉进聊天被模型编借口。
/**
 * 入口文本归一化：GROUP_MESSAGE_CREATE 的原始串自带 `<@openid>` 提及占位符
 * （十六进制 openid，非纯数字），并且可能带多余空白。
 * 归一化：剥掉任意位置的占位符、折叠全部空白（含全角空格/制表）为单空格、去首尾。
 * 在 bot.mjs 消息入口对 content 调用；parseCommand 内部也走它。
 */
export function normalizeIncomingText(text) {
  return String(text || "")
    .replace(/<@[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function normalizeCommandText(text) {
  let clean = normalizeIncomingText(text);
  clean = clean.replace(/／/g, "/");
  clean = clean.replace(/^\/\s+/, "/");
  return clean;
}
export function parseCommand(text) {
  const clean = normalizeCommandText(text);
  const m = clean.match(/^(\S+)\s*([\s\S]*)$/);
  if (!m) return null;
  let head = m[1];
  let args = (m[2] || "").trim();
  // 无空格命令前缀拆分（2026-10-20 实测：「/电影蜘蛛侠」按空白切 head 是整串、
  // 匹配不到触发词，会掉进聊天被模型乱答）。整词匹配不到时：若 head 以某个触发词
  // （及其带/不带斜杠变体）开头、且余下部分 ≥ 2 字，拆成 head=触发词、args=余下
  // 部分（+ 原 args）。余下 < 2 字不拆，防「/电影院」误拆成搜「院」。
  if (!findCommand(head)) {
    const split = splitGluedCommand(head);
    if (split) {
      head = split.head;
      args = (split.rest + (args ? ` ${args}` : "")).trim();
    }
  }
  return { head, args, clean };
}

/**
 * 无空格命令拆分：head 以触发词开头且余下 ≥ 2 字时返回 { head: 触发词, rest }，
 * 否则返回 null。候选含触发词的带/不带斜杠两种形态，按长度降序优先匹配最长。
 * （余下 1 字不拆：如「/电影院」不许拆成搜「院」；纯数字占位符类不变）
 */
export function splitGluedCommand(head) {
  if (!head) return null;
  const candidates = new Set();
  for (const c of COMMANDS) {
    for (const t of c.triggers) {
      candidates.add(t);
      candidates.add(t.startsWith("/") ? t.slice(1) : `/${t}`);
    }
  }
  for (const t of [...candidates].sort((a, b) => b.length - a.length)) {
    if (head.startsWith(t) && head.length - t.length >= 2) {
      return { head: t, rest: head.slice(t.length) };
    }
  }
  return null;
}

export function findCommand(head) {
  if (!head) return undefined;
  // 带不带斜杠都认："/电影" 的触发词是 "/电影"，裸 "电影" 也能命中（消息以「电影 <名>」开头当命令）；
  // 反之 "/天气" 也能命中裸触发词 "天气"。/help 等同样受益。
  const variants = head.startsWith("/") ? [head, head.slice(1)] : [head, `/${head}`];
  return COMMANDS.find((c) => variants.some((v) => c.triggers.includes(v)));
}

export function musicSessionKey(msg) {
  const kind = msg?.kind || "c2c";
  const scope = msg?.groupOpenid || "-";
  return `${kind}:${scope}:${msg?.senderId || "anon"}`;
}

// 群聊里机器人只能收到 @ 它的消息：/电影 每一步提示（选片/选线/选集/报错）在群里
// 都要提醒「下一步 @我 再回序号」，否则用户裸回数字机器人根本收不到、误以为卡死
// （2026-10-20 用户实测）。私聊（C2C）不加。
const GROUP_PICK_HINT = "（下一步请 @我 再回序号，不 @ 我收不到）";
function withGroupHint(msg, text) {
  return msg?.kind === "group" ? `${text}\n${GROUP_PICK_HINT}` : text;
}

// ── 命令注册表（解耦点 2：独立版只注册 /网易云 本命令，条目与原文一致） ──
export const COMMANDS = [
  {
    triggers: ["/网易云"],
    adminOnly: false,
    help: "/网易云 <歌名> —— 搜网易云歌曲（回序号选歌拿播放链接；也可直接发歌曲链接或ID）",
    async run({ msg, args }) {
      const raw = (args || "").trim();
      if (!raw) return { error: "用法：/网易云 <歌名>，比如：/网易云 晴天；也可以直接发网易云歌曲链接" };
      // 链接 / 纯数字 ID 直达：走清和 wyy2 取元信息，跳过搜索
      const id = extractNeteaseId(raw);
      if (id) {
        let songs;
        try {
          songs = await neteaseById(id);
        } catch (e) {
          return { error: `网易云服务开小差了：${e.name === "AbortError" ? "超时" : (e.message || e)}` };
        }
        if (!songs.length) return { text: `没查到这首歌（ID ${id}），换个链接试试` };
        return musicFinalResult(songs[0]);
      }
      const name = raw.slice(0, 40);
      let songs;
      try {
        songs = await searchNetease(name);
      } catch (e) {
        return { error: `网易云服务开小差了：${e.name === "AbortError" ? "超时" : (e.message || e)}` };
      }
      if (!songs.length) return { text: `没搜到《${name}》，换个名字或直接发网易云链接试试` };
      const shown = songs.slice(0, 10);
      _musicSessions.set(musicSessionKey(msg), { list: shown, ts: Date.now() });
      const rows = shown.map((s, i) => `${i + 1}. ${cleanHtml(s?.name || "?")} - ${cleanHtml(s?.artist || "?")}`);
      const more = songs.length > shown.length ? `（只列前 ${shown.length} 首）` : "";
      return {
        text: withGroupHint(msg, [
          `🎵 搜「${cleanHtml(name)}」共 ${songs.length} 首${more}，回序号选歌（5分钟内有效）：`,
          ...rows,
        ].join("\n").slice(0, 1500)),
      };
    },
  },
];

// ── /网易云 选歌会话：与电影会话同构但独立表（场景+发送者隔离，5 分钟过期）──
export const MUSIC_TTL_MS = 5 * 60 * 1000;
const _musicSessions = new Map(); // key -> { list, ts }

export function hasMusicSession(msg) {
  return _musicSessions.has(musicSessionKey(msg));
}

// ── 选歌答后撤回上一条提示：与电影 settleMovieStep 同构（用户 2026-10-20 定）──
// 搜歌列表发出后，bot 侧把返回的 message_id 登记进会话（noteMusicPromptId）；
// 选歌成功、最终消息（🎵+播放页链接）确认发出后，再撤回那条列表（settleMusicStep）。
// 最终消息永不登记、永不撤；选错序号（会话保留）不撤；直达流没有列表、不登记不撤；
// 撤回失败只记审计、绝不阻塞流程。平台限制：自发消息 2 分钟内可撤回。
// 音乐只有一步待撤提示（搜歌列表），没有电影那种多级中间步，故 settle 的
// 「中间步续登记」分支（advanced && !final）实际不会触发，保留同构签名以便对齐契约。
export function noteMusicPromptId(msg, id) {
  const s = _musicSessions.get(musicSessionKey(msg));
  if (s && id) s.promptId = String(id);
}

export function peekMusicPromptId(msg) {
  return _musicSessions.get(musicSessionKey(msg))?.promptId || null;
}

/**
 * 选歌一步的收尾：在 handleMusicPick 之前 peek 出 prevPromptId，最终消息发送
 * 拿到 sentId 后调用本函数。成功推进（advanced/final）且有 prevPromptId 时
 * 执行 recall 回调撤回搜歌列表提示。返回实际撤回的 id 或 null（失败也返回 null，不抛错）。
 */
export async function settleMusicStep(msg, { prevPromptId, sentId, advanced, final, who }, recall) {
  if (advanced && !final && sentId) noteMusicPromptId(msg, sentId);
  if (!(advanced || final) || !prevPromptId) return null;
  try {
    await recall(prevPromptId);
    audit(`${who || "?"} 音乐撤回上一条提示 ${prevPromptId} -> 成功`);
    return prevPromptId;
  } catch (e) {
    const emsg = (e && e.message) || String(e);
    audit(`${who || "?"} 音乐撤回上一条提示 ${prevPromptId} -> 失败：${emsg.slice(0, 120)}`);
    return null;
  }
}

// ── 音乐接口（Meting 后端免 key + 清和 wyy2）──────────────
const METING_API = "https://api.qijieya.cn/meting/";

async function fetchJsonTimeout(url, timeoutMs = 20000) {
  const res = await fetch(url, {
    headers: { "User-Agent": "qq-bridge/1.0" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/**
 * Meting 网易云搜索：返回 [{ name, artist, url, pic, lrc }]。
 * url/pic/lrc 都是 Meting 自己的端点（带歌曲 id）：url 会 302 到 music.126.net 的
 * 签名 mp3（会过期），不解析直链；对外最终链接走播放页（见 musicPlayUrl）。
 *
 * 上游搜索端点间歇性回空数组/报错（秒到分钟尺度横跳，2026-10-20 实锤），
 * 故带自动重试：空结果与请求异常都算一轮失败，最多 3 次尝试（间隔递增），
 * 任一次拿到非空结果立即返回；全空返回 []（走「没搜到」），末次异常则抛出（走「开小差」）。
 * 上游还会「卡住不回话」：单次 fetch 若等满默认 20 秒超时，3 次重试能拖到几十秒
 * （2026-10-20 用户实测 30–40 秒），故单次尝试独立超时 5 秒掐断、间隔收紧，
 * 并加总预算守卫：从首次尝试起累计超过约 18 秒就不再发起新尝试，按已有结果收尾。
 * 最坏耗时账（全挂死）：5 + 1.5 + 5 + 3 + 5 = 19.5 秒（第 3 次在累计 14.5 秒时发起，未超预算）。
 * 重试轨迹写审计，方便日后看上游健康度。
 */
const MUSIC_SEARCH_MAX_ATTEMPTS = 3;
let _musicSearchRetryDelays = [1500, 3000]; // 第 1、2 次失败后的等待（ms）
let _musicSearchAttemptTimeoutMs = 5000; // 单次尝试的 fetch 超时：卡住不回话时 5 秒掐断，不等默认 20 秒
let _musicSearchBudgetMs = 18000; // 总预算：累计超过就不再发起新尝试

function sleepMs(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export async function searchNetease(keyword) {
  const url = `${METING_API}?server=netease&type=search&id=${encodeURIComponent(keyword)}`;
  const startedAt = Date.now();
  let lastErr = null;
  let attemptsMade = 0;
  for (let attempt = 1; attempt <= MUSIC_SEARCH_MAX_ATTEMPTS; attempt++) {
    if (attempt > 1 && Date.now() - startedAt > _musicSearchBudgetMs) break; // 预算守卫：不再发起新尝试
    attemptsMade = attempt;
    try {
      const j = await fetchJsonTimeout(url, _musicSearchAttemptTimeoutMs);
      const list = Array.isArray(j) ? j : [];
      if (list.length) {
        if (attempt > 1) audit(`music search attempt=${attempt}/${MUSIC_SEARCH_MAX_ATTEMPTS} kw=${keyword} -> 成功 n=${list.length} retried=true`);
        return list;
      }
      lastErr = null;
      audit(`music search attempt=${attempt}/${MUSIC_SEARCH_MAX_ATTEMPTS} kw=${keyword} -> 空结果`);
    } catch (e) {
      lastErr = e;
      audit(`music search attempt=${attempt}/${MUSIC_SEARCH_MAX_ATTEMPTS} kw=${keyword} -> 异常：${String(e?.message || e).slice(0, 80)}`);
    }
    if (attempt < MUSIC_SEARCH_MAX_ATTEMPTS) {
      const delay = _musicSearchRetryDelays[attempt - 1] ?? 0;
      if (Date.now() - startedAt + delay > _musicSearchBudgetMs) break; // 等完这一觉必然超预算，不等了
      await sleepMs(delay);
    }
  }
  audit(`music search kw=${keyword} -> ${attemptsMade} 次尝试全失败 outcome=${lastErr ? "error" : "empty"} elapsed=${Date.now() - startedAt}ms`);
  if (lastErr) throw lastErr;
  return [];
}

// 仅供测试：临时改重试间隔（传 [] 之外的数组），返回旧值以便恢复，避免自测真等十几秒
export function __test_setMusicSearchRetryDelays(delays) {
  const prev = _musicSearchRetryDelays;
  if (Array.isArray(delays)) _musicSearchRetryDelays = delays;
  return prev;
}

// 仅供测试：临时改单次超时与总预算（毫秒级），返回旧值以便恢复，验挂死/预算逻辑不真等
export function __test_setMusicSearchLimits(limits) {
  const prev = { attemptTimeoutMs: _musicSearchAttemptTimeoutMs, budgetMs: _musicSearchBudgetMs };
  if (Number.isFinite(limits?.attemptTimeoutMs)) _musicSearchAttemptTimeoutMs = limits.attemptTimeoutMs;
  if (Number.isFinite(limits?.budgetMs)) _musicSearchBudgetMs = limits.budgetMs;
  return prev;
}

/** 清和 wyy2 按 ID 取网易云单曲元信息：返回同结构数组（通常 1 条） */
export async function neteaseById(id) {
  const j = await fetchJsonTimeout(`https://api.qhsou.com/api/wyy2.php?id=${encodeURIComponent(id)}`);
  return Array.isArray(j) ? j : [];
}

/**
 * 从入参里提网易云歌曲 id：歌曲链接（?id= 或 /song/123，含嵌在分享文案里的）、
 * 纯数字 id（≥5 位，老歌 id 如 186016 是 6 位）；提不到返回 null（走歌名搜索）。
 */
export function extractNeteaseId(args) {
  const s = String(args || "");
  const link = s.match(/music\.163\.com\/[^\s)"'」】]*/i)?.[0] || "";
  const target = link || s;
  const m = target.match(/[?&]id=(\d+)/) || target.match(/\/song\/(\d+)/);
  if (m) return m[1];
  const bare = s.trim();
  return /^\d{5,}$/.test(bare) ? bare : null;
}

/** 方案 B 播放页（GitHub Pages 静态页）：页面读 ?id= 后由浏览器直连 Meting 拉流，
 * 机器人只发链接、零媒体转发（多群规模）；Meting url 在 QQ 里点开被拦，故不再直发。 */
export const PLAYER_PAGE = "https://你的域名/"; // ← 部署时改成你自己的播放页地址，如 https://play.<你的域名>/（部署向导见 SKILL.md）
// 播放页缓存版本：页面每次大改版必须 +1，否则 QQ 内置浏览器会端旧缓存（GitHub Pages 的 HTML 带 Cache-Control: max-age=600，旧页能被缓存 10 分钟）
export const PLAYER_PAGE_VERSION = 4;

/** 最终播放链接：从 Meting url 提歌曲 id 拼播放页链接（带 &v= 版本参数破缓存）；提不到 id 时回退 Meting url 原样（别人的地址，不加 v） */
export function musicPlayUrl(song) {
  const url = String(song?.url || "");
  const id = url.match(/[?&]id=(\d+)/)?.[1];
  return id ? `${PLAYER_PAGE}?id=${id}&v=${PLAYER_PAGE_VERSION}` : url;
}

/** /网易云 最终一步：Markdown 播放链接（播放页）+ 纯文本兜底（裸链接） */
export function musicFinalResult(song) {
  const name = cleanHtml(song?.name || "?");
  const artist = cleanHtml(song?.artist || "");
  const url = musicPlayUrl(song);
  const titleLine = `🎵 《${name}》${artist ? ` - ${artist}` : ""}`;
  return {
    markdown: `${titleLine}\n[▶ 点我播放](${url})`,
    text: `${titleLine}\n${url}`,
    final: true,
  };
}

/** 选歌接应：序号类消息 → 按音乐会话处理。返回 null 表示无会话/不接管 */
export async function handleMusicPick(msg, input) {
  const key = musicSessionKey(msg);
  const s = _musicSessions.get(key);
  if (!s) return null;
  if (Date.now() - s.ts > MUSIC_TTL_MS) {
    _musicSessions.delete(key);
    return { text: "⌛ 选歌超时了，重新发 /网易云 <歌名> 搜吧" };
  }
  const raw = String(input ?? "").trim();
  const digit = /^\d+$/.test(raw) ? parseInt(raw, 10) : NaN;
  if (Number.isNaN(digit)) return { text: withGroupHint(msg, `没有这个选项，回 1~${s.list.length} 的数字选歌`) };
  if (digit < 1 || digit > s.list.length) return { text: withGroupHint(msg, `没有第 ${digit} 首，回 1~${s.list.length} 的数字`) };
  const song = s.list[digit - 1];
  _musicSessions.delete(key);
  return musicFinalResult(song);
}

// 仅供测试：把音乐会话时间戳往回拨（验证过期/路由优先逻辑）
export function __test_backdateMusicSession(msg, msAgo) {
  const s = _musicSessions.get(musicSessionKey(msg));
  if (s) s.ts -= msAgo;
}
