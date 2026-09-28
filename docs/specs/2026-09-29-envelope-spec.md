# 实施规格：Collector 单次交件契约（submit_run_envelope）

- 日期：2026-09-29
- 依据：`.sdd/2026-09-28-collector-single-envelope-contract/research-report.md`（研究级判词，本规格范围内以其裁定为准）
- 代码基线：本仓工作区（与研究报告 origin/main@56a7dcd 截面一致的现网代码逐行核实，见各处 `文件:行`）
- 交付物：本规格 + 后续实现（本单不改产品代码；实现另开）
- 约束：不动 `automation/observers/`；不改 `wrangler.jsonc` 现有 crons（新增条目允许）；生产 prompt 安装归 GPT 侧，不在本单；全程不 commit。

---

## 0. 现状锚点（全部本会话亲读核实）

| # | 事实 | 证据 |
|---|------|------|
| A1 | 投资三通道窄写幂等键 = `CMD:<channel>:<SHA256(canonical({contract,channel,as_of,events}))>`，as_of **在**哈希输入内 | `src/state-commands.ts:281-297`（normalizedCommand 与 digest :281-287，writeKey :297） |
| A2 | 账本 event_id 内嵌同一 digest：`CMD:<digest>|<producer>|BATCH` | `src/state-commands.ts:293` |
| A3 | MARKET 通道幂等本就 slot 寻址，与 as_of 无关 | `src/state-commands.ts:377`（`idempotency_key=holding-assistant:<date>:<slot>`） |
| A4 | 回执表 `state_write_receipts_v1` 运行时懒建，不在 migrations 链内；表结构无 run/信封关联列 | `src/state-receipts.ts:31,34-60`；`migrations/0001..0012` 均无此表 |
| A5 | 回执状态机：PENDING/PERSISTED/IDEMPOTENT_REPLAY/OUTCOME_UNKNOWN/CONFLICT/FAILED；payload_sha256 不一致即 CONFLICT | `src/state-receipts.ts:4-11,153` |
| A6 | run 审计现状：模型自报 begin_run/end_run（run-v2）+ 旧 STARTED/FINAL 合同（legacy-event-v1），`effective_status = outcome ?? "IN_PROGRESS"`，孤儿=现状必然 | `src/automation-run-ledger.ts:938`、`src/index.ts:1570-1611,1613-1650,1652-1767` |
| A7 | run_id 只在 `appendInvestmentCommand`/`appendMarketObservation` 返回值回显（`src/state-commands.ts:329,421`），不进回执表（A4）也不进账本 payload → 按 run 聚合派生 fresh 数当前不可能 |  |
| A8 | 窄写工具四件套注解 `openWorldHint:false` + 顶层与 event items 双层 `additionalProperties:false`，测试锁死 | `src/index.ts:1280-1285`（另三处 :1319-1324,:1358-1363,:1397-1402）；`tests/state-gateway-mcp.test.mjs:316-356` |
| A9 | 通用 `append_state_batch` 保持 open（openWorldHint:true），按 `isOwnedStateCommandPayload` 分流到 owner 内核 | `src/index.ts:1481,1486,1502` |
| A10 | cron trigger 只驱动行情桥；scheduled handler 无其他分支 | `src/index.ts:3059-3075`；`wrangler.jsonc:48-57`（5 条 cron） |
| A11 | 生产六任务排班（Asia/Shanghai）：preclose=工作日 09:10/10:10/16:45，intraday=工作日 09:50/10:50/11:50/13:50/14:50，industry-research=每小时:45，company-facts/central-policy=每小时，ai-financing-rates=每 4 小时 | `automation/control/production.json:17,45,74,102,129,154` |
| A12 | prompt 编译器把 `{{STATE_APPEND_TOOL}}` 按任务替换为 append_company_events / append_industry_events / append_market_observation；COMMON 片段含 run-audit（STARTED+FINAL 两次 record_automation_run 打卡）；含"废弃引用"黑名单门 | `automation/build_prompts.py:38-44,47-56,238,243-245`；`automation/fragments/run-audit.md:2-3` |
| A13 | prompt 预算：编译产物 > max_chars 即 BUILD FAIL（现余量很小：industry-research 5501/5600） | `automation/build_prompts.py:179-181,246-247`；`automation/control/production.json:77-78` |
| A14 | 测试跑法：`node --experimental-strip-types --test`；D1 shim 真跑迁移链 0001-0012 | `package.json:11`；`tests/helpers/d1-sqlite-shim.mjs:31` |
| A15 | 通知判定现状：`notification_intended`/`fresh_delta_count` 纯模型自报，服务端从不验证 | `src/automation-run-ledger.ts:60-67,229-241` |

---

## 一、submit_run_envelope 工具：入参 schema、通道判别、空包语义

### 1.1 工具注册（`src/index.ts`，与现有窄写同区新增）

```ts
server.registerTool(
  "submit_run_envelope",
  {
    description:
      "定时任务单次交件：一次调用同时完成本轮登记与内容落账。提交 task_name + 人话 summary + 可选 channel_payload；无新增时省略 channel_payload（空包=心跳）。Collector 服务端在一个调用内完成：幂等、通道校验、账本写入、运行终态派生、fresh 计数与通知门判定，并全部回执给模型。禁止携带 write_key/producer/schema_version/event_id 等服务器字段。",
    inputSchema: SUBMIT_RUN_ENVELOPE_INPUT_SCHEMA,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  /* handler 见 §1.4 */
);
```

注解三件套照窄写实测可行形状（A8：`src/index.ts:1284` + `tests/state-gateway-mcp.test.mjs:325-336`）。

### 1.2 入参 schema（新增 `src/run-envelope.ts`；closed schema，无任何服务器字段）

```ts
import {
  COMPANY_EVENT_COMMAND_SCHEMA,
  CLOSE_EVENT_COMMAND_SCHEMA,
  INDUSTRY_EVENT_COMMAND_SCHEMA,
  AS_OF_SCHEMA, // 现为模块内 const（state-commands.ts:24-28 未导出）：本单为其补 export，其余三个 schema 已导出（:63,71,79）
} from "./state-commands.ts";
import { MARKET_LEDGER_SLOT_SCHEMA } from "./market-ledger.ts";

const ENVELOPE_SUMMARY_SCHEMA = z.string().min(1).max(1200);

// 事件子 schema 原样复用 state-commands.ts:63-88 导出的三个事件 schema，
// 不在信封层重新定义，保证与窄写工具的字段面逐字一致。
const CHANNEL_MEMBER_SHAPE = {
  as_of: AS_OF_SCHEMA, // 必填（同现有窄写，state-commands.ts:90-96），但不进幂等身份（§二）
  events: /* 各通道对应 EVENT schema 的 .strict() 数组，min(1).max(128) */
};

export const SUBMIT_RUN_ENVELOPE_INPUT_SCHEMA = z
  .object({
    task_name: z.enum(AUTOMATION_REGISTRY_KEYS), // automation-run-ledger.ts:17-24 六键
    summary: ENVELOPE_SUMMARY_SCHEMA,            // 必填，可一句话；上限同 OPTIONAL_SUMMARY
    channel_payload: z
      .discriminatedUnion("channel", [
        z.object({ channel: z.literal("INDUSTRY"), ...CHANNEL_MEMBER_SHAPE_INDUSTRY }).strict(),
        z.object({ channel: z.literal("COMPANY"),  ...CHANNEL_MEMBER_SHAPE_COMPANY  }).strict(),
        z.object({ channel: z.literal("CLOSE"),    ...CHANNEL_MEMBER_SHAPE_CLOSE    }).strict(),
        z.object({
          channel: z.literal("MARKET"),
          trading_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
          as_of: AS_OF_SCHEMA,
          scheduled_slot: MARKET_LEDGER_SLOT_SCHEMA,      // market-ledger.ts:7-16
          production_ref: z.string().regex(/^[0-9a-f]{40}$/i),
          records: z.array(z.record(z.string().min(1), z.unknown())).max(512),
        }).strict(),
      ])
      .optional(), // 省略 = 空包 = 心跳
  })
  .strict();
```

要点（逐条钉死）：

1. **closed schema 三件套**：顶层 `.strict()` + union 成员 `.strict()` + event 子 schema `.strict()` → JSON Schema 顶层与 event items 双层 `additionalProperties:false`，与窄写同形状，过 A8 同款测试断言。
2. **禁泄漏服务器字段**：schema 中不出现 `write_key`、`producer`、`dimension`、`source_task`、`schema_version`、`event_id`、`portfolio_version`、`live_universe_hash`（对齐 `tests/state-gateway-mcp.test.mjs:291-299,340-355` 两份禁词表）；`submit_run_envelope` 必须加进该测试的工具名单与断言循环（§八）。
3. **通道判别**：zod `discriminatedUnion("channel")`——判别键 `channel` 为字面量枚举，非法通道与未知键一律拒绝。**两层校验契约（评审 F1 钉死）**：MCP SDK 在进 handler **之前**就按 inputSchema 校验（`node_modules/@modelcontextprotocol/sdk/dist/esm/server/mcp.js:125` 调 `validateToolInput`，`:166-178` zod 失败即抛 `McpError(InvalidParams)`）——经 `client.callTool` 的信封 schema 违规**永远到不了** `processRunEnvelope`，表现为 InvalidParams 错误响应且不落 run-v3 行；`processRunEnvelope` 内部的 `parseCommand` 式严格解析（`src/state-commands.ts:40-51`）仅作防御纵深，服务直调/内部调用路径。两层的拒绝语义都算"校验失败"，但可观测形状不同（§4.2、§八①）。
4. **字段投影复用**：INDUSTRY/COMPANY/CLOSE 的 `events` 直接交给现有 `appendInvestmentCommand`（`src/state-commands.ts:303-330`）内核——通道内关系校验（CLOSE 跨通道链，`src/state-gateway.ts:366-455`）、字段投影、GitHub 账本、回读比对零改动；MARKET 分支交给现有 `appendMarketObservation`（`src/state-commands.ts:395-422`），链校验（checkpoint 链、production_ref 等）原地不动。
5. **run_id 字段取消**：信封不收 run_id（模型自报身份废除）；run_id 由服务端生成 `run_<32hex>`（同 `src/automation-run-ledger.ts:486` 形状）。
6. **as_of 位置**：as_of 留在各 channel 成员内（必填，与现有窄写一致），**不在**信封顶层。理由：investment 账本按 payload.as_of 排序（`src/investment-ledger.ts:443-447`）、MARKET 命令要求 as_of（`src/state-commands.ts:117`）；信封层只是不把它算进幂等身份（§二）。
7. **空包=心跳语义**：`channel_payload` 省略 → 不发生任何 GitHub 账本写入、不产生回试行，仅登记一条 run-v3 行（终态 SILENT）。心跳即"本轮跑过、没有可入账的新增"，是 Prometheus Watchdog 式反向判定（没收到=缺件，§六）。summary 必填保证心跳行也有人话摘要。
8. READ_ONLY 任务（central-policy、ai-financing-rates）只交心跳或带 summary 的空包；它们的服务端 fresh 计数恒 0（无账本可写），通知判断仍由模型按 fresh-delta 自律执行——这是明示残留边界（研究报告"两条诚实边界"之 1），不是缺陷。

### 1.4 handler 流程（伪码，`src/run-envelope.ts` 新函数 `processRunEnvelope`）

```
入参: { db, token, envelope, principal, portfolioVersion, liveUniverseHash,
        collectorBuildSha, cloudflareVersionId, fetchImpl?, now?, requestId? }
       ——portfolioVersion/liveUniverseHash 由工具 handler 经 resolveOwnerCommandContext()
         （src/index.ts:1193-1225，读 env.PORTFOLIO_UNIVERSE）解析后传入：
         appendInvestmentCommand 必需 portfolioVersion（src/state-commands.ts:303-311），
         appendMarketObservation 必需 portfolioVersion+liveUniverseHash（src/state-commands.ts:395-404）。
0  仅 channel_payload 存在时（心跳不需要）：步骤 0=resolveOwnerCommandContext；
   失败（STATE_UNAVAILABLE phase=READ，retryable=true，src/index.ts:1195-1219）→
   先落 UNKNOWN 行（同键重试可翻正）再抛错（§4.2 retryable 拆分规则）。
1  received_at = now ?? new Date().toISOString()          // 服务端权威时钟；入参无任何时间字段
2  envelope_key 派生（§二）。信封 schema 拒绝且 task_name 可解析的路径（仅 processRunEnvelope 直调可达，§1.2 要点3）：
   envelope_key := E:INVALID:<sha256(canonical(原始入参 JSON))>（前缀 E:INVALID 不与合法键撞唯一索引；
   同一坏包字节级重试天然同键），event_count=NULL → 直接写 FAILED 行后抛错，跳过步骤 3-6（评审 F2）
3  查 run-v3 (task_name, envelope_key):
     - 命中且 outcome != 'UNKNOWN' → 返回 ENVELOPE_REPLAY（原终态原字段，不再触账本）
     - 命中且 outcome == 'UNKNOWN' → 继续重执行（复用该 run_id，步骤 7 更新同一行）
4  slot 绑定：读排班表，取 [slot, slot+40min) 含 received_at 的排班项 → slot/slot_date；无 → NULL
5  INSERT INTO run-v3 … ON CONFLICT(task_name, envelope_key) DO NOTHING
   （outcome='UNKNOWN'，channel、envelope_key、received_at、slot 已知项先落。
   评审 F4：禁用 INSERT OR IGNORE——它会连 NOT NULL/CHECK 违反一并吞掉，插不进时重读无行、分支未定义；
   ON CONFLICT 只吞唯一索引冲突，仓内 shim 已有同款 upsert 先例（tests/helpers/d1-sqlite-shim.mjs:8-13））
     - 唯一索引输给并发重试 → 重读行；若已终态 → 按 ENVELOPE_REPLAY 返回
     - 重读仍无行（非冲突性插入失败）→ 抛 STATE_UNAVAILABLE retryable=true（落 UNKNOWN，同信封可重试）
6  执行：
     - 心跳 → 跳账本，直接终态派生
     - INDUSTRY/COMPANY/CLOSE → appendInvestmentCommand({command:{as_of, events}, portfolioVersion})
     - MARKET → appendMarketObservation({command:{trading_date, as_of, scheduled_slot,
       production_ref, records}, portfolioVersion, liveUniverseHash})
7  终态派生（§四矩阵）→ UPDATE run-v3 行（WHERE task_name+run_id 且 outcome='UNKNOWN'）
8  组装工具回执（§1.5）。步骤 7 为 BLOCKED/FAILED/UNKNOWN 时：先记账后抛错（错误响应携带 run_id/outcome/blocker_code）
```

崩溃安全说明：D1 无法把 GitHub HTTP 包进事务，故采用"先 UNKNOWN 行、后 UPDATE 终态"两段式（同 run-v2 begin/end 的服务端两段式骨架，`src/automation-run-ledger.ts:487-517,614-638`）。两段之间崩溃 → 行留 UNKNOWN → 同信封重试在第 3 步进入重执行 → 账本层由既有回执租约/幂等吸收重复（`src/state-receipts.ts:132-191`）。UNKNOWN 行超过 24h 未终结视为需人工排查信号（本单不自动清扫）。

### 1.5 工具回执（成功路径）

```json
{
  "status": "ENVELOPE_RECORDED | ENVELOPE_REPLAY",
  "run_id": "run_<32hex>",
  "task_name": "industry-research",
  "outcome": "COMPLETED | SILENT | BLOCKED | FAILED | UNKNOWN",
  "envelope_key": "E:INDUSTRY:<64hex> | HB:<bucket>",
  "slot": "19:45 | null",
  "slot_date": "2026-09-29 | null",
  "ledger": {
    "status": "PERSISTED | IDEMPOTENT_REPLAY | SKIPPED_HEARTBEAT",
    "channel": "INDUSTRY | null",
    "write_key": "CMD:INDUSTRY:<64hex> | null",
    "comment_id": "… | null",
    "url": "… | null"
  },
  "fresh_delta_count": 1,
  "event_count": 3,
  "notification_required": true,
  "notification_semantics": "SERVER_DERIVED_FLOOR",
  "delivery": "MODEL_DELIVERY_UNVERIFIED",
  "timeliness": "FRESH | STALE"
}
```

错误路径沿用 `stateGatewayErrorResponse`（`src/index.ts:936`）形状，另附 `run_id`/`outcome`/`blocker_code`/`envelope_key`。

### 1.6 配套登记

- `getGatewayStatus().registered_tools` 增加 `"submit_run_envelope"`（`src/state-gateway.ts:719-737`）；`STATE_GATEWAY_VERSION` 1.1.0 → 1.2.0（`src/state-gateway.ts:30`）。
- 工具授权走既有 `requireStateScope(STATE_WRITE_SCOPE)`（`src/index.ts:1010-1042` 同款），无新 scope。

---

## 二、幂等 digest 剔除 as_of + STALE 窗口标记

### 2.1 digest 精确改法（`src/state-commands.ts`）

改动点只有一处——`buildInvestmentCommandBatch` 内的 normalizedCommand（现 `src/state-commands.ts:281-287`）：

```ts
// 改前（A1）
const normalizedCommand = { contract: "owned-state-command-v1", channel: input.channel, as_of: parsed.as_of, events };
// 改后
const normalizedCommand = { contract: "owned-state-command-v1", channel: input.channel, events };
```

- `as_of` 仍照常写入 batch 与账本 payload（`batch.as_of`，`src/state-commands.ts:294`），只退出**身份哈希**。
- 该函数同时服务窄写四工具与通用 `append_state_batch` owner 路径（`src/index.ts:1502-1529` 走同一函数），改一处两轨生效。
- MARKET 路径不动（其幂等本就 slot 寻址，A3）。
- `contract` 字符串保持 `owned-state-command-v1` 不变：新旧键本就因哈希输入不同而必然不同，改串无增益。

### 2.2 存量 write_key / receipt 影响面

1. **旧键不可达、不迁移**：存量 `state_write_receipts_v1` 行的 `write_key = CMD:<ch>:<digest(含 as_of)>`，新代码永远不会算出相同键 → 旧行成为纯历史，保留原样，无回填。
2. **无跨方案 CONFLICT**：新提交只产生新键；`reserveStateWrite` 的 payload_sha256 冲突比对（A5，`src/state-receipts.ts:153`）不会碰到旧键。
3. **一次性过渡风险（明示接受；评审 F9 修正措辞）**：同一 events 集合"改前首写 + 改后重试"跨部署重放时，新键未命中回执 → 走 GitHub 追加 → 新 event_id（`CMD:<新digest>|producer|BATCH`，A2）与旧 event_id 不同 → 落内容重复的账本 comment。两点如实：① digest 变更同时**永久收窄** GitHub 账本 event_id 的光环——旧 comment 的旧 digest event_id 对新提交永不命中，此收窄不可逆；② "最多重复一条 comment"仅在 D1 回执行存在时成立；回执缺失（D1 重建/新环境）且跨部署时，每次重试可各产生一条重复 comment。验收口径放宽为**按次重复**（每次跨部署重试至多一条），检出判据不变：两条 CMD: 行 events 数组逐字相同即本症。备选方案（新旧双哈希查询）因一次性收益不抵复杂度，否决。
4. **模型侧收益即本条目的**：重贴时间戳不再产生新 write_key → **在 D1 回执行存在时**，重试同一批内容必然在触 GitHub 前短路命中 `IDEMPOTENT_REPLAY`（`src/state-gateway.ts:581-596`），G-2 漏洞（研究报告事实 8）关闭。回执缺失场景不在此承诺内，见 §十残留风险 6。

### 2.3 信封层身份（envelope_key）

- INDUSTRY/COMPANY/CLOSE：`E:<CHANNEL>:<payloadSha256>`，其中 payloadSha256 即 2.1 改后的 batch digest（as_of 已剔除）→ 同内容换 as_of/换 summary/换措辞重投 = 同键 = `ENVELOPE_REPLAY`。
- MARKET：`E:MARKET:<sha256(canonical({trading_date, scheduled_slot, production_ref, records}))>`——**不能**直接用 slot 幂等键：同 slot 换 records 的修正重交必须能落一条新 BLOCKED 行（账本层 `STATE_CONFLICT`），若信封身份=slot 键会被既有 COMPLETED 行的 replay 路径遮蔽。
- 心跳：`HB:<received_at 的 UTC 小时桶>`（如 `HB:2026-09-29T12`）。心跳无业务内容可哈希，按服务端时钟分桶：同桶重试合并为一条 run 行（重试语义），跨桶各成一行（不同时段的心跳都必须可见，否则 §六会把后一个时段误判缺件）。跨小时边界的重试可能产生两条心跳行——低危，明示接受。
- summary / prompt 措辞 / 未知调用方字段**一律不进**身份（语义去重是明示非目标；指纹只防同一包重发）。

### 2.4 as_of 对 received_at 的 STALE 窗口标记

- 规则：`as_of` 存在时，`STALE := (received_at − as_of) > W` 或 `(as_of − received_at) > 5min`。**评审 F7：窗口宽 W 绑定该任务排班行的 `window_minutes`（§4.1 可配置列），无 enabled 排班行时回退常数 40**——不硬编码 40，避免与排班表日后调参漂移成两个常数。未来戳>5min 视为时钟错乱。读侧推导与信封回执 `timeliness` 用同一条规则、同一次排班行查询。
- **读时派生不落库**：run-v3 行只存 `as_of` 与 `received_at` 两个原始事实，`as_of_stale` 布尔在 `get_automation_run_history` 输出与信封回执 `timeliness` 字段现算（哲学与 §六 MISSED_SLOT 一致：派生值不持久化，防漂移）。
- STALE 是**标记不是闸门**：不影响 outcome、不影响 fresh 计数（研究报告 G-6 定位为标记）。

---

## 三、回执表补列：信封关联 id、事件数

### 3.1 方案选择：**运行时懒建扩展（建表语句加列 + 容错 ALTER），不做 migrations 文件**

选它的理由（对照另一选项"ALTER 迁移文件"）：

1. `state_write_receipts_v1` 从来不在 migrations 链里，唯一建表路径是运行时懒建（A4：`src/state-receipts.ts:34-60`）。migrations/0013 若写 `ALTER TABLE state_write_receipts_v1 ADD COLUMN …`，在全新 D1（本地 miniflare、未来新环境）上表不存在直接报错；若写 `CREATE TABLE IF NOT EXISTS(新全形)+ALTER`，新装环境建表已含新列、ALTER 再加列必然 `duplicate column` 报错——SQLite 的 ALTER 没有 `IF NOT EXISTS`，**写不出幂等迁移**。
2. 仓内既有先例：`automation_runs_v2` 同时有 0011 迁移与运行时 ensure+兼容回填（`src/automation-run-ledger.ts:272-375`），且运行时 ensure 是唯一保证所有环境可用的那半。
3. 新列全部可空，旧行零影响；D1 shim 测试里回执表由被测代码运行时建，天然同时覆盖"老表加列"与"新表直建"两条路径。

### 3.2 具体改法（`src/state-receipts.ts`）

```sql
-- 建表语句（:39-54）末尾在 last_http_status 之后追加两列：
  envelope_key TEXT,
  event_count INTEGER

-- ensureReceiptTable（:34-60）在 CREATE 之后追加一次性容错 ALTER（WeakMap 已缓存只跑一次）：
ALTER TABLE state_write_receipts_v1 ADD COLUMN envelope_key TEXT;
ALTER TABLE state_write_receipts_v1 ADD COLUMN event_count INTEGER;
-- 每条 ALTER 用 try/catch 吞掉 /duplicate column name/i，其余错误照抛。
```

- `StateWriteReceipt` 类型（:14-29）加两个可空字段 `envelope_key: string | null`、`event_count: number | null`；`normalizeReceipt`（:70-88）对应透传。
- `finalizeStateWriteReceipt`（:193-235）签名加可选 `envelopeKey`/`eventCount`，仅信封路径传入；UPDATE 仍走原 `WHERE write_key AND lease_owner` 租约守卫，非租约路径（replay）不改写。
- `reserveStateWrite`（:132-191）不动（预留时两列为 NULL；replay 命中的旧回执保持其原 NULL——该回执属于更早的写，关联语义为"本信封首次成功持久化所创建的回执行"）。
- 影响面：`get_state_write_receipt` 工具（`src/index.ts:1810-1865`）返回体新增两字段，纯增量；`getStateWriteReceiptSummary`（:102-130）不受影响。

### 3.3 写入时机

信封路径调用 `appendStateBatch` 时把 `envelopeKey`/`eventCount` 透传（`appendStateBatch` 现有可选参 writeKey/payloadSha256 同位追加，`src/state-gateway.ts:533-536`），仅在 `finalizeStateWriteReceipt` 成功/失败终结时落列：
- `event_count` = 服务端投影后的事件数（investment = `events.length`；MARKET = `records.length`）——**服务端数的，不是模型报的**。
- 非 envelope 写（旧窄写工具直调、通用 append_state_batch）两列保持 NULL，不改语义。

---

## 四、run-v3 表结构、终态派生、end_run 废弃兼容

### 4.1 表结构（新增 `migrations/0013_automation_runs_v3.sql` + 运行时懒建，双轨照 0011 先例）

```sql
-- 0013_automation_runs_v3.sql
-- 单次交件契约的运行审计；终态由 Collector 从信封处理结果派生，模型不再自报。
CREATE TABLE IF NOT EXISTS automation_runs_v3 (
  task_name TEXT NOT NULL,
  run_id TEXT NOT NULL,                -- run_<32hex>，服务端生成
  envelope_key TEXT NOT NULL,          -- E:<CHANNEL>:<digest> / E:MARKET:<digest> / HB:<bucket>
  channel TEXT,                        -- MARKET/INDUSTRY/COMPANY/CLOSE；心跳为 NULL
  write_key TEXT,                      -- 账本幂等键；心跳为 NULL
  as_of TEXT,                          -- 模型申报观察时点，仅存证（STALE 读时派生）
  received_at TEXT NOT NULL,           -- 服务端权威时钟
  slot TEXT,                           -- 收件时命中的排班槽 "HH:MM"；窗口外为 NULL
  slot_date TEXT,                      -- 该槽的 Asia/Shanghai 日期
  fresh_delta_count INTEGER CHECK (fresh_delta_count IS NULL OR fresh_delta_count >= 0),
  event_count INTEGER CHECK (event_count IS NULL OR event_count >= 0),
  outcome TEXT NOT NULL CHECK (outcome IN ('COMPLETED','SILENT','BLOCKED','FAILED','UNKNOWN')),
  blocker_code TEXT,
  summary TEXT,                        -- 模型一句话人话摘要（≤1200）
  prompt_version TEXT,                 -- 预留，本单恒 NULL
  collector_build_sha TEXT,
  cloudflare_version_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (task_name, run_id)
) WITHOUT ROWID;

CREATE UNIQUE INDEX IF NOT EXISTS automation_runs_v3_envelope
  ON automation_runs_v3 (task_name, envelope_key);

CREATE INDEX IF NOT EXISTS automation_runs_v3_task_time
  ON automation_runs_v3 (task_name, received_at DESC);

CREATE INDEX IF NOT EXISTS automation_runs_v3_time
  ON automation_runs_v3 (received_at DESC);

-- 排班表（§六同迁移文件）
CREATE TABLE IF NOT EXISTS automation_schedule_v1 (
  task_name TEXT PRIMARY KEY,
  slot_times TEXT NOT NULL,            -- JSON 数组 ["HH:MM", ...]，Asia/Shanghai
  weekdays TEXT NOT NULL,              -- JSON 数组 0..6，0=周日（对齐 wrangler cron 约定，wrangler.jsonc:49）
  window_minutes INTEGER NOT NULL DEFAULT 40,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
  updated_at TEXT NOT NULL
) WITHOUT ROWID;
-- 种子行 = production.json:17,45,74,102,129,154 的排班实况：
--   holding-assistant-preclose: 工作日 ["09:10","10:10","16:45"]
--   holding-assistant-intraday: 工作日 ["09:50","10:50","11:50","13:50","14:50"]
--   industry-research:          每日 24 × "HH:45"
--   company-facts / central-policy: 每日 24 × "HH:00"
--   ai-financing-rates:         每日 ["00:00","04:00","08:00","12:00","16:00","20:00"]（相位待与 GPT 侧核对后可 UPDATE 修正）
```

设计说明：
- **新表而非改 v2**：v2 的 CHECK 约束锁死四枚举（`migrations/0011_automation_runs_v2.sql:11`），加不了 `UNKNOWN`；研究报告亦裁定换表最省。旧 run-v2 原样留读（§4.3）。
- **outcome 新增 `UNKNOWN`**：现网回执状态本就有 OUTCOME_UNKNOWN（A5），终态派生必须能诚实表达"结果未知"，否则会把未知冒充成失败/成功。`UNKNOWN` 非终态，重试可翻正（§1.4 步骤 3）。
- **唯一索引 (task_name, envelope_key)**：并发重试的硬闸，INSERT OR IGNORE 输家重读回放（同 `src/automation-run-ledger.ts:487-517` 模式）。
- 心跳行 channel/write_key 为 NULL 但 fresh_delta_count=0、event_count=0 非空，CHECK 允许。

### 4.2 终态派生矩阵（钉死）

| 信封处理结果 | outcome | fresh_delta_count | 语义 |
|---|---|---|---|
| 账本写入 `PERSISTED` | `COMPLETED` | 1 | 本轮有真新增 |
| 账本写入 `IDEMPOTENT_REPLAY` | `SILENT` | 0 | 内容早已入账（含改戳重试） |
| 心跳（无 channel_payload） | `SILENT` | 0 | 正常静默 |
| `StateGatewayError` 且 `retryable=false`、code ∈ {CONFLICT, CHAIN_MISMATCH} | `BLOCKED` | NULL | 业务关系/幂等冲突，blocker=code+phase |
| `StateGatewayError` 且 `retryable=false`、其余 code（含 VALIDATION_FAILED、信封 schema 拒绝（仅直调路径可达，见下注）、**AUTH/配置类 STATE_UNAVAILABLE**） | `FAILED` | NULL | 永久失败（含误配置），blocker=code+phase；schema 拒绝行 envelope_key=`E:INVALID:<原始入参digest>`、event_count=NULL（评审 F2） |
| `StateGatewayError` 且 `retryable=true`（OUTCOME_UNKNOWN、READBACK_FAILED、租约竞争 UNAVAILABLE、owner 上下文 READ UNAVAILABLE） | `UNKNOWN` | NULL | 结果未知；同信封重试可翻正 |
| `ENVELOPE_REPLAY`（同键重访） | 沿用原行 | 沿用原行 | Stripe 式"重放返回首次结果" |

映射依据：以 `StateGatewayError.retryable`/`phase` 判别为主键，code 为辅（构造器默认 `retryable=false`，`src/state-gateway.ts:64`；各码出处 :36-43）。**retryable 拆分是评审五的钉死项**：`STATE_UNAVAILABLE` 一码两义——AUTH 配置缺失（`GITHUB_TOKEN`/`RESEARCH_REPLICA` 不在场，`src/index.ts:1291-1297` 等，phase=AUTH、不可重试）与租约竞争"write already in progress"（`src/state-gateway.ts:597-604`，retryable=true）。前者落 FAILED（误配置应告警而非每轮重执行进 24h 人工桶），后者落 UNKNOWN（瞬态，重试可翻正）。FAILED/BLOCKED/UNKNOWN 行**照常落 run-v3**（先记账后抛错，§1.4 步骤 8）。schema 拒绝的两种可达性（评审 F1/F2 钉死）：经 MCP `client.callTool` 时 SDK 在 handler 前校验（`mcp.js:125,:166-178`）→ `McpError(InvalidParams)`，**不落任何 run-v3 行**；`processRunEnvelope` 直调（内部/防御纵深路径）时 task_name 可解析 → FAILED 行落 `E:INVALID:<sha256(canonical(原始入参 JSON))>` 键、event_count=NULL，同坏包重试天然 ENVELOPE_REPLAY；task_name 本身不可解析（枚举外/非字符串）→ 无键可挂，仅返回错误、不落行（诚实边界，写进测试）。

派生是**原子终点**：一次信封=至多一个账本批次（union 单通道），fresh_delta_count ∈ {0,1,NULL}，"数出真正落了几条新的"由服务端从写入结果得出（回执 status），不读 GitHub、不信模型。

### 4.3 模型 end_run 职责废弃的兼容策略

1. **旧工具全部保留**：`begin_run`（`src/index.ts:1570-1611`）、`end_run`（:1613-1650）、`record_automation_run`（:1652-1767）、`get_automation_run_history` 的 run-v2/legacy 存储与代码路径零删除、零行为变更——旧 prompt 安装（切轨前）继续完整工作，#37 关单验收（observer 口径）在旧轨跑完不受影响。
2. **prompt 不再依赖**：新 prompt 集（§七）删除 begin/end/record 打卡指令；编译器把 `begin_run`、`end_run`、`record_automation_run` 加进废弃引用黑名单（`automation/build_prompts.py:243-245`），从编译层面保证新 prompt 不可能再调它们。
3. **读侧合并（评审 F8 钉死算法）**：`get_automation_run_history` 改为两次大上限 SELECT + JS 归并——v2 走既有过滤（since 比对 `COALESCE(finished_at, started_at, updated_at)`，`src/automation-run-ledger.ts:915-917`），v3 用 `received_at >= since` 过滤（v2 的时间表达式对 v3 无 started_at 不适用），各自 `LIMIT 1000`（独立于用户 limit 的读上限），JS 内按行时间键（v2=`COALESCE(finished_at, started_at, updated_at)`，v3=`received_at`）倒序归并后再切 `limit`——**先 limit 后归并会错序丢行，禁止**。行带 `source_contract: "run-v2" | "run-v3" | "legacy-event-v1"`（v2 行字段照旧，`src/automation-run-ledger.ts:929-963`；v3 行字段见 §六输出）。切换期两轨行并存，MISSED_SLOT 合成行按 §6.2 槽位归并进同一列表。
4. **不迁移数据**：v2 存量行不回填 v3（两表并存即真话；回填反而伪造"服务端派生"的假象）。

---

## 五、notification_required 派生进工具回执

- **定义**：`notification_required := fresh_delta_count > 0`（即本轮信封产生 ≥1 个 PERSISTED 账本批次）。单通道信封下取值域 {false, true}；心跳恒 false。
- **位置**：信封工具回执字段（§1.5），同时进 `get_automation_run_history` 的 run-v3 行输出（存证侧）。
- **语义三句话（写进工具 description 与 prompt 要点）**：
  1. 这是服务端从写入事实算出的**通知地板**：true ⇒ "至少这些新增值得通知"，false ⇒ "服务端没有看到任何需要通知的入账事实"。
  2. **投递仍是模型职责**：消息只能由 ChatGPT 会话侧模型发出；回执恒带 `delivery: "MODEL_DELIVERY_UNVERIFIED"`，服务端不验证、不宣称送达——任何文档不得写成"通知门已全服务端化"（研究报告边界 1 原文要求）。
  3. READ_ONLY 任务恒 false：它们无账本写入，通知判断仍按 fresh-delta 片段自律（残留边界，明示非本契约覆盖）。
- 被替代物：`end_run.notification_intended` / `record_automation_run.notification_sent` 自报字段不再是新轨字段（旧轨保留原样，§4.3）；`fresh_delta_semantics` 在 v3 行输出 `"SERVER_COUNTED"`（对照 v2 的 `"CALLER_REPORTED"`，`src/automation-run-ledger.ts:953`），观察者可按语义字段区分两轨口径（观察者文件本单不动，口径更新列为待验 4）。

---

## 六、排班表 + 定时缺件检测（MISSED_SLOT，读时派生不落库）

### 6.1 排班表

表结构与种子行见 §4.1（同在 0013 迁移）；运行时懒建 ensure 同 automation_runs_v3 一并处理（`src/run-envelope.ts` 内 ensure，WeakMap 缓存模式同 `src/state-receipts.ts:32-60`）。**评审 F3：ensure 除建表外必须同时 `INSERT OR IGNORE` 六行排班种子（与 0013 迁移同一常数）**——§3.1 已论证存在迁移未跑的环境（全新 D1/miniflare），该环境下 ensure 只建空表会让 slot 绑定恒 NULL、MISSED_SLOT 推导找不到任何 enabled 行，缺件检测**静默失效**；种子随 ensure 落地后任意环境行为一致。时区换算用固定 +08:00 偏移（中国无夏令时），不引入 Intl 依赖。

### 6.2 MISSED_SLOT 读时派生（不落库）

挂在 `get_automation_run_history`（`src/automation-run-ledger.ts:881-973` 扩展）：

```
输入：task_name?、since?、limit?（沿用现有参数面）
推导：对每个 enabled 排班行，枚举 [max(since, now-7d), now] 内的每个 (slot_date, slot_time) 窗口
     窗口 = [slot, slot + window_minutes)（Asia/Shanghai）
判满：窗口内存在任一行即满足——
     v3: received_at ∈ 窗口；或 v2/legacy: started_at/finished_at ∈ 窗口（切轨期两轨并认）
输出：未满足的窗口生成合成行 {
       task_name, effective_status: "MISSED_SLOT", slot, slot_date,
       window: "09:10..09:50", derivation: "SCHEDULE_WINDOW",
       source_contract: "schedule-derivation"
     }，按时间归并进 runs 列表（附在对应时段位置）。
上限：合成行 ≤200 条（防响应爆炸），超出时最早截断并在响应附 truncated: true。
```

**查询形状（评审 F6 钉死）**：每 (task, 表) 至多**一条**按时间范围的 SELECT——`received_at >= 推导起点`（v3）与 `COALESCE(finished_at, started_at, updated_at) >= 推导起点`（v2，即 §4.3.3 同一次读取的数据），大上限拉回后在 **JS 里分桶对窗**；**禁止逐窗口发 SQL**——industry-research 等每小时任务 × 7 天回看 ≈ 672 个窗口，逐窗查询必撞 D1 语句/bind 预算（研究报告：Free 层 D1 50 stmt/batch、100 bind/query）。判满与 §4.3.3 的 history 归并共用同一次读取，不重复查询。

- **不落库**：MISSED_SLOT 永远现算，不写任何表（派生规则或排班改动即时生效，无状态漂移）。
- 语义统一：没跑 与 跑了没交 都表现为该窗口 MISSED_SLOT（研究报告主编裁决：不再为区分二者保留 STARTED 轨道）。
- 残留风险（明示）：A 股节假日不在排班表知识内——任务当日真没排班就会出 MISSED_SLOT。缓解：holding-assistant 节假日按 prompt 交心跳空包即判满；其余任务若自动化本身节假日不跑，MISSED_SLOT 属实反映"没收到"。修正手段=更新排班表 enabled/weekdays，不改代码。

### 6.3 对账触发（最小实现，不改现有 5 条 crons；评审一/二修订版）

**改法写死（照字面实现不歧义）**：现有 scheduled handler 的 catch 会 rethrow（`src/index.ts:3071-3074`：`logBridgeFailure(context, error, "scheduled"); throw error;`）——若把对账"追加在 updateQuoteBridge 之后"，桥一旦失败对账就永不执行。因此对账必须放在 **`finally` 位置**，保持桥失败语义不变、同时保证对账必跑：

```ts
async scheduled(controller: ScheduledController, env: Env) {
  const context = bridgeContext(runId);            // 现状保留（src/index.ts:3060-3062）
  try {
    const payload = await updateQuoteBridge(env, context.runId);
    logBridgeStage(context, "scheduled_complete", { ... });   // 现状保留（:3064-3070）
  } catch (error) {
    logBridgeFailure(context, error, "scheduled");
    throw error;                                    // 现状保留：桥失败仍令 scheduled invocation 失败
  } finally {
    await runScheduleReconciliation(env, context); // 新增；内部自带 try/catch，绝不向外交错、不吞桥错误
  }
}
```

- `runScheduleReconciliation` 执行与 6.2 相同的窗口推导（最近 24h），把 MISSED_SLOT 结果以 `console.log(JSON.stringify({event: "automation_missed_slot", ...}))` 输出到 Worker observability（`wrangler.jsonc:62-64` 已启用）；内部任何异常只 console.warn，不 rethrow。
- **行为变化（明示）**：`finally` 中的对账 await 会延长该 invocation 的执行时长（一次 D1 读+派生，秒级）；桥失败路径新增"失败前仍完成对账"，桥失败本身的上报行为不变。
- 测试注意：scheduled handler 现无直接单测（Windows 专属套件外），新增 `runScheduleReconciliation` 独立导出以便在 `tests/automation-schedule.test.mjs` 直测（§八）。

**新增 cron 条目的交付步骤（评审二修订：plan tier 实测是合并前置动作，不是可选附注）**：

1. 合并前实测部署账户 Cloudflare plan tier（研究报告待验 1，半小时级动作）：Free 层 cron 上限 5/账户，现 `wrangler.jsonc:50-56` 已 5 条，第 6 条会被拒。
2. 实测放行（cron >5 可用）→ **本次 PR 直接带上** `"*/20 * * * *"`（新增条目，允许；不动现有 5 条），检测延迟压到 ≤20 分钟。
3. 实测为 Free → 本次 PR **不带**新 cron，且 §十残留风险 7 生效；后续升级 plan 后补一行配置即可（handler 对所有 cron 一视同仁，无代码差异）。

**现状节奏的如实量化（不再承重研究报告"每 30 分钟对表"的说法）**：现有 5 条 cron 全部 `mon-fri`、集中在 UTC 00:55 与 01:39–08:29（`wrangler.jsonc:51-55`），折算上海时间覆盖约 08:55–16:29，且 UTC hour 4 缺失 → 上海 12 时段无触发、周末零触发；而 industry-research / company-facts / central-policy 是全天候每小时任务（`automation/control/production.json:74,102,129`）。故 piggyback-only 模式下缺件检测延迟：周末漏跑 → 最早下周一 08:55（上海，`wrangler.jsonc:51` 的 `55 0 * * mon-fri`）；工作日 16:29 后漏跑 → 次日 08:55；白天漏跑 → 数小时内。这正是必须先做 plan tier 实测的原因。

---

## 七、automation/prompts 与 fragments 改写要点（要点清单；生产安装归 GPT 侧）

目标形状：每轮"读快照 → 分析 → submit_run_envelope ×1"。三次打卡（record STARTED + 账本写 + record FINAL）收敛为一次交信封。

| 文件 | 改写要点 |
|---|---|
| `automation/fragments/run-audit.md` | 整片重写：删除 record_automation_run STARTED/FINAL 两段（现行 :2-3）；改为"每轮恰好一次 submit_run_envelope，task_name=REGISTRY_KEY；无新增=省略 channel_payload 交空包（心跳）；信封失败→按 common-safety 停受影响动作并简报，不改键重投、不换工具回退旧 append_*；回执 outcome/notification_required 照办投递，落账不等于已投递"。READ_ONLY 任务的空包义务也写在这片（COMMON 对六任务生效，build_prompts.py:38-44）。 |
| `automation/fragments/state-gateway.md` | 删除 `{{STATE_APPEND_TOOL}}` 窄写指令（现行 :3-4）；改为 channel_payload 四通道 payload 形状说明（INDUSTRY/COMPANY/CLOSE=as_of+events；MARKET=trading_date/as_of/scheduled_slot/production_ref/records）；保留纪律句：写前快照去重不变（非目标：语义去重）、"不要先调 validate_state_batch"、"未知结果不得改键重投"、落账不等于通知。 |
| `automation/fragments/investment-input.md` | events 字段规则并入 channel_payload 语境；删除 run_id 表述（信封无此字段）；补一句"summary 用一句人话写本轮结论，不写原文/持仓/凭据"。 |
| `automation/fragments/fresh-delta.md`、`output-style.md`、`common-safety.md` | 内容不动（分析纪律、表达、安全边界与交件方式正交）。 |
| `automation/prompts/holding-assistant.md` | :15 段改写：append_market_observation 段落 → 信封 channel_payload MARKET 形状；休市"静默结束"改为"交心跳空包"（使节假日窗口判满，配合 §6.2）。 |
| `automation/prompts/{industry-research,company-facts,central-policy,ai-financing-rates}.md` | 主体不动；各自把"FINAL/SILENT/BLOCKED 表述"统一为"信封 summary + outcome 由服务端派生"口径；industry-research 的 safe_summary 候选计数句改为写进 envelope summary。 |
| `automation/build_prompts.py` | `{{STATE_APPEND_TOOL}}` 替换表（:232-238）改为统一 `submit_run_envelope`（或删除占位符改硬编码，选后者更简：state-gateway.md 不再含 `{{…}}`，:239-240 的未解析模板门保留作保险）；废弃引用黑名单（:243-245）追加 `begin_run`、`end_run`、`record_automation_run`；max_chars 预算不动（A13，prompt 只缩不涨）。 |
| `automation/control/production.json` | 新 prompt 安装并 VERIFIED 后由 GPT 侧流程更新 compiled_prompt_sha256/production_ref（本单不安装、只改仓内源件）。 |

切轨顺序（依赖关系，非本单执行）：① 本单服务端先行合入部署（纯增量，旧轨不受影响）→ ② GPT 侧按新源件编译并安装新 prompt（生产安装归 GPT）→ ③ 切轨时点与 #37 关单时点由世豪与 GPT 侧约定；切轨前排班检测已可用（v2 行并认）。

**改写红线（评审 F5）**：改写后的片段/prompts 文本**不得出现 `begin_run`、`end_run`、`record_automation_run` 字面量**——编译器废弃引用黑名单（`automation/build_prompts.py:243-245`）扫的是编译产物**全文**，本单同时把这三个工具名追加进黑名单后，片段里哪怕写"不再调用 record_automation_run"这类否定句都会 BUILD FAIL。"勿回退旧打卡工具"一律用非点名措辞（如"旧的双段运行登记入口已废弃"）。

---

## 八、测试清单

跑法：`cd work/quantpro-collector && npm test`（`package.json:11`，node --experimental-strip-types --test）；类型门 `npm run type-check`。

| 文件 | 新增/修改 | 覆盖 |
|---|---|---|
| `tests/run-envelope.test.mjs` | **新增** | ① schema 严格性，**评审 F1：分两层断言，明文禁止放松 inputSchema 让测试通过（会破坏 A8 宿主闭包硬门）**——(a) 直调 `processRunEnvelope`（单测缝）注入顶层多余键、未知 channel、具名通道 events=[]、MARKET 缺 as_of/slot 非法/production_ref 非 40hex、summary 空、task_name 出枚举 → 全部 STATE_VALIDATION_FAILED，且 FAILED 行 envelope_key=`E:INVALID:<原始入参digest>`、event_count=NULL，**同坏包二次提交 → ENVELOPE_REPLAY 回放同一 FAILED 行（评审 F2）**；task_name 不可解析 → 零行；(b) MCP 层经 `client.callTool` 注入同类坏参 → `McpError(InvalidParams)`（SDK handler 前校验，`mcp.js:125,:166-178`）且 run-v3 零新行；② 身份：同 events 换 as_of/换 summary/夹带未知字段 → 同 envelope_key（ENVELOPE_REPLAY，零 GitHub POST）；换 events → 新键；③ 心跳分桶：同小时两次 → 一行；跨小时 → 两行；④ 终态矩阵：PERSISTED→COMPLETED、REPLAY→SILENT、心跳→SILENT、CLOSE R1 无 INDUSTRY R1（触发 `src/state-gateway.ts:371-389` 链门）→BLOCKED、outcome_unknown 注入（首 POST 抛网络错）→UNKNOWN→同键重试翻正 COMPLETED（run_id 不变）；**retryable 拆分（评审五）**：注入 AUTH 配置缺失（GITHUB_TOKEN=None 形状）→ FAILED 而非 UNKNOWN；**回执缺失死锁（评审三/§十.6）**：fetchImpl 预置同 event_id 不同 as_of 的账本 comment 且回执表无行 → 同 events 换 as_of 重投 → BLOCKED，二次同信封重试 → ENVELOPE_REPLAY 恒回放 BLOCKED（行为钉死，可事后检出）；⑤ 回执字段：notification_required=true 恰在 PERSISTED、delivery 恒 MODEL_DELIVERY_UNVERIFIED、timeliness STALE 注入（as_of 早于窗口宽 W，W 取该任务排班行 window_minutes，评审 F7）；⑥ 回执表列：PERSISTED 后 `state_write_receipts_v1.envelope_key/event_count` 非空；⑦ 步骤 5 分支：模拟唯一索引竞争 → ENVELOPE_REPLAY；模拟非冲突插入失败 → STATE_UNAVAILABLE retryable=true（评审 F4）；⑧ owner 上下文失败（PORTFOLIO_UNIVERSE 缺失形状）→ UNKNOWN 行 + 错误响应（§1.4 步骤 0）。 |
| `tests/automation-schedule.test.mjs` | **新增** | 排班 ensure+种子行；**空库 ensure 后六行种子齐全（评审 F3：建表与 INSERT OR IGNORE 种子同一 ensure 内完成）**；窗口数学：边界含含（[start,start+window_minutes)）、Asia/Shanghai 日期翻转（UTC 与 +08 跨日）、weekdays 过滤；MISSED_SLOT 派生：空窗→合成行、v2 行并认（切轨期）、since 截断、200 上限；**查询形状（评审 F6）：断言一次派生对每 (task,表) 只发一条 SELECT（可用计数 fetchImpl/SQL 日志钉死）**；节假日残留行为按设计断言（工作日无行→MISSED_SLOT）；`runScheduleReconciliation` 直测（scheduled handler 无直接单测，函数须独立导出；含"内部异常只 warn 不 rethrow"断言，评审一配套）。 |
| `tests/state-commands.test.mjs` | 修改 | 新增"as_of 重贴不改写身份"用例（现 :60-78 模式同款：companyCommand 换 as_of → writeKey/payloadSha256/event_id 全等）；既有用例不改应继续通过（其固定 as_of 不受影响）。 |
| `tests/state-gateway-mcp.test.mjs` | 修改 | 工具名单（:266-282）加入 `submit_run_envelope`；注解断言纳入：readOnlyHint=false、idempotentHint=true、openWorldHint=false、顶层 additionalProperties=false；**union 成员级闭包断言（评审六，禁止只复用现有循环）**：现有事件层检查 `schema.properties.events?.items`（:332-338）对信封返回 undefined → 断言静默跳过，必须新增 `channel_payload` union 容器（`anyOf`/`oneOf`，以 listTools 实际输出键名为准取其一）的成员遍历，对 INDUSTRY/COMPANY/CLOSE 三成员断言 `properties.events.items.additionalProperties === false`、四成员断言自身 closed；禁词扫描照旧覆盖（:289-306 与 :340-355 均只序列化 `tool.inputSchema`，对 union 内层同样生效）。**description 无需改写**：两份禁词扫描只序列化 inputSchema，§1.1 description 文本提及 write_key/producer 等词不触雷，不要为绕扫描画蛇添足删描述。新增端到端：shim DB + 假 fetchImpl 走 MCP 调用断言 §1.5 回执字段；`get_gateway_status.registered_tools` 含 submit_run_envelope。 |
| `tests/automation-run-ledger.test.mjs` | 修改 | v2/legacy 既有用例零改动通过（兼容性回归）；新增 v3 行合并读取：source_contract 三值、v3 行 effective_status=outcome、UNKNOWN 行 final_recorded=false、fresh_delta_semantics="SERVER_COUNTED"、as_of_stale 标记。 |
| `tests/state-gateway.test.mjs` | 修改 | 旧式写（非信封）后回执两新列为 NULL；`getStateWriteReceipt` 往返新列；无表环境读助手仍只读（现 :133 用例延伸）。 |
| `tests/helpers/d1-sqlite-shim.mjs` | 修改 | `MIGRATION_PREFIXES`（:31）追加 `"0013"`；用例内验证运行时 ALTER 在"迁移已建新表"与"老表已存在"两形态下均幂等。 |

明确不新增的测试面：`automation/observers/`（禁改）；wrangler cron 相关（无配置变更默认合入）。

---

## 九、非目标与红线

- **非目标**：语义去重（模型写前读快照保留，`automation/fragments/state-gateway.md:3` 纪律不变）；通知投递服务端化（delivery 恒 MODEL_DELIVERY_UNVERIFIED）。
- 不动 `automation/observers/`；不改 `wrangler.jsonc` 现有 5 条 crons；不动钱门/执行面；验证只用自然运行样本（研究报告红线：不造人工写入冲验收）。
- 待验项继承研究报告：① plan tier 实测——已升格为 §6.3 的合并前置交付步骤（决定本次 PR 是否随带 */20 cron）；② 512-record 信封 miniflare CPU 实测（进 run-envelope 测试的性能冒烟）；④ 观察者对 run-v3 字段的消费口径更新（GPT 侧/后续单）。

## 十、明示残留风险（设计消不掉的）

1. 一次调用都没发的失败模式仍在（交信封本身也是模型动作）——由 §六 MISSED_SLOT 反向判定兜底，从"9 个服从点"缩到"1 个出手点"。
2. 换措辞重报同一事实，服务端拦不住（指纹只防同一包重发）。
3. READ_ONLY 任务的"该不该通知"无服务端裁决基础（无账本可数），通知地板恒 false，投递判断留在模型自律。
4. 节假日/排班相位误差可致 MISSED_SLOT 误报或漏报；修正路径=排班表数据更新，不动代码。
5. digest 改法的跨部署重试可能重复账本 comment，且**按次计**（评审 F9 修正）：回执行在 → 一次跨部署重试至多一条；回执缺失（D1 重建/新环境）→ 每次重试各一条。旧 digest event_id 对新提交的光环收窄是永久性的。检出判据不变（§2.2.3：两条 CMD: 行 events 逐字相同）。
6. **回执缺失 + 换 as_of 死锁边角（评审三新增）**：§2.2.4 的重放短路只在 `state_write_receipts_v1` 回执行存在时成立。回执行缺失（D1 重建/新环境/回执表丢失）而 GitHub 账本已有同 digest 批次时：同 events 换 as_of 的重投会走完账本 event_id 预检（`src/investment-ledger.ts:562-580`），`batchEquals` 对整批 canonical payload 全量比对、含 `as_of`（:428-430；batch.as_of 写入于 `src/state-commands.ts:294`）→ `INVESTMENT_LEDGER_EVENT_ID_CONFLICT` → `STATE_CONFLICT` → run 判 BLOCKED；又因 envelope_key 不含 as_of，同信封重试被 ENVELOPE_REPLAY 恒回放该 BLOCKED——fresh 内容已在账本、`notification_required=false` 且无法翻正，模型只能换 events 逃逸。**裁定：采纳方案 a**——登记为残留风险并在 §八 run-envelope 测试④加死锁行为断言（确定性、可事后检出：账本 comment 与 BLOCKED run 行 events 逐字相同即本症）；否决方案 b（"STATE_CONFLICT 且事件数组逐字相等时派生 SILENT"的豁免分支）——它要求派生层在冲突后再发起账本比对读，引入新读路径与误判面，收益不抵。
7. **缺件检测延迟（条件性，评审二新增）**：若 §6.3 交付步骤实测为 Free 层导致本次 PR 不带 */20 cron，则 piggyback-only 模式下缺件检测延迟按 §6.3 量化执行——周末漏跑最长至下周一 08:55（上海）才发现、工作日夜间漏跑至次日 08:55、白天漏跑数小时；MISSED_SLOT 在此期间既不进日志也不进 history 合成行以外的任何告警面。升级 plan 补上 */20 后本条自动失效。
