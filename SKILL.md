---
name: qq-netease-music
description: 为官方 QQ 机器人接入「/网易云」点歌功能：调用 Meting 接口（api.qijieya.cn）按歌名搜歌，用户回序号选歌，机器人发出指向自有域名 GitHub Pages 全屏播放页的链接（页面由用户浏览器直连拉流，机器人零媒体转发），选歌成功后自动撤回搜歌列表；链接/ID 入参可直达。含从 dnsneko 领免费域名、建 player 仓、推播放页、绑自定义域名到改机器人常量的完整分步部署向导。当需要给 QQ 机器人添加网易云点歌/音乐播放链接功能，或复用本模块的选歌会话、搜歌自动重试、答后撤回编排与播放页部署流程时使用。
---

# QQ 机器人 /网易云 点歌（qq-netease-music）

## 快速接入（第一次见到这个包的 agent 先读这里）

**① 这是什么、什么时候用**
给官方 QQ 机器人（WebSocket 网关）加一个 `/网易云 <歌名>` 命令：搜歌 → 编号选歌 → 发出一条可点击的播放链接，并自动撤回搜歌列表，让聊天框里最后只留结果。播放链接指向一个**你自己域名下的静态播放页**（包内 `player/index.html`，部署在 GitHub Pages 上）：用户点开后，页面在他自己的浏览器里直连音乐源拉流播放——机器人从头到尾只发文字和链接，一滴音频流量都不经手。机器人侧实现全在 `music.mjs` 单文件里（零第三方依赖），宿主只需提供「发消息」和「撤回消息」两个平台能力。**播放页还没部署时，先去做下面的「(B) 播放页部署向导」，再回来接机器人。**

**② 宿主必须提供的 sender 接口（签名清单，按音乐侧实际接线）**

| 方法 | 入参 | 返回值 | 音乐侧用途 |
| --- | --- | --- | --- |
| `sendText` | `(target, text)` | `Promise<{ id }>` | 发搜歌列表、选错提示、报错；**`id` 是撤回编排的命脉**，列表那条的 id 要交给 `noteMusicPromptId` 登记 |
| `sendMarkdown` | `(target, content)` | `Promise<{ id }>` | 发最终消息（Markdown 锚文本链接）；失败时宿主降级 `sendText` 发纯文本兜底 |
| `recallMessage` | `(target, messageId)` | `Promise<void>` | 撤回机器人自己发的消息；宿主在 `settleMusicStep` 的 recall 回调里接它 |
| `send` | `({ target, msgType: 3, ark })` | `Promise<{ id }>` | 音乐侧**不用**（无 Ark 卡片路径）；若宿主同时装了电影包，那边私聊路径才用 |
| `sendImage` | `(target, { buffer }, { content }?)` | `Promise<{ message: { id } }>` | 音乐侧**不用**（不下载、不发送任何图片/音频文件） |

形状约定：`msg = { kind: "group" | "c2c", groupOpenid, senderId, senderName, replyTarget }`；`target = { scope: "group" | "c2c", targetId }`。
审计日志经 `setMusicLogger(fn)` 注入，`fn(line)` 收到的行文本与生产审计同格式（不含时间戳，宿主自行添加）；不注入则静默。
最终消息的发送契约（宿主实现，示例见 `example-host.mjs` 的 `sendMarkdownFirst`）：结果带 `markdown` 字段时**先 `sendMarkdown`，抛错则降级 `sendText(result.text)`**，并回传实际发送的 message id。

**③ 最小接入步骤**

1. 先自检：`node smoke-test.mjs` 全绿（32 项离线断言），再 `node example-host.mjs` 看一遍假 sender 的完整干跑输出。
2. 确认播放页已部署（见「(B) 播放页部署向导」），并把 `music.mjs` 里的 `PLAYER_PAGE` 改成你的播放页地址。
3. 从 `music.mjs` import：`parseCommand, findCommand, handleMusicPick, hasMusicSession, noteMusicPromptId, peekMusicPromptId, settleMusicStep, setMusicLogger`；启动时 `setMusicLogger(你的审计函数)`。
4. 消息路由按此顺序挂（完整可运行版见 `example-host.mjs`）：
   - 入口先 `parseCommand(rawText)`（内部已做占位符剥离、空白折叠、无空格命令拆分），用返回的 `clean` 做后续判定；
   - **选歌拦截**：`hasMusicSession(msg)` 且 `clean` 为纯数字时 → `prevPromptId = peekMusicPromptId(msg)`（必须在下一步之前取）→ `pick = await handleMusicPick(msg, clean)` → 带 `markdown` 的结果走最终消息契约发送 → `await settleMusicStep(msg, { prevPromptId, sentId, advanced: !!pick.advanced, final: !!pick.final, who }, (id) => sender.recallMessage(msg.replyTarget, id))`；只有 `text` 的结果（选错/超时）直接 `sendText`，不调 settle；
   - **命令**：`findCommand(parsed.head)` 命中 → `result = await cmd.run({ msg, args: parsed.args })` → 按 `result.error / result.markdown / result.text` 依次处理：`error` 回 `❌ <error>`；`markdown` 走最终消息契约（这是链接/ID 直达流，**不登记待撤回**）；`text`（搜歌列表）用 `sendText` 发送，成功后用返回的 id 调 `noteMusicPromptId(msg, id)` 登记待撤回提示。
5. 限流、黑名单、关键词、聊天兜底等都是宿主策略，本模块不管。

**④ 常见坑（一句话索引）**

- Meting 的播放直链在 QQ 里点开被拦 → 不要直发接口链接，必须走自有域名播放页，见「平台实测结论」第 1 条。
- 播放页绑了 github.io 还是时好时坏 → github.io 是共享域名、QQ 时放时拦，见部署向导前置说明与「平台实测结论」第 2 条。
- 在 QQ 里点链接还是旧版页面 → GitHub Pages 的 HTML 有 10 分钟缓存，靠链接上的 `&v=` 版本参数治，见「常量」一节。
- 搜歌偶发「没搜到」但歌明明存在 → 上游搜索端点间歇回空，模块已内置重试，见「搜歌自动重试」。
- 撤回只能撤自己发的、且只有 2 分钟窗口 → 编排细节见「答后撤回编排」。
- GitHub 绑域名时证书迟迟不签 → 清空自定义域名再重填，逼它重跑校验，见部署向导第 5 步。

## 功能流程

1. 用户发 `/网易云 <歌名>` → 回编号选歌列表（最多 10 条，每行 `序号. 歌名 - 歌手`）；搜不到回「没搜到《歌名》，换个名字或直接发网易云链接试试」。
2. 回序号选歌 → 发最终消息：`🎵 《歌名》 - 歌手` + Markdown 锚文本 `[▶ 点我播放](播放页链接)`；同时撤回第 1 步的搜歌列表。会话清除。
3. 直达流：入参是网易云歌曲链接（`music.163.com/song?id=…`、`/song/<id>`，含嵌在分享文案里的）或纯数字歌曲 ID（≥5 位）→ 跳过搜索，走清和 wyy2 按 ID 取元信息，直接出最终消息；不建会话、不涉及撤回。

会话规则：按（场景 kind + 群 openid + 发送者 senderId）隔离，进程内存保存，5 分钟过期（过期回复超时提示）；每步只认纯数字，选错回报错文案并**保留会话**；群聊每条提示（含报错）末尾自动追加「（下一步请 @我 再回序号，不 @ 我收不到）」，私聊不加——官方群聊只把 @ 机器人的消息推给机器人，不提醒用户就会以为机器人卡死。

---

## (A) 机器人侧接线

### 命令与返回契约

命令注册在 `music.mjs` 的 `COMMANDS` 中（触发词 `/网易云`，带不带斜杠互认；`/网易云晴天` 这类无空格写法由 `parseCommand` 的前缀拆分兜底，余下不足 2 字不拆）。`run({ msg, args })` 的返回契约：

| 返回 | 含义 | 宿主动作 |
| --- | --- | --- |
| `{ error }` | 用法错误/上游异常 | 回 `❌ <error>` |
| `{ text }` | 搜歌列表或「没搜到」文案 | `sendText` 发送；是列表时把返回 id 交 `noteMusicPromptId` 登记 |
| `{ markdown, text, final: true }` | 最终消息（选歌成功或直达） | 先 Markdown 后纯文本降级发送；**不登记待撤回** |

### 选歌会话

会话对象 `{ list, ts, promptId? }` 存进程内 `Map`，key 为 `kind:groupOpenid:senderId`。列表最多缓存前 10 首（接口返回更多时文案注明「只列前 10 首」）。与电影包并存时（同一宿主装了两个包）：序号消息的归属按**两个会话的时间戳、新者优先**裁决；电影的「线路-集数」「线路 集数」复合输入只归电影，音乐只认纯数字——生产宿主的 `resolvePickRoute` 即按此规则实现，并存部署时照此写路由即可。

### 答后撤回编排

- **官方有撤回接口**：群聊 `delete_group_message`、单聊 `delete_private_message`，只能撤回**机器人自己发的**消息，且须在**发送后 2 分钟内**。SDK 侧对应 `recallMessage(target, messageId)`。
- 编排（`noteMusicPromptId / peekMusicPromptId / settleMusicStep`）：搜歌列表发出后把 message id 登记进会话；用户选歌成功、最终消息确认发出后，**先发新消息、再撤回列表**，聊天里只留最终消息；最终消息永不登记、永不撤回。
- 顺序要点：`peekMusicPromptId` 必须在 `handleMusicPick` **之前**调用（选歌成功会清会话，之后取不到）。
- **选错不撤**：报错结果 `advanced/final` 皆假，`settleMusicStep` 不执行撤回，会话与待撤回 id 都原样保留；直达流没有列表，不登记、不撤；「没搜到」不建会话，不进撤回链。
- 撤回失败（超 2 分钟窗口、平台拒绝等）只记审计、返回 `null`，绝不阻塞流程。

### 搜歌自动重试

`searchNetease(keyword)` 对 Meting 搜索端点带自动重试（上游间歇回空，见下节实锤）：空结果与请求异常都算一轮失败，**最多 3 次尝试**，单次 fetch 超时 **5 秒**掐断，失败间隔 **1.5s / 3s** 递增，从首次尝试起累计约 **18 秒**总预算封顶（超预算不再发起新尝试）。任一次拿到非空结果立即返回；全空返回 `[]`（命令层走「没搜到」）；末次是异常则抛出（命令层走「开小差」）。全挂死时最坏耗时约 19.5 秒。每次尝试与最终结局都写审计（`music search attempt=… / outcome=…`），便于日后看上游健康度。测试钩子 `__test_setMusicSearchRetryDelays / __test_setMusicSearchLimits` 可临时改参数，自检用，生产勿动。

### 常量（部署时要改的只有第一个）

| 常量 | 值 | 说明 |
| --- | --- | --- |
| `PLAYER_PAGE` | `"https://你的域名/"`（占位） | 播放页地址，**部署时改成你自己的**，如 `https://play.<你的域名>/`；改法在部署向导第 6 步 |
| `PLAYER_PAGE_VERSION` | `4` | 播放页缓存版本。GitHub Pages 的 HTML 带 `Cache-Control: max-age=600`，QQ 内置浏览器会端着旧缓存不刷新（实测撞过：页面明明更新了，用户看到的还是旧版）。机器人发出的链接带 `&v=<版本号>` 破缓存——**播放页每次大改版，这个数字必须 +1**，改页面忘改它，用户就会继续看旧版 |
| `MUSIC_TTL_MS` | `5 * 60 * 1000` | 选歌会话有效期 |
| `METING_API` | `https://api.qijieya.cn/meting/` | Meting 后端基址（免 key），一般不用改 |

`musicPlayUrl(song)`：从歌曲的 Meting `url` 字段里提出歌曲 id，拼成 `${PLAYER_PAGE}?id=<id>&v=${PLAYER_PAGE_VERSION}`；提不到 id 时回退为 Meting `url` 原样（稳定入口，不加 v；不要去解析它 302 后的签名 mp3 直链——签名会过期）。

### 数据接口：Meting + 清和 wyy2

主后端是 Meting 的一个公开实例（免 key、CORS 全开），基址 `https://api.qijieya.cn/meting/`，统一参数 `?server=netease&type=<类型>&id=<参数>`：

| type | id 参数 | 返回 | 本功能用途 |
| --- | --- | --- | --- |
| `search` | 关键词 | 歌曲对象**数组** | 机器人搜歌（`searchNetease`） |
| `song` | 歌曲 id | 只含 1 条的**数组** | 播放页按 `?id=` 取单曲（页面内 fetch） |
| `url` | 歌曲 id | 302 跳转到 `music.126.net` 的签名 mp3 直链（**会过期**） | 不直接发给用户；歌曲对象里的 `url` 字段就是这个端点，只从中提 id |
| `pic` | 歌曲 id | 302 跳转到封面图 | 歌曲对象 `pic` 字段，播放页用作封面/背景 |
| `lrc` | 歌曲 id | LRC 格式歌词文本 | 歌曲对象 `lrc` 字段，播放页歌词的数据源 |

歌曲对象形状：`{ name, artist, url, pic, lrc }`，其中 `url/pic/lrc` 都是上面 Meting 自己的端点地址（内嵌歌曲 id）。

**搜索端点间歇回空（实锤）**：该实例的 `search` 会在秒到分钟尺度上间歇返回空数组或直接报错（生产日志实测：同一天 9 次搜歌 4 次扑空；活体探针连发 6 次全空、20 秒后自愈），而按 id 的路径（`song`、清和 wyy2）全程稳定。所以：①搜歌必须带重试（模块已内置，见上节）；②重试后仍空就老实回「没搜到」，不要拿空结果当真没这首歌去误导用户；③链接/ID 直达流不经过搜索，不受此问题影响。

清和 wyy2（直达流取元信息用）：`GET https://api.qhsou.com/api/wyy2.php?id=<歌曲id>`，免 key，返回与 Meting 同结构的歌曲数组（通常 1 条）。`neteaseById(id)` 即按此请求，20 秒超时。

`extractNeteaseId(args)` 的识别规则：先在入参里找 `music.163.com/...` 链接段（分享文案里嵌的也算），从中取 `?id=<数字>` 或 `/song/<数字>`；没有链接时，入参整体是 ≥5 位纯数字才当歌曲 ID（4 位及以下不算，防把歌名里的数字误判）；都提不到返回 `null`，走歌名搜索。

### 平台实测结论（2026-10-20，官方 QQ 机器人）

1. **接口裸链在 QQ 里会被拦**：Meting 的 `url` 端点地址直接发到群里，用户点开提示「去浏览器打开」类拦截，无法在 QQ 内播放。所以最终消息只能发**自有域名播放页**的链接，由页面在浏览器里再去调接口。
2. **github.io 共享域名时放时拦**：播放页最初挂在 `<用户名>.github.io` 下，一度能播、随后又被拦——共享域名的信誉由平台动态判定，不受你控制。绑上**自己的域名**后放行稳定。结论：github.io 地址只用于部署中途验证，正式链接必须用自有域名。
3. **官方机器人没有音乐卡片消息类型**：网易云 App 里那种聊天内可播放的音乐卡，是 App 分享/第三方协议账号的能力，官方机器人发不出来。本方案的「链接 → 全屏播放页」是官方路线下最接近的形态。
4. **群聊只推送 @ 消息**：用户不 @ 机器人，他回的序号机器人根本收不到——每步提示末尾的 @ 提醒是必需品，不是啰嗦。
5. **撤回有接口**：见「答后撤回编排」；踢人/禁言则无官方接口，别去设计依赖它们的功能。

### 多群零媒体转发原则（架构红线）

机器人定位是**多群共用**，所有方案必须按多群规模设计：机器人服务器端**零媒体下载、零媒体转发**——不下载 mp3、不转存封面、不把音频做成文件/视频再发。音频流量的路径永远是「用户浏览器 ↔ 音乐源 CDN」直连，机器人和 GitHub Pages 都不经手（Pages 只发那个几十 KB 的网页文件）。任何「机器人把歌拉下来再发进群」的改法都会在多群并发时先压垮带宽、再招平台文件管控，**不要这样改**。交付形态永远优先链接。

---

## (B) 播放页部署向导（从零到能在 QQ 里点开播放）

**给执行本向导的 agent**：照编号一步步走，每步都标了由谁动手——``的步骤你不能代办（账号与域名归属是用户本人的），你的活是把每一步的**确切填法**发给用户、等他做完、再用你的工具验证该步的验收判据，通过了才进下一步；``的步骤你自己做完并验证，不要把命令原样甩给用户。全程用到的只有三样东西：一个免费域名、一个 GitHub 仓库、本包的 `player/index.html`。预计耗时 20–60 分钟，其中大头是等 GitHub 签证书（第 5 步），属正常等待，不要反复乱动。

**为什么非要自备域名**：播放页挂在 github.io 共享域名下会被 QQ 时放时拦（见「平台实测结论」第 2 条）；绑上自己的域名才稳定放行。域名不用买——下面第 1 步领的是免费域名，效果一样。

### 第 1 步：领一个免费域名

让用户照做，把结果发回来：

1. 打开 **https://www.dnsneko.com/login** ，注册并登录（这是 DNSNEKO 的免费域名服务）；
2. 在站内领取一个免费域名（`zh.kg` 的子域名，形如 `你的名字.zh.kg`），按站内指引完成领取；
3. 把领到的**完整域名**（例如 `mahiru.zh.kg`，这是格式示例、不是让你填这个）原样发给 agent。

> 为什么必须用户亲手做：域名注册账号是用户本人的，域名归属、续期与回收都认这个账号，agent 无法也不应代注册。

**✔ 验收**：agent 手里拿到了一个完整域名字符串（下文记作 `<你的域名>`）。没有这一步的产物，后面全部无从谈起。

### 第 2 步：在 GitHub 建 player 仓

建一个**公开、空的**仓库，仓名建议就叫 `player`（下文以此为例）。

- 有 GitHub 管理通道的 agent（能调 GitHub REST API）：`POST /user/repos`，请求体 `{"name": "player", "private": false}`，建完回读 `GET /repos/<用户名>/player` 确认存在。
- 没有管理通道时，把下面这段原样发给用户，让他点完回你话：
1. 打开 github.com 并登录，点右上角 **「+」→「New repository」**；
2. **Repository name** 填 `player`；可见性选 **Public**；
3. 下面的 README /.gitignore / license **全都不要勾**（要空仓，带了初始文件后面推送容易冲突）；
4. 点 **「Create repository」**，把建好后的仓库地址发回来。

**✔ 验收**：`https://github.com/<用户名>/player` 能打开，且仓库里没有任何文件（或只有默认空页提示）。

### 第 3 步：推入播放页并开启 Pages

把本包的 `player/index.html` 原样放进上一步的仓库根目录（文件名就叫 `index.html`，一个字都别改——页面逻辑、接口地址都写死在里面，开箱即用），然后开启 GitHub Pages：来源选 **分支 `main`、根目录 `/`**。

- 有 GitHub 管理通道的 agent：用 Contents API `PUT /repos/<用户名>/player/contents/index.html` 推入文件内容（base64），再 `POST /repos/<用户名>/player/pages`，请求体 `{"source": {"branch": "main", "path": "/"}}` 开 Pages，回读 `GET /repos/<用户名>/player/pages` 确认。
- 没有管理通道时，让用户照做：
1. 在仓库页面点 **「Add file」→「Upload files」**，把 agent 发给他的 `index.html` 传上去，页面下方点 **「Commit changes」**；
2. 点仓库的 **「Settings」→ 左侧「Pages」**；在 **Build and deployment** 处，Source 选 **「Deploy from a branch」**，分支选 **`main`**、目录选 **`/(root)`**，点 **「Save」**。

**✔ 验收**：等 1–3 分钟后，打开 **`https://<用户名>.github.io/player/?id=2652647226`** ——能出播放器界面、显示歌名歌手并能播放，就算通了（不带 `?id=` 打开会提示「没有指定歌曲」，那是正常文案、不是故障）。此时的地址是 github.io 共享域名，**只用于验证页面本身没问题**，不要拿它去改机器人常量——继续走完下面绑域名的步骤。

### 第 4 步：在 dnsneko 给子域名加解析记录

目的：让 `play.<你的域名>` 这个地址指向 GitHub。让用户登录 dnsneko 后台，找到**域名解析 / DNS 记录管理**（他第 1 步领的那个域名下面），**新增一条记录**，照下面这张表一格一格填——除了「记录值」一格里的用户名要换成他自己的 GitHub 用户名，其余照抄：

| 字段 | 填什么（确切值） |
| --- | --- |
| 记录类型 | `CNAME` |
| 主机记录 | `play` |
| 记录值 | `<GitHub用户名>.github.io` ← 只填域名本身：**不要**带 `https://`、**不要**带 `/player` 路径、末尾不要加斜杠 |
| TTL | 默认（有输入框就填 `600`，没有就不管） |

填完点保存，然后告诉 agent「加好了」。**agent 接着验证**：查公开 DNS —— 请求 `https://dns.google/resolve?name=play.<你的域名>&type=CNAME`，返回的 `Answer` 里应有一条指向 `<GitHub用户名>.github.io` 的记录。⚠️ 不要用你本机的 `nslookup` / 系统解析器验证：某些网络环境下本机解析会被污染、返回假地址，以公共 DoH（dns.google）的结果为准。刚加的记录生效可能要几分钟，查不到就等 3–5 分钟再查，别急着让用户改。

**✔ 验收**：DoH 查询能查到 `play.<你的域名>` 的 CNAME 记录、值等于 `<GitHub用户名>.github.io`。

### 第 5 步：GitHub 侧绑定自定义域名并等证书

把第 4 步的子域名填进 Pages 设置：

- 有管理通道的 agent：`PUT /repos/<用户名>/player/pages`，请求体 `{"cname": "play.<你的域名>"}`（注意：成功时该接口可能返回空响应体导致工具报解析错，**先回读 `GET.../pages` 确认 cname 已写入**，不要当失败重发）；之后轮询 Pages 状态，等域名校验通过、证书签发（状态里 `https_certificate.state` 变为 `approved`）。
- 没有管理通道时，让用户照做：仓库 **「Settings」→「Pages」→「Custom domain」** 输入框填 `play.<你的域名>`，点 **「Save」**，然后停手等着，隔几分钟刷新看提示。

**等多久正常**：校验+签证书通常几分钟，长则几十分钟，页面会显示证书处理中，这段时间**什么都别改**。

**卡住超过 30 分钟的实测解法**（校验管线有时会假死）：把 Custom domain **清空并保存**（管理通道发 `{"cname": ""}`），等约 1 分钟，再把 `play.<你的域名>` **重新填入并保存**，逼 GitHub 把整条校验流程重跑一遍——生产实测这样处理后约 2 分钟证书就签下来了。

**最后一步别抢跑**：证书签好（状态 `approved`）之后，再打开 **「Enforce HTTPS / 强制 HTTPS」**（管理通道补发一次 `PUT.../pages` 带 `{"cname": "play.<你的域名>", "https_enforced": true}`；手动就在 Pages 设置里勾 Enforce HTTPS）。证书没好就先设强制 HTTPS 会直接报错，必须等证书。

**✔ 验收**：打开 **`https://play.<你的域名>/?id=2652647226`** ——能出播放器、能播放，且浏览器地址栏没有证书警告。

### 第 6 步：把机器人常量改成新地址并自测

1. 把 `music.mjs` 的常量改掉：`export const PLAYER_PAGE = "https://play.<你的域名>/";`（注意末尾斜杠保留；`PLAYER_PAGE_VERSION` 这次不用动，它是给以后页面改版时 +1 用的）；
2. 重启机器人服务；
3. 在测试群/私聊里自测一遍完整链路：发 `/网易云 晴天` → 收到编号列表 → 回 `1` → 收到最终消息。

**✔ 验收**：最终消息里的链接形如 **`https://play.<你的域名>/?id=<一串数字>&v=4`**（域名是新绑的、带 `&v=` 参数），且搜歌列表在选歌成功后被撤回。形态不对就回头查常量改没改、服务重启没重启，不要往下走。

### 第 7 步：在 QQ 里实测验收

让用户在 QQ 里点第 6 步那条最终链接，逐项确认：

- 链接能在 QQ 内直接打开（不再跳「去浏览器打开」类拦截页）；
- 播放器能出声、封面与歌名正确；
- 点封面能进歌词页、歌词随播放滚动高亮（无歌词的歌该入口置灰，属正常）。

**✔ 验收**：三项都过，部署完成。若 QQ 里打不开但手机浏览器能开，先按这个顺序排查：①链接是不是第 6 步的新域名地址（不是 github.io、不是接口裸链）；②`&v=` 参数在不在（旧缓存）；③等 10 分钟再试（Pages 的 HTML 缓存窗口）。都排完还不行，回到第 5 步检查证书与强制 HTTPS 状态。

---

## 宿主集成契约

- sender 三个必需方法（`sendText / sendMarkdown / recallMessage`）的签名见「快速接入」②；返回值里的消息 id 是撤回编排的命脉：`sendText / sendMarkdown` 的 id 都在返回值 `.id`，宿主取 id 时统一按此，不要与图片通道的 `.message.id` 搞混（音乐侧不用图片通道）。
- 命令 `run({ msg, args})` 的返回契约见「(A) 命令与返回契约」；宿主负责实际发送、限流（如每人每 10 分钟 N 次）、审计埋点（选歌成功/失败、撤回成功/失败、搜歌重试轨迹已由模块经 logger 产出）。
- 会话是进程内 `Map`：机器人重启即丢（5 分钟 TTL 下可接受）；多实例部署时同一用户的步骤必须落到同一实例，否则会话对不上。
- 凭证与本模块无关：模块不需要、也不接收任何机器人凭证；播放页是纯静态文件，里面没有任何密钥。宿主自行保管凭证文件，仓库 `.gitignore` 已预置凭证类文件的忽略规则，不要把真实凭证提交进仓库。
- 播放页（`player/index.html`）与机器人解耦：页面自己按 `?id=` 向 Meting 取数（`type=song`），机器人只拼链接。页面部署在哪个仓、绑什么域名，机器人侧只认 `PLAYER_PAGE` 这一个常量。

## 合规须知

本 skill 仅供编程学习与技术交流。歌曲数据与播放地址来自第三方公开接口（Meting 公开实例 api.qijieya.cn、清和 API api.qhsou.com），接口由其运营方公开发布，本项目与网易云、各接口运营方均无任何隶属、授权或合作关系；本项目与按本向导部署的播放页均不存储、不托管、不分发任何音乐文件——播放由用户浏览器直连权利方服务器完成。全部内容版权归原权利人及合法授权方所有。使用者应遵守所在地法律法规，因使用产生的一切后果由使用者自行承担。完整声明见 [DISCLAIMER.md](./DISCLAIMER.md)。

## 文件清单

| 文件 | 内容 |
| --- | --- |
| `music.mjs` | 机器人侧实现（单文件：解析/搜歌重试/选歌会话/最终链接/撤回编排） |
| `player/index.html` | 播放页母版（iOS 风全屏播放器：虚化封面背景、可拖进度条、±15 秒、歌词页、循环；APlayer 作音频引擎，整页零构建直接部署） |
| `smoke-test.mjs` | 离线自检：`node smoke-test.mjs`，32 项断言全绿才算包可用 |
| `example-host.mjs` | 最小宿主接线示例（假 sender 干跑全流程，不打真实网络） |
| `SKILL.md` | 本文件（含播放页部署向导） |
| `README.md` | 仓库首页说明 |
| `DISCLAIMER.md` | 免责声明（中英双语，正式版） |
| `.gitignore` | 凭证、依赖、数据与日志的忽略规则 |

## 免责声明（简版）

本项目仅供编程学习与技术交流，禁止任何商业用途及二次分发牟利。歌曲数据来自第三方公开接口（api.qijieya.cn、api.qhsou.com），本项目与网易云及各接口运营方无任何隶属、授权或合作关系；本项目不存储、不托管、不分发任何音乐文件，播放由用户浏览器直连权利方服务器完成，全部内容版权归原权利人及合法授权方所有。使用者须自行遵守所在地法律法规，因使用本项目产生的一切后果由使用者自行承担，作者不承担任何责任。若权利方认为内容侵权，请通过仓库 Issue 联系，核实后立即删除。完整版见 [DISCLAIMER.md](./DISCLAIMER.md)。
