# PROJECT HANDOVER — 2026-11-03

Arena 本地桥 + 匿名模型识别（Goal 1 ✅ / Goal 2 运转中）。本文档是全量交接：
架构、当前状态、已知问题、操作手册、下一步选项。

---

## 1. 系统架构（当前生产形态）

```
ZCode / dsh  ──POST /v1/chat/completions──▶  本地桥 (127.0.0.1:20140)
                                              │  真实 Chrome (headed, via xvfb-equivalent flags)
                                              │  Arena 会话槽位（模型由 Arena 匿名分配）
                                              ▼
                                        arena.ai Agent Mode
                                              │
  遥测被动捕获 ◀── 每轮 durationSec/outputTokens/bash/toolHallu
  遥测先验判别 ◀── 榜单 Code 类 57 类基线（telemetry-baseline.json, 2026-11-01）
  numeric 指纹 ◀── 探针 240 整数 ↔ 参考库 fingerprint-bank.json（13 模型/32 条/2 环境）
        ↓
  ensemble 融合 + 协议门 → slot --code 出身份 + Code 排名 → 留/重抽
```

- 仓库：`D:\Project\802-arena_local_bridge`（main，最新 `bbad6de`，全部已推送）
- 数据：`C:\Users\liang\.arena-bridge\`（.env / credentials / archive/记录.json /
  telemetry-baseline.json / telemetry-tasks.jsonl / fingerprint-bank.json /
  identification-votes.jsonl / bridge.log）

## 2. 关键概念：model = 槽位（Arena 会话 UUID），不是模型名

Arena 匿名分配模型，识别系统负责告诉我们"槽里现在是谁"。

| 槽位 UUID | 状态 | 判别 | 建议 |
|---|---|---|---|
| `01a19b1e-3c86-7d31-9bbe-9fa0819325f4` | 编码 v2 | GLM-5.3-Flash #36（numeric）/ Luna Low #44（telemetry，微任务污染存疑） | **现役主力**（ZCode 已接） |
| `01a19e8b-98f0-746e-84e2-cd37f1b8bcd5` | **编码 v4** | **Kimi K3.1 Pro #13（两探针稳定）** / telemetry 分歧 | **建议切为主力试用**（最强抽签） |
| `01a19d27-7f85-79ef-84bf-2b1a6cd6475c` | 编码 v3 | 不可判定（near-miss 漂移=模型不在 bank） | 闲置或作通用 |
| `01a19955-a2fd-75c5-9669-20f2714c0548` | 通用 | — | 通用任务 |
| `01a19950-0cc9-7700-abe0-dbcd1fbeb8cf` | 编码 v1 | Luna Low #44 实锤 | 弃用 |

三槽均已注入 ask_user 预防约定（见技能第 0 节）。

## 3. 操作手册（脚本三件套 + 判别）

```bash
# 日常
start-bridge.bat        # 开机后跑：查代理→分离启动→等 ready（v2rayN 必须先开）
bridge-status.bat       # 代理出口/服务健康/槽位列表/遥测量 一眼看全
stop-bridge.bat         # 停止

# 槽位身份（Goal 2 核心）
node bin/ensemble-cli.mjs slot <槽位UUID> --code

# 重抽（判出弱模型时）
printf '你是我的常驻编码助手。收到本条后仅回复：ok，然后等待我的具体编码任务。' > /tmp/seed.txt
node bin/new-agent.mjs /tmp/seed.txt --label slot-coding-vN
#   → appendEntry 登记 → 注入 ask_user 预防约定 → 探针 → 判别
#   完整流程见技能：~/.zcode/skills/arena-slot-lifecycle/SKILL.md（六节+坑表）

# 探针（numeric 指纹，1 轮 ~3-10 分钟，走服务 API）
KEY=$(grep '^ARENA_AGENT_BRIDGE_KEY=' ~/.arena-bridge/.env | cut -d= -f2-)
curl -s --max-time 700 -X POST http://127.0.0.1:20140/api/pool/fingerprint-reprobe \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"sessionId":"<UUID>","variant":"v1-instant"}'
```

## 4. ⚠️ 当前已知问题（未解决）

### 4.1 append ack 盲区（唯一未攻克项，实用主义容忍中）
- **症状**：每轮 append 后 ack 等待固定超时 180s（composerWaitMs），然后才进读阶段。
  客户端需超时 ≥15 分钟掩盖。消息**实际都送达**（回复都能读到，诊断 bodyTail 可见）。
- **已试并失败**：fetch hook 打点（append 不走 fetch）、XHR hook 打点（不走 XHR）、
  raf 轮询修复（`polling: 500`，7cc7351）、CDP spy（append 请求在
  Playwright/CDP request 事件里都不可见——比 /out 的 SW 混淆更深一层）。
- **下一嫌疑**：`navigator.sendBeacon` 或 web worker 内 fetch（init script 不覆盖
  worker 作用域）。修法：hook 里包 `Worker` 构造器给 worker 注入同款 wrapper，
  或放弃 ack 快路径（把 composerWaitMs 降到 30s 让超时快速滑过，读流程本来就能
  自行等待 marker）。
- **近期修复史**（同链条）：cbc74f9 land-before-token（修 401）、7cc7351 ack 双通道
  + interval 轮询、bbad6de send-leave 验证（点击发送可能 React 状态滞后静默失败，
  已加 5s 离手验证 + Enter 回退）。

### 4.2 代理瞬断 → 账号误禁
v2rayN 瞬断一次导航失败就把账号自动 disable（409 session_account_unavailable）。
恢复：`node bin/accounts.mjs enable huihuixiong@agent.qq.com` + 重启桥。
治本 patch（代理类错误不禁用）未做。

### 4.3 两个环境注意事项
- 长轮次可达 618s（慢推理模型）——客户端超时 ≥15 分钟
- 连续长轮次会挤崩渲染页——多槽操作逐个来

## 5. Bank（numeric 参考库）现状

13 模型 / 32 条 / 2 环境（volcengine + s3ai），`bankStatus.ready=true`。
采集工具：`bin/probe-api-collect.mjs`（openai/anthropic 双格式）。
- s3ai：kimi-k3.1-pro、gpt-6.1-terra、gemini-4-argon、deepseek-v4.1-flash、
  gpt-6-astra、claude-opus-5-5-high、claude-sonnet-5-5-high
- volcengine：glm-5.3-flash、glm-5.3、kimi-k3-1-pro-261024、
  deepseek-v4-1-flash-261017、deepseek-economy-261017、deepseek-v4-pro-ga-260813
- alias：`src/fingerprint/model-aliases.json`（261024/261017 快照 id→榜单类；
  渠道 effort 后缀 -high→榜单类）
- **缺口**：Code 榜前 10 过半不在 bank（Gemini 4 Carbon、Fable 5.1/5、GPT-6.1 Sol、
  Muse Wonder）——抽到它们无法验证。yyapi-sol 有 gpt-6.1-sol/terra/astra 但
  长生成超时不可采（短请求 OK，待重试）。

## 6. 环境与指纹（重要结论）

- **本机（笔记本 Win11）**：真 Chrome + Intel Iris Xe 真 GPU + 20C16G——指纹近
  完美，recaptcha 通过（配合人工验证+静置）。**生产路径**。
- **VPS（bohe-idc）**：SwiftShader + 2C2G，WebGL 伪装已加（9b8976b，probe 实测
  生效）但 recaptcha 仍 403——多维弱点，逐项打补丁收益递减。**降级为实验田**。
  探针自动化已删（18 次全 403，用户同意）。
- 指纹测量工具：`bin/browser-fingerprint-probe.mjs`（须走 getPage 真实管线，
  58b6167 已修）。

## 7. 识别系统组件清单（全部已提交）

| 组件 | 文件 | 状态 |
|---|---|---|
| 榜单基线解析/存储 | src/fingerprint/telemetry/baseline.mjs | ✅（Code 快照 57 类） |
| 贝叶斯判别（遥测） | src/fingerprint/telemetry/identify.mjs | ✅ |
| 被动捕获 | src/fingerprint/telemetry/capture.mjs | ✅（42 条真实任务） |
| ensemble 融合+协议门 | src/fingerprint/ensemble.mjs | ✅（min-agree=2） |
| 模型别名 | src/fingerprint/model-aliases.json | ✅（14 条） |
| numeric bank | src/fingerprint/numeric-bank.mjs 等 | ✅（13 模型） |
| CLI | bin/telemetry-baseline.mjs、bin/ensemble-cli.mjs（slot/vote/votes） | ✅ |
| 技能 | ~/.zcode/skills/arena-slot-lifecycle/SKILL.md | ✅（六节+坑表） |
| 桥接钩子 | bridge.mjs（tap 读/append ack/发送验证） | ⚠️ ack 盲区见 §4.1 |

## 8. 下一步选项（按优先级）

1. **用起来**（Goal 2 主线）：v4 槽切 ZCode 主力 → 真实任务积累 → `slot --code`
   看判别是否收敛（telemetry 真实任务量纲下 vs numeric 的分歧应消解）
2. **ack 通道攻坚**（消灭每轮 180s 空等）：sendBeacon/worker 假设验证，或
   composerWaitMs 降到 30s（ pragmatic，推荐先做这条，一行改动）
3. **扩 bank**：yyapi 长生成重试；s3ai 补 claude-fable/gpt-6.1-sol 缺失变体
4. **代理误禁 patch**：代理类错误不触发账号自动禁用
5. **VPS patchright 实验**（低优先级，成本高收益不确定）

## 9. 踩坑速查（新会话必读）

| 症状 | 处置 |
|---|---|
| 409 session_account_unavailable | `accounts.mjs enable <email>` + 重启（代理瞬断误禁） |
| 401 Public Access Token invalid | 已修（cbc74f9 land-before-token）；重试 |
| append ack timeout（回复其实在会话里） | 已知盲区 §4.1；等读流程完成即可，勿重复发送 |
| Target crashed ~400s | 外层 `timeout N` SIGTERM 伪影；给足时间 |
| 429 prompt failed | 创建限流，等 ≥5 分钟 |
| ask_user 报错 | 约定已注入三槽；当轮作废续发即可 |
| 页级 addInitScript 不生效 | 必须用 context 级（勿回退） |
| bash heredoc 生成 JS 代码 | `\n` 会被吃掉——改代码用 Edit 工具 |
| ZCode model=`agent` | 每轮新会话→429；必须填槽位 UUID |
