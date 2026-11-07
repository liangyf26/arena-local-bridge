# PROJECT HANDOVER — 2026-11-07（API 稳定性攻坚日）

承接 `PROJECT_HANDOVER_20261103.md`。本日目标：排查桥的延迟/稳定性并修复；横向调研替代方案。
**结果：单轮延迟从平均 ~780s 降到 25-40s；两个账号 cookie 全自动续期；5 个根因全部修复。**

## 1. 实测前后对比（槽位 01a1b0ee，freefly）

| 指标 | 修复前（11-06 日志） | 修复后（11-07 实测） |
|---|---|---|
| 平均单轮 | ~782s（13 分钟） | **25-40s** |
| 读阶段 | tap 模式必烧满 600s 预算（10/11 轮） | 回复完 + 8s 静默即返回（`tap:live-settled`） |
| append ack | tapped ack 0 次命中；waitForResponse 最慢 155s | **stream ack ~1.5s** |
| 每次 append 前 | 3 次无谓页面重载（hydration 检查恒 false） | 0 次重载 |
| recaptcha 拒绝轮 | 空烧 600s 后报错 | ~10s 快速失败 + 自动重发一次 |
| 账号过期 | 卡到 20 分钟定时 tick（且 tick 从未生效） | 启动即后台刷新 + turn 时 Sign-in 墙自动重登重试 |

## 2. 五个根因与修复（全部已提交至工作区，未 commit）

1. **tap 读必须见到 marker 才提前 break**（延迟主凶）→ `readLatestTurn` 活窗口：
   `appendAgentMessage` 发送前快照 `__arenaBridgeOutSeq` 存入 `state.appendSeq`；读时只消费
   id > appendSeq 的 chunk（全是本轮活事件），`finish` + 文本 + 8s 静默即 break
   （breakReason: `tap:live-settled` / `tap:live-tool-pending` / `tap:error-early` / `tap:silent`）。
   工具轮由 `unsettled` 判定接续 follow-up 读（读前重新快照，防重复拼接）。
2. **hydration 检查查 `__NEXT_DATA__`（App Router 页面没有）→ 恒 false → 每 append 重载×3**。
   改为等 `/out` wire 记录（app JS 真启动的信号），最多 8s 宽限（bridge.mjs §4.39）。
3. **ack 全链路换血**：流即 ack（首个带 `"records"` 的 /out chunk 即送达证明，§4.40）；
   ack 45s 未确认但请求已离手 → 不再抛 504，直接进读流程；`ARENA_COMPOSER_WAIT_MS`
   180000→45000（.env）。
4. **账号 cookie 过期自愈完全失效**（三层叠加 bug）：
   - `credentials.list()` 投影对象不含 `loginSecret`/`cookieHeader` → 定时器 `!account.loginSecret`
     恒真 → **20 分钟刷新 tick 从未刷新过任何账号**（e29d341 等于白做）；
   - `needsRefresh` 只认解密 cookie，内部对象是密文；
   - `replaceCookie` 快照比对要求解密形状，传内部/投影对象都必失败。
   修复：新增 `credentials.accountsNeedingRefresh(margin)` 与 `accountSnapshot(email)`
   （均返回 selectNext 同款解密快照形状），index.mjs 启动后台刷新 + 定时器 + turn 时
   `bridge.refreshAccount` 三路共用。
5. **recaptcha 拒绝轮无重试**：converse 尾部对 recaptcha 类 errorText 整轮重发一次
   （delivered=false；重发前强制 reload 页面——错误轮会留下 Send 失灵的卡死状态）。

## 3. 账号现状

| 账号 | 状态 | 结论 |
|---|---|---|
| freefly@163.com | ✅ 正常，cookie 已自动续期 | 主力。01a1b0ee / 01a1b0de 槽可用 |
| huihuixiong@agent.qq.com | ❌ **账号级 recaptcha 风控** | 连全新会话创建都 403（`new-agent.mjs` 实测）。cookie 正常、非会话级。需人工在 Arena UI 登录该号过验证/养号，或弃用 |

## 4. 替代方案调研结论（三个子智能体报告要点）

- **没有任何开源项目支持 arena.ai Agent Mode 作为 API**——本桥是唯一解（甚至已被转帖到
  openai/codex discussion #48429）。
- **纯 HTTP 重放方案 2026-10 后基本已死**：OmniRoute 的 arena executor 即使持有效 cookie
  也被 Cloudflare bot management 全量 403。活着的都是真浏览器方案（扩展注入 / Camoufox /
  Playwright）——印证本桥架构选型正确。
- `Arena2api-fixed`（本机另一目录）：扩展偷 cookie → 直连 `nextjs-api/stream/create-evaluation`
  重放，**只支持 direct-battle 聊天、不支持 Agent Mode**（server.py:501 唯一 mode），假多轮
  （历史压平成单 prompt），模型表硬编码 grok-4.5；本机日志显示它**从未成功打过一次真实
  请求**（3 次 API 调用全部 503/400）。上游 flay-o/arena2api 也有未解的 CF 403 issue。
- 可借鉴：CloudWaddie/LMArenaBridge 的多通道降级思想（Agent Mode 失败时降级到聊天通路）；
  foxhui/WebAI2API（1.4k★）的多账号 Camoufox 隔离 + Docker。
- ⚠️ **风险提示**：社区确认此类用法违反 Arena ToS，Arena 正积极封号（huihuixiong 的账号级
  recaptcha 拦截与之一致）。Agent Mode 的对话数据会进入公开排行榜——不要发私有代码/敏感内容。
- 遗留情报：arena.ai `create-evaluation` 带反自动化遥测字段 `cx`（submitKind/charsTyped/
  pasteCount 等）；本桥 execCommand 注入 + 真实点击目前在安全侧，若未来出现静默 403
  先查这里。reCAPTCHA Enterprise v3，sitekey `6Led_uYrAAAAAKjxDIF58fgFtX3t8loNAK85bW9I`，
  action `chat_submit`。

## 5. 下一步选项

1. **直接用**：ZCode/dsh 指向 `http://127.0.0.1:20140/v1`，model 填槽位 UUID（01a1b0ee 实测
   流式/非流式均 25-40s）。
2. huihuixiong 人工过验证后回收 v4 槽（或 `new-agent.mjs` 重建）。
3. （可选）ack 传输普查：`page.context().on('request')`（SW 层请求只在 context 级可见）
   + WebSocket/Worker 构造器包裹，一次运行定位 append 真实传输，把 20s stream-ack 上限
   压到亚秒。
4. （可选）把本日修复 commit（改动清单见 git status / §2）。
