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
