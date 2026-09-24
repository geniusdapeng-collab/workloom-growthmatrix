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
