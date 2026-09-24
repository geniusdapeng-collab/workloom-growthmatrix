# 隔离副本 · 有意偏离与补偿控制（RDAS v3.1 §0.1 通道）

> 仓：`workloom-ai/workloom-growthmatrix`（**隔离副本**，`sync/child-repos.json#isolatedRepos`）
> 验收轮次：G7 / T-2026-0921-0003｜被测提交：`37f56b8`（分支 `task/T-2026-0921-0003-g6c`）
> 规格依据：本仓自己的计划与账本（`docs/GROWTHMATRIX-EXECUTION-PLAN.md`、`docs/GROWTHMATRIX-DEV-LEDGER.md`）

## 0. 一句话结论

**本报告为隔离副本验收，不作为基座证据**：L/U 层在本机预览档（`local-preview`：三端 3100/3101/3102 + server 8790 + 本地 PG + `LLM_PROVIDER=mock`）
实测；P 域按 `client-runtime` 档执行但**目标不可达 / 凭据缺失**，结论为**未验证/不通过**。
机器结论 1 条红线（#2）对应本仓**声明式偏离**（去审批化下线审批中心），已给出补偿控制与证据。

## 1. 环境档位分层（不得混淆）

| 层 | 环境档位 | 目标 | 结论 |
|---|---|---|---|
| L0–L16 / U0–U8 | `local-preview` | PC :3100 · B 端移动 :3101 · C 端 :3102 · server :8790 | 见 REPORT；矩阵 77/77 岗、87/87 技能；UI 33/33 路由；U 域机检 39/39 |
| O0–O9 | 未配置 | `acceptance/outcomes/*.yaml` 缺省 | 未验证（`configured=false`，不写通过） |
| P0–P3 | `client-runtime`（执行档） | server :9207 / web :5593（桌面客户端偏移端口） | **未验证/不通过**：目标不可达；dsh 缺；Ark 账户欠费 403；无真实模型凭据 |

## 2. 声明式偏离（与基座口径不同，且为产品所有者决定）

| 编号 | 基座 RDAS 期望 | 本仓口径（依据） | 影响项 | 补偿控制（可复跑） |
|---|---|---|---|---|
| DEV-01 | 审批中心 + 三手势 + 决策包卡片（EXP-02 / L7 / O 域部分） | **去审批化**：下线审批中心/任务中心审批状态/统一待办审批计数；保留 `fence-engine`、`review-console`、`approvals` 表与 tRPC、业务链路关卡（计划 §9.2，T-2026-0921-0050） | EXP-02 不适用；红线 #2 由该条触发 | ① 业务关卡就地放行端到端：`pnpm acceptance:gates`（11/11：队列可见/L4 分层/批量放行/L4 与高危留待/汇总事件/手势链路/契约关卡↔结算/信任收紧）；② 服务端 approvals 面保留并由 `suite:geo`（C-14 分层）与 `acceptance:onboarding` 覆盖；③ 晨报仍显式播报「L2/L3/L4 待办件数」（0 值也如实报） |
| DEV-02 | 首启首价值文案含「待决/待我拍板」词（EXP-01） | 本仓改用「待放行关卡」口径（同一治理事实，不同措辞） | EXP-01 机检词失配（首价值 26.6s 亦超 20s 阈值） | `onboarding.actionCard` 固定返回「待放行关卡」条（含 tier/等待时长/出处）+ `/portfolio` 组合看板显示同源数据；建议下一轮把 EXP-01 词表加入「待放行/关卡」同义词（属基座执行器改动，需走提案） |
| DEV-03 | 首日上岗「五关」（含拍板关） | 四关（认人/定方向/派活/验收）；拍板关整关删除（计划 §9.2） | B-63 内容包关卡数 | `pnpm acceptance:questline`（18/18）覆盖四关推进/跳关拒绝/跳过单记/账本四类事件/行动卡/漏斗 |
| DEV-04 | `sync/` 基座资产同步机制 | 书面声明不参与双向同步（`docs/BASE-SYNC-DECLARATION.md`，DEC-17） | L16「资产治理」部分条目 | 本仓自持 `providers`/`bundle.json` 摘要 + `bundle:governance --release` 签名验签（公钥环 `build/bundle-trust.json`） |

## 3. P 域（生产实测）未验证的精确原因

| 任务 | 状态 | 证据 | 解除条件 |
|---|---|---|---|
| LLM-R1 / LLM-T1（dsh Harness 真实推理） | blocked | 缺可执行文件 `packages/runtime/dsh-gate/node_modules/.bin/dsh` | 安装 dsh 依赖并跑 `packages/runtime/dsh-gate` 自检 |
| LLM-M1（多模态渲染夹具） | blocked | 执行器宿主缺 `playwright`（本仓已软链，基座执行器宿主需同装） | 基座克隆装 `playwright` 或改用本仓执行器 |
| LLM-G1（模型网关直连） | failed | HTTP 404（未配置真实端点） | 注入 `LLM_BASE_URL`/`DEEPSEEK_API_KEY` |
| IMG-01 / IMG-02 / VID-01（Seedream/Seedance） | failed | HTTP 403 `AccountOverdueError` | 火山方舟账户充值或更换账户 |
| PROD-01（产品派单目标） | failed | `client-runtime` 目标 9207 不可达（桌面客户端运行时未安装） | 安装桌面客户端运行时并指向该端口 |

> 纪律：`live.mjs --selftest` 的替身产物**不作为证据**；本轮未使用。

## 4. 与不变量的关系（逐条核对）

| 不变量 | 本仓状态 | 证据 |
|---|---|---|
| 租户隔离 | 保持 | `pnpm scan:rls` 全绿；RLS 用例（含 `growth_daily` security_invoker 修复 0044）；新增表 0046 走同一 RLS 模式 |
| 只增不改 | 保持 | `biz_events` 禁改/禁删触发器在位；围栏放宽改为「L4 放行 + 只增留痕」（B-74 演练修复） |
| 先围栏后动作 | 保持 | `scan:fences` 0 缺口；104 条组合围栏装载；G-CON1/G-BB1 协作围栏 + 模板化协作规则 |
| 高风险人审 | **收紧后放宽**（偏离） | 基座审批中心下线；风险由「业务关卡 + L4 分级」承担：L4/高危永不批量（B-70），围栏放宽需 L4（B-74），升档需人批（B-72） |
| 无回执不算完成 | 保持 | 运行时 E3.7 未核实语义；契约结算与台账同事务（B-40）；`verify-chain` 全绿 |
| 客户数据不上行 | 保持 | PII 占位符协议；C 端承接去个人信息（B-52/B-82）；本轮 P 域未上行任何客户数据 |

## 5. 复跑命令（本轮全部实测）

```bash
pnpm acceptance:matrix            # 77/77 岗 · 87/87 技能
node ~/WorkLoom-fleet/workloom-im/scripts/acceptance/ui-probe.mjs --profile <preview profile> --out outputs/acceptance/ui      # 33/33 路由 · 77/77 档案页 · 93/93 技能卡
node ~/WorkLoom-fleet/workloom-im/scripts/acceptance/experience.mjs --profile <preview profile> --out outputs/acceptance/experience   # 8/10（EXP-01 词表、EXP-02 偏离）
node ~/WorkLoom-fleet/workloom-im/scripts/acceptance/ux.mjs --profile <preview profile> --out outputs/acceptance/ux          # 39/39
node ~/WorkLoom-fleet/workloom-im/scripts/acceptance/live.mjs --env client-runtime --profile <preview profile> --out outputs/acceptance/live  # 0 ok / 3 blocked / 5 failed（环境阻塞）
pnpm acceptance:gates             # 11/11（去审批化补偿控制）
pnpm acceptance:questline         # 18/18（首日上岗）
pnpm acceptance:collab            # 协作闭环
pnpm drill:backup                 # 五条回滚路径
SERVER_BASE=http://localhost:8790 pnpm release:gate   # 11/11（沙箱档）
```

## 6. 判定（人工复核建议）

- 机器结论：**不通过**（1 条红线 #2，对应 DEV-01），P 域未验证。
- 人工口径建议：**条件通过（隔离副本 / 本机预览档）**——L 层结构、U 层体验、O 层未配置、P 层环境阻塞；
  DEV-01 的红线在本仓由补偿控制覆盖（`acceptance:gates` 11/11），需产品所有者确认「业务关卡」替代「审批中心」的验收口径。
- Go/No-Go：**No-Go（生产）**：P 域未验证（Ark 欠费 / dsh 未装 / 9207 不可达 / 无真实模型凭据）；
  内部演示与继续开发：**Go**（`release:gate` 11/11、双域套件 81/81 · 43/43、全包测试绿）。

---

## 第二轮（2026-09-24 · client-runtime 四端 · T-2026-0921-0003 第 2 轮）

> 详细版：`outputs/acceptance/DEVIATIONS.md`（机器报告 `outputs/acceptance/REPORT.md` 必须与它同读）。
> 环境升级：**四端齐活**——PC `5593` / B 端移动 `3421` / C 端 `3422` / API `9207` + 独立 PG `5852`
> （`desktop.portOffset=420` 偏移语义的独立运行时实例；非打包安装包，`installState=failed/recovery` 如实标注）。

### 0'. 结论

- 机器结论：**不通过（红线 #2）**——唯一红线来自 **L4-02 = EXP-02「审批中心三手势」**，即 DEV-01 声明式偏离；
  报告另有 1 条 P 域 fail：`P0-03 生产只读纪律`（本轮按授权做夹具写入，见 DEV-05）。
- **P 域生产实测首次全绿：8/8**（真实 DeepSeek ×4 + Seedream 5.0 pro ×2 图 + Seedance 2.5 ×1 视频 12s + 产品派单），
  配额台账 3 图 / 1 段 12s / LLM 4 次 / 预估 ¥15.514（上限 8 图 / 3 段 45s / ¥120）。
- L 域：`matrix 79/79 岗 · 91/91 技能`、`ui 79/79 档案页 · 97/97 技能卡 · 33/33 路由`、`experience 9/10`、`ux 39/39`；
  U/O 层因人工研究证据缺项按纪律记「未验证」（不写通过）。
- **合并漂移已处理**：提交前 `origin/main` 两次推进（`0dc431b` 摄影师批次 → `f87d231` 交付包批次）：
  组合编制 78 → **79 岗**、随包技能 88 → **91**、围栏 114 → **128 条**；已重装隔离运行时工作区、
  重跑 L/U/P/O 全部证据，并同步 `stats-sync`/`bundles.test`/`acquisition-loop.test`/`suite-hotel` 口径断言与 README。

### 1'. 偏离台账（新增/更新）

| 编号 | 状态 | 说明 |
|---|---|---|
| DEV-01 去审批化 | 保持 | 补偿控制本轮 **11/11**（`pnpm acceptance:gates`）+ 真机三杆验证（`/tasks/T-128` 关卡卡"推进/校准/制动"可见可点）；本轮另修"编辑放行不续跑/批量放行不续跑"与"关卡卡按 LLM 自造动作名过滤导致不可见"两个真机缺陷 |
| DEV-02 首价值词表 | **解除**（本轮通过） | EXP-01 首价值 3.6s（阈值 20s），"今日待决"来自业务关卡队列（`ActionCardBanner`） |
| DEV-03 四关（非五关） | 保持 | `acceptance:questline` 18/18（历史轮次证据，本轮列入验收债） |
| DEV-04 不参与 sync | 保持 | 本仓自持签名与摘要；本地执行器修复清单待回基座（见下） |
| **DEV-05 生产写纪律** | 新增 | 授权写入 + 夹具前缀 + 残留披露；残留清单见 `outputs/acceptance/DEVIATIONS.md §5` |

### 2'. 本轮真机发现并修复（7 项）

① `judgeViews` 执行真相视图 fail-closed 角色化（`packages/base/fence-engine/judge.ts` + 6 例回归）；
② 编辑放行/批量放行不续跑（`apps/server/src/trpc/router.ts`）；
③ 待放行关卡卡不可见（`packages/runtime/src/loop.ts` 落 `snapshot.gate/tool/rule_ids` + `apps/web/src/pages/p2/gate-filter.ts`）；
④ Seedream 5.0 pro 不支持组图参数 → 逐张调用（`scripts/acceptance/lib/live/providers.mjs`）；
⑤ `backup-drill.mts` 硬编码 5432 → 按 `DATABASE_URL` 派生连接参数；
⑥ ADR/HIR 回执口径路径错误（顶层 `receipt`）→ 覆盖率 0%→100%；
⑦ redteam 未 `runImmediately`（假通过）+ 按标签判定（假告警）→ 以 `decision.tool` 为真相。
⑧ 交付包批次两技能（`delivery-package-ops` / `delivery-revision-ops`）围栏绑定漏登记 → `scripts/skill-bindings.mts` 补齐（matrix 89/91 → **91/91**）；
⑨ `release-gate` QUEST 等待上限不可配置 → 增 `GATE_QUEST_TIMEOUT_MS`（默认 60000 不变）；谷时段 L2 档（`deepseek-v4-pro`）实测 39.9–63s，默认 60s 会间歇判红，本轮显式放宽并列为 **P2 风险**（不视为 SLO 达标）。

### 3'. 复跑命令（本轮实测，client-runtime 档）

```bash
node ~/WorkLoom-fleet/workloom-im/scripts/acceptance/matrix.mts    --out outputs/acceptance/matrix
node ~/WorkLoom-fleet/workloom-im/scripts/acceptance/ui-probe.mjs  --out outputs/acceptance/ui
node ~/WorkLoom-fleet/workloom-im/scripts/acceptance/experience.mjs --out outputs/acceptance/experience
node ~/WorkLoom-fleet/workloom-im/scripts/acceptance/ux.mjs        --out outputs/acceptance/ux
node scripts/acceptance/live.mjs --env client-runtime --keys-file ~/.workloom/live-merged-20260924.env --out outputs/acceptance/live
node scripts/acceptance/outcome.mjs  --out outputs/acceptance/outcome
node scripts/acceptance/redteam.mjs  --out outputs/acceptance/redteam
node scripts/acceptance/autonomy.mjs --out outputs/acceptance/autonomy
node scripts/acceptance/coverage.mjs --root outputs/acceptance --checklist <基座>/docs/acceptance/checklist.v3.json --out outputs/acceptance/coverage.json
node scripts/acceptance/report-v3.mjs --root outputs/acceptance
pnpm acceptance:gates ; pnpm release:gate ; pnpm drill:backup ; pnpm db:verify-chain
pnpm typecheck ; pnpm test ; pnpm test:scripts ; pnpm suite:geo ; pnpm suite:hotel
```

### 4'. 判定（人工复核建议）

- 机器结论：**不通过**（红线 #2 对应 DEV-01）+ P 域 `P0-03` 已授权写入。
- 人工口径建议：**条件通过（隔离副本 · 生产实测档）**——P 域全绿、L 域除声明偏离项外无失败、U/O 人工证据缺项照实记未验证。
- Go/No-Go：**内部/演示：Go**（release:gate 11/11、双域套件 81/81 · 43/43、全量单测与类型检查绿）；
  **对外生产发布：待产品所有者确认"业务关卡"替代"审批中心"的验收口径**（DEV-01）后 Go。

---

## 第三批（2026-09-25）· 人工项落地 / 长跑启动 / 9 项修复回基座

### 1. 人工项（RDAS 检查单）落地：`manual-missing` 157 → 82

机检工具：`scripts/acceptance-local/manual-evidence.mjs` + `scripts/acceptance-local/domain-evidence.mjs`（可复跑；证据写入
`outputs/acceptance/manual/<ID>.json`，计划写入 `outputs/acceptance/manual/MANUAL-PLAN.md`）。

| 类别 | 项数 | 处理方式 |
|---|---:|---|
| 真机跑过的机检项（→ `pass`） | 47 | 账本不可改（UPDATE/DELETE/TRUNCATE 全拒）· 备份/回滚五路径 · 指标留存 7 天 · 峰谷计费留痕 · 变更复考门禁 · 记忆治理用例 · 交付契约/口径文档（U0/ADR/O0/O1/O7）· 首价值与点击预算 · 三端一致 · step 级幂等 · ASVS L2 声明 + 5 项抽验等 |
| 证据待判定（→ `evidence-present`，不计通过） | 28 | 视口/UA 6 组（**WebKit/Firefox 下载失败未跑**）· 断网 30s（机检近似）· 自建 SBOM（非 CycloneDX）· 台账↔事件逐条对账（`ref_event_id` 为空）· 延迟 P95（样本不足）· 专家盲评（c-layer）· 真机/读屏/打印剪贴板等 |
| 不适用（→ `evidence-present` + 理由） | 13 | M 舰队机制项：隔离副本不在十队列（协议 §0.1），需纳管后适用 |
| 仍需人工（保留 `manual-missing`） | 82 | U 33（真实用户研究/读屏/设备矩阵）· O 31（真实业务周期与三方对账）· L 16（真手机/告警通道/万行导入/法务与专家评审）· ADR 2 |

新增文档（已入库）：`UX-MODEL.md`（角色/JTBD/六段旅程/四线蓝图/关键性矩阵/招募配额）·
`ADR-HIR-METHOD.md`（单位/分母/排除口径、H0–H4 契约、AVR 五判据四象限、对照与替代解释）·
`OUTCOME-CONTRACT.md`（岗位交付契约/KPI 映射/动作分类/rubric 预注册）· `ASVS-DECLARATION.md`（L2 目标 + 5 项抽验）。

⚠️ 纪律：计划与"文档化交付"不等于用户研究结论；`REPORT.md` 的 U/O 两层仍按「未验证」记录。

### 2. 长跑（O5）：24h + 7d 已启动

- 启动：2026-09-25 00:11（24h，间隔 60s）→ 完成后自动串行 7d（168h，间隔 300s）。
- 承载：`screen` 会话 `wlsoak`（脱离会话存活）；状态文件 `work/soak-long.status`，样本 `outputs/acceptance/soak{,-7d}/soak-samples.jsonl`。
- 通知：Codex 自动化 `growthmatrix-soak-watch`（每 2h 检查，**仅在 24h/7d 完成或失败时**通知，其余保持安静）。
- 口径：长跑只证明"采样窗口内无系统性异常"；health/线程/事件增量逐样留痕，不做趋势外推。

### 3. 9 项修复回基座（协议 §7：隔离副本不回流 → 提案任务卡）

- 提案卡：`workloom-ai/workloom-im` **#155**（含逐项缺陷、基座现状、建议修复、验证与回滚）。
- 回基座 PR：**#156**（分支 `task/T-2026-0924-0001`，10 文件）——围栏 `judgeViews` 视图角色化 + `judge-views.test.ts`（5 例）·
  运行时 decision 补 `tool`/审批快照补 `gate/tool/rule_ids` · 验收执行器 5 项（outcome/redteam/autonomy/live+providers/matrix）· `release-gate` QUEST 等待上限可配置。
- 本地验证（基座工作树实测）：`pnpm typecheck` 全绿 · `pnpm test` 全绿（composite 0 fail；base 685 / server 144 / web 85 / ui 56 / runtime 9）·
  `node scripts/acceptance/live.mjs --selftest` 通过（9 任务 5 ok / 3 blocked / 0 failed）。
- **状态：待合并**——CNB 报 `blocked_on=status_check`，`pull_request` 流水线未上报状态；`POST /-/build/start` 仅接受
  `api_trigger*` 事件（无法由我触发 PR 流水线）→ 需产品所有者/基座维护者触发门禁或人工合并。
- 两条**不适用**（已在 #155 记录，不随 PR 实现）：基座当前**无**自动续跑路径（`scheduleQuestResumeAfterApproval`/`batchRelease` 不存在），
  也没有业务关卡卡渲染 → "编辑放行/批量放行续跑""关卡卡按事实位显示"属**审批语义变更**，应另开任务卡评审。

### 4. 本批新增未决风险

- **P2 · 已完成线程"继续推进"会重新规划并追加步骤**（实测 3 步 → 5 步，事件账本追加；step 级幂等未破坏）。
  若产品期望"已完成不再消耗模型额度"，需在 `threads.run` 增加终态短路；当前按产品语义（继续干活）记录，待裁决。
- **P3 · 多引擎矩阵缺位**：WebKit/Firefox 二进制经代理下载失败（code=1），本轮只跑 chromium 6 组视口/UA（记证据待判定）。
