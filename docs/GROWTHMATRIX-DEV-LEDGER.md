# GrowthMatrix 开发进度账本（跨会话唯一状态源）

> **会话 12 收尾（2026-09-24 深夜）**：PR **#47 已 squash 合并 → main `acdc037`**（本账本条目的提交即在其上）。
> 本轮主题：**RDAS v3.1 第二轮生产实测 + 9 项真机缺陷修复 + 去审批化补偿控制**。
> · **P 域首次全绿 8/8**（真实凭据 · client-runtime 四端 9207/5593/3421/3422 + PG 5852）：LLM-R1/T1/M1（dsh + 围栏瀑布 + 哈希链）·
>   LLM-G1（网关直连）· IMG-01/02（Seedream 5.0 pro，2+1 张落盘）· VID-01（Seedance 2.5 · 12s）· PROD-01（产品派单）；
>   配额台账 3 图 / 1 段 12s / LLM 4 次 / 预估 ¥15.514（上限 8 图 / 3 段 45s / ¥120）。
> · **O 域**：`outcome 4/4（pass@1=1 · 假成功 0）` · `redteam 7 例 0 发现 + 跨租户拒读` ·
>   `autonomy N=81 · ADR-1 98.8%（CI 93.3–99.8）· HIR 4.9% · HIR-NI 1.2% · H3+H4 0% · 回执覆盖 80.2%`。
> · **L/U**：`matrix 79/79 岗 · 91/91 技能` · `ui 79/79 档案页 · 97/97 技能卡 · 33/33 路由 · 0 问题` ·
>   `experience 9/10`（唯一失败 = DEV-01 声明的去审批化）· `ux 39/39`。
> · **9 项真机修复**：① judgeViews 执行真相视图 fail-closed 角色化（堵「未声明工具+已声明动作名」静默放行）② 编辑放行(H2)/批量放行不续跑
>   ③ 待放行关卡卡按 LLM 自造动作名过滤导致不可见 ④ Seedream 5.0 pro 不支持 `sequential_image_generation`（改逐张调用）
>   ⑤ `backup-drill` 硬编码 5432 ⑥ ADR/HIR 回执口径路径错误（假 0% 覆盖率）⑦ redteam 未立即执行 + 按标签判定（假通过/假告警）
>   ⑧ 交付包两技能围栏绑定漏登记 ⑨ `release-gate` QUEST 等待上限不可配置（谷时 L2 档 39.9–63s，默认 60s 间歇判红 → 列为 P2 风险）。
> · **合并纪律**：开工基线 `1b53cb5` → 期间 main 两次推进（`0dc431b` 摄影师批次、`f87d231` 交付包批次）→ 变基后
>   重装工作区/重跑全部 L/U/P/O 证据，并同步口径（79 岗 / 91 技能 / 128 围栏）与三包签名；**squash 合并后在 main 复跑**
>   `capabilities --check` · `bundle:governance` · `test:scripts 86/86` · `typecheck` · `pnpm test`（base 1084 / server 278 / web 122 / video-studio 99）全绿。
> · 机器结论仍为 **不通过（1 红线 = DEV-01）**，P 域「通过」；偏离与补偿控制、残留披露、未决风险见
>   `docs/acceptance/G7-DEVIATIONS.md`（第二轮章节）与 `outputs/acceptance/DEVIATIONS.md`。
> · 待产品所有者确认：**「业务关卡」替代「审批中心」的验收口径**（DEV-01）——确认后即可把红线 #2 从「机器不通过」改为「声明式偏离已接受」。

> **会话 11 收尾（2026-09-24）**：PR #41 → main `d676de82`；**合并回归修复 PR #44 → main `1b53cb5`**（当前 HEAD）；
> 另有 PR #42（偏离声明）/ #43（CI 证据等级）两笔文档改动。CNB 流水线
> （分支 PR 运行 `cnb-6n2-1k37pj2g0` / 合并后 main 运行 `cnb-vj1-1k37pjnan`）**三档 stage 全通过**（static-gate / db-gate / test-gate）。
> ⚠️ 合并回归（已修）：分支基线早于主线视频批次 `95125e8`，squash 后 ai-video 资产变更而摘要/签名未重算 →
> `bundle:governance --release` 报「ai-video 验签失败」、`capabilities --check` 漂移；PR #44 重算摘要+重签并同步
> 78 岗/88 技能口径（`suite-hotel`/`bundles.test`/`acquisition-loop`/`stats-sync` 断言同步），修后主线全绿。
> 纪律沉淀：**任何 squash 合并后必须复跑** `bundle-governance --release` → `capabilities --check` → `matrix-gap` → 双域套件（L-08 升级版）。
> G7 偏离声明已落受版本管理文档：`docs/acceptance/G7-DEVIATIONS.md`（同内容副本在 `outputs/acceptance/DEVIATIONS.md`）。
> 证据等级说明：CNB 页面三档 stage 状态为「通过」，但 test-gate 内部步骤耗时显示 0s（缓存/跳过无法从页面区分）——
> 因此 CI 只作 **B 级证据**；同等门禁已在本地逐项复跑（typecheck/全包测试/双域套件/验链/扫描/验收脚本），本地结果为 A 级。

> **会话 11（2026-09-24）接力入口**：G6 全部 15 个工作包落地并推送（分支 `task/T-2026-0921-0003-g6c`，
> 提交 `29dc200` → `6c91f60` → `f95382a` → `37f56b8`）；G7 首轮 RDAS v3.1 已跑完（报告 `outputs/acceptance/REPORT.md`）。
> 下一步：合并本分支到 main（PR 门禁）→ 解除 P 域四个环境阻塞后复跑 `acceptance:live --env client-runtime` → 出 Go/No-Go 终版。

> 用途：记录批次进度、提交 SHA、测试结果、未完成项与下一步；任何会话结束前必须更新本文件。
> 配套计划：`docs/GROWTHMATRIX-EXECUTION-PLAN.md`
> 基线：`a4b2b20`（2026-09-21）｜任务号：`T-2026-0921-0003`｜主线分支：`task/T-2026-0921-0003`

---

## 1. 当前状态

| 项 | 值 |
|---|---|
| 当前批次 | **G6 完成 + G7 两轮完成**（第二轮已并入 main `acdc037`） |
| 批次状态 | G6：15 包全部落地（会话 11）；G7 第二轮：**P 域生产实测 8/8 全绿**、O 域 4/4、L/U 机检与走查见上；机器结论仍「不通过（1 红线 = DEV-01 去审批化声明式偏离）」，其余失败项为 P0-03（已授权写入） |
| 最近更新 | 2026-09-24 深夜（会话 12 · RDAS 第二轮 + 9 项真机修复，PR #47） |
| 分支 | `task/T-2026-0921-0003-g6c2`（已 squash 合并）；后续文档更新再开 `docs/*` 分支 |
| 云端最新提交 | main `583c48a`（PR #47 squash `acdc037` 之后，另有 `T-2026-0924-0077` 契约创建修复等并行车道提交叠在其上） |
| 本地 HEAD | 工作树 `wt-g6c` = `8f1967a`（与 main `acdc037` 同树） |
| 阻塞 | 无环境阻塞；**唯一待决**：产品所有者对 DEV-01（业务关卡替代审批中心）的口径确认；另有 P2 风险（QUEST 谷时档位 39.9–63s vs 门禁 60s 等待上限，已加 `GATE_QUEST_TIMEOUT_MS`） |
| 下一步 | ① 产品确认 DEV-01 后更新红线判定口径；② U/O 域人工研究证据（157 项 manual-missing）补录；③ 长跑（24h/7d）按计划执行；④ 本地执行器 9 项修复回基座提案 |

### 会话 2 续 5 记（2026-09-22 00:15）

- 已修复：H-15 工具探针失败（同名退场行导致 probe 取到 disabled 实例）→ 探针与名册改为「优先 ready 的权威实例」；`seed.ts` 组合装配后把 ws-yunqi 的 industry 归位为 hotel；`bundles.test` + `triggers-assembly.test` 串行 12/12 通过；suite-hotel 43/43；`acceptance:onboarding` 通过；`matrix-gap` 0 缺口。
- 仍红（仅 suite:geo，阻断并入 main）：① A-02「preset_key 重复」（geo-growth bundle.json provides 28 条路径无重复、presets 目录 28 个 key 无重复，需进一步定位套件加载口径）；② A-10 已把 G-AD2 的 `content_asset` 改为已声明对象，待复跑确认；③ C-15 账号指标 16 条 ≠ 期望 14 条（seed 幂等漂移，待查 account_metrics 插入键）。
- 纪律：main 保持绿色点 `4287f21`；以上改动只在任务分支 `task/T-2026-0921-0003`。

### 会话 3 记（2026-09-22 00:30）

- 三项回归红点全部定位并处置：
  1. A-02：断言写成「28 个 preset 文件、27 个唯一 key」，实际 B-09 下沉后是 28 文件 / 28 唯一 key；改为按 `presetKeys.size === presets.length` 断言唯一性（断言文案同步修正）。
  2. C-15：`account_metrics` 是只增时序表，种子按「近 7 天」滚动写入，全表计数会随运行天数自然增长（本次 16 行）；改为按当前 7 天窗口核对两账号各 7 天，保留历史行（不删数据）。
  3. C-16/C-17：`pnpm-workspace.yaml` 的 `allowBuilds` 仍是 pnpm 11 生成的占位字符串，导致 pnpm 11 在运行脚本前的依赖检查触发 `pnpm install` 失败；执行 `pnpm approve-builds --all` 将其归一为布尔值并落库，本机 pnpm 11 可直接运行 `pnpm db:seed:geo` / `db:verify-chain`。
- 回归结果（2026-09-22）：`suite:geo` 81/81；`suite:hotel` 43/43（先复跑 `pnpm db:seed` 归位组合装配）；`bundles.test` 11/11（RUN_DB_TESTS=1）；`triggers-assembly.test` 4/4；`acceptance:onboarding` 通过；`matrix-gap` 0；base/contract typecheck 通过。
- 修复提交：`f3e4fb6`（pnpm 11 构建许可）、`49ae735`（suite:geo 断言口径）。
- CI test-gate 复现与修复（2026-09-22 00:45）：test-gate 的 P0 门禁 stage（`acceptance:onboarding` + `scan:fences` + `scan:knowhow`）中 `scan:fences` 报「G-AD2 动作 content.submit 缺别名对象 content」；根因是 `2025d7f` 精简 G-AD2 对象枚举时移除了 `content`，而组合对象模型（geo-growth/hotel 均声明 `content`）按工具前缀派生该视图。修复：G-AD2 `object_types` 补回 `content`，刷新 geo-growth 摘要；本地 `scan:fences` 0 缺口、`scan:knowhow` 15/15、`suite:geo` 81/81、`bundles.test` 11/11 全绿。
- 队列处置（协议 §4 先到先得）：PR #5/#6（调色批次，基于 `22af93c` 且与 main 冲突）与 PR #7 改同一批文件，锁门禁判定 #7 排队。处置：先在本会话注释并临时关闭 #5/#6（分支与提交保留），#7 合并后立即把调色分支 rebase 到最新 main（本地已完成一版：补登 colorist/围栏/技能/LUT 清单 + 74 岗计数）后重开并跑门禁。

### 会话 4 记（2026-09-22 01:10）

- 队列清空：PR #7（G3 B-09/B-10）→ PR #5（T-0042 调色移植，rebase 后重开）→ PR #6（T-0043 配方驱动择优）全部门禁全绿并 squash 合并；main 现为 `a8d5450`（74 岗 / 72 技能 / 79 条组合围栏）。调色分支 rebase 的两个硬问题一并处置：`gradients` 默认随机相位导致的择优用例偶发红灯（改用确定性 `color+geq` 低对比夹具）、调色三套用例接入 `test:scripts`。
- B-11：新增 `bundles/geo-growth/skills/growth-metrics/SKILL.md`（五项周表分子分母冻结口径 + LTV/CAC，六原则/四打法/四步 SOP/六指标/六失败模式），评估器扩容为 16 技能，geo 题库补 2 道 growth-metrics 题（口径与 G-GROW6 数据边界）。
- B-12：`review-analyst` 增增长五栏与 `growth.metrics.read`（绑 G-GROW6）；`data-board-officer` 增 `growth.metrics.collect` 时序采集；`live-producer` 增 `clip.trigger.declare` 切片触发器声明（发布仍走 G9/G12）；`hotel/ai-receptionist` 增 `lead.source.track` 留资埋点（只写来源链不写明文客资）。
- B-43：`bundles/hotel/eval/questions.json`（22 题）与 `bundles/ai-video/eval/questions.json`（24 题）落盘并在清单声明；新增 `packages/base/bundles/eval-questions.test.ts` 装载门禁（题量/红线题/题号唯一）。技能分发接入晋升门禁：`eval_settings.promotion_gate` 开启时，**已装技能升级**必须先有一次通过的 on-change 考试（24h 内、无红线），未过考零写入、入 staging 待考并记 `skill.dist.exam_required`；tRPC 映射为 `PRECONDITION_FAILED`。
- 回归（2026-09-22）：`suite:geo` 81/81；`suite:hotel` 43/43（先 `pnpm db:seed` 归位夹具）；`pnpm test` 全包绿（base 920 / server 354 / web 101 / webb 6 / webc 21 / video-studio 22 / audit 64 / contract 40 / runtime 15）；`pnpm suite` 467/467；`test:scripts` 57/57；`acceptance:onboarding`、`scan:fences`（0 缺口）、`scan:knowhow`（16 技能）、`bundle-governance`、`capabilities --check`、`product:verify`、`oss:check`、三端生产构建全部通过。
- 已知边界（未修，留档）：考试院通用管线的 `fence_verdict` 断言通道没有产生方（`runQuestion` 不返回 fenceVerdict），因此 hotel/ai-video 新题库一律使用可判定的硬断言（拒绝/升级、PII、事实词）；围栏题的正判通道列入 B-45 验收矩阵后续项。

### 会话 5 记（2026-09-22 01:25）

- B-46 账号矩阵：`library/account-matrix.yml`（L1–L8 分层 / 9 账号 / 设备组与网络组 / 日上限 / 发布窗口）+ `packages/base/bundles/account-matrix.ts`（装载校验 + 确定性排期：未知账号、窗口、日上限、G16 同设备/同网络同小时防关联）；`account_matrix` 对象入模型。
- B-47 授权台账：`ip-curator` 下沉主包（权威归属 geo-growth，遮蔽 4→5 处，角色总数仍 74）；`ip_asset` 对象入模型；`ip-ledger.ts` 四维范围校验（用途/平台/地域/期限）+ 30/7/1 天到期预警 + 到期下架清单；新增 `tg-geo-ip-expiry` 日巡触发器（组合触发器 22→23）。
- B-48 客群装配：`bundles/geo-growth/segment-defaults.yml` 四个「起步方式」（双域日更 / 门店矩阵 / B 端 GEO / 预算敏感），引用零断链、解析幂等、P2 条件岗默认不出场。
- B-49 只读产出进晨报：hotel 三个只读岗补 `coverage`（巡检/竞对/驾驶舱）；`briefing.ts` 新增「只读岗位发现」固定栏位（按 agents.meta.coverage 聚合，缺 coverage 不虚报），`composeBriefing` 编号连续。
- B-50 P2 条件岗：两个 P2 preset 透传 `ops_metrics`/`exit_conditions`/`activation_gate`；`p2-ops.ts` 周度评估（keep/watch/exit_proposal/no_data，缺数中断连续计数）；`board.ts#composeStaffingWeekly` 编制周报（覆盖缺口/积压/过载扩编提案 + P2 指标/退场），周会简报自动附上。
- B-80 价格与权益：hotel 三份模板（价格与权益确认单 / 预售券条款 / 退改说明）+ `price_confirmation` 对象；定价岗新增 `price.confirmation.issue`（绑 R25/R2），团购岗新增 `coupon.terms.render`（绑 R22/R26/R25）。
- B-82 UGC：`ugc_submission` 对象；私域承接岗新增 UGC 四工具（征集/授权登记/去个人信息/二次发布申请）并绑 G-AD1/G-AD2/G-GROW6；`ugc-flow.ts` 四线审查（授权+凭证+肖像同意、去个人信息、署名、广告标识）与脱敏函数；geo 题库补 2 道 UGC 题。
- 回归（2026-09-22）：`suite:geo` 81/81；`suite:hotel` 43/43；`pnpm test` 全包绿（base 967 / server 354 / web 101 / webb 6 / webc 21 / video-studio 22 / audit 64 / contract 40 / runtime 15）；`pnpm suite` 467/467；`test:scripts` 57/57；新增模块用例 85/85；`acceptance:onboarding`、`scan:fences` 0 缺口、`scan:knowhow` 16/16、`bundle-governance`、`capabilities --check`、`product:verify`、`oss:check`、全仓 typecheck 与三端构建全部通过。

### 会话 6 记（2026-09-22 01:50）

- B-18 五类国内通道：`weixin-mp`（公众号，rpa 骨架）/`weibo`（rpa 骨架）/`zhihu`/`toutiao`/`baijia`（占位）适配器 + 图文上传骨架 + 图文文案硬校验；`PlatformSchema` 扩到 11 平台；迁移 `0041_publish_text_channels.sql` 扩 `publish_tasks.platform` CHECK（已应用并验链）。
- B-19 OTA 上传包：`packages/base/ota-publisher` 三通道（携程/美团/飞猪）+ 三类素材（房型图/相册/视频）+ 预检（类型/体积/相册序位）+ 上传与审核状态回写；未配置凭据 fail-closed；`ota_asset` 对象与 content-agent `ota.asset.upload` 工具接线。
- B-20/B-22 执行器桥：`bridge-client`（POST /tools/execute，超时+一次重试，回执形状校验，失败 connector-required）+ publish/source/private-domain 三桥 server-adapter + ota-bridge 直连 ota-publisher；`.env.example`/doctor/connectors-check 全量登记。
- B-21 多执行器组合：`WORKLOOM_TOOL_EXECUTOR_MODULES`（逗号列表 + `前缀=路径` 最长匹配 + 兜底路由），单模块加载/执行失败只影响自身路由，统一返回 connector-required；旧单模块变量兼容；纯函数下沉 `publish-rpa/routing.ts` 供脚本复用。
- B-23 桌面浏览器驱动：`apps/desktop/electron/publish-driver.cjs`（Playwright 持久化上下文 + setInputFiles；Toolkit 驱动映射与 CDP 上传显式检查）+ `scripts/tools/publish-worker.mts`（CLI/executePublish，登录态本机 profile，无回执不报成功）+ node:test/vitest 双侧用例。
- B-24/B-25：doctor 增「工具执行器与事件总线」段（缺路径即 ❌）；connectors-check 增执行器路由/OTA/桥就绪三表；runner 失败统一重试 3 次（上传+回执为执行单元）与平台日上限注入（dailyLimitFor）。
- B-51 直播下沉：`live-script-template.md` + `live-battle-report.md` + `live-clip-reuse.yml` 切片管线（G14/G9 门禁、post-editor/compliance/publish/distribution/review 在编）+ `tg-live-clip-reuse` 触发器。
- B-52 C 端承接化：`/c/actions` 四类动作（领券/留资/预约/咨询）→ 承接工单 + 来源链 + 联系方式脱敏 + captured 回执 + 幂等重放；webc 服务大厅「快速承接」四卡 + 表单 + 授权硬前置；e2e 4 例 + 前端契约 3 例。
- B-75 通道声明排除：`channelReadiness()` 11 通道矩阵 + `scripts/channel-readiness.mts`（--strict）+ `docs/channel-exclusions.md`（TikTok/视频号声明排除与解除条件）。
- B-81 降级路径：`buildDegradedPoster/planDegradedContent`（HTML/CSS 海报 + 「降级产出」注释/data 标注/可见角标 + manual_hold）+ degrade-bridge 执行器落盘 + visual-designer `poster.degrade.render` 工具。
- 回归（2026-09-22）：`suite:geo` 81/81；`suite:hotel` 43/43（对象模型 30 类）；`pnpm test` 全包绿（base 996 / server 367 / webc 24 / web 101 / webb 6 / video-studio 22 / audit 64 / contract 40 / runtime 15）；`pnpm suite` 467/467；`test:scripts` 62/62；桌面驱动 node:test 4/4；`acceptance:onboarding`、`scan:fences` 0 缺口、`scan:knowhow` 16/16、`bundle-governance`、`capabilities --check`、`product:verify`、`oss:check`、全仓 typecheck 与三端构建全部通过。

### 会话 7 记（2026-09-22 02:15）

- B-28/B-29：迁移 0042 给 video_assets 加 AI 标识四字段；资产注册对 AI 素材强校验（缺生成模型/清单即 BAD_AI_LABEL）；`ai-label.ts` 产出显式角标 + PNG tEXt + ffmpeg metadata 参数（确定性、可审计）。
- B-30：`model-router/ledger.ts`（diff/回滚命令/摘要）+ 服务层 `model-ledger.ts`（model.config.changed 事件）+ `scripts/model-ledger.mts`（report/record）。
- B-31：docker-compose 增 NATS JetStream（4222/8222 + 持久卷）；EVENT_BUS/NATS_URL 配置齐备（工厂三实现已有）。
- B-32：四类连接器（PMS/OTA 监测/企微/抖音本地生活）注册 + 取数函数 + readiness + fail-closed 用例；`.env.example` 登记。
- B-33：迁移 0043（account_growth_daily + growth_daily 视图）、seed-geo 写 7 天 × 2 账号、查询脚本与 PG 用例。
- B-34：C 端投影派生矩阵统计/结构缺口、增长五项与 factTable、AI 标识 schema；`projections:check` 通过。
- B-35：三类看门狗纯函数 + 服务层事件 + CLI（实跑：23 触发器/6 连接器/0 审批，事件 E-22367）。
- B-53..B-61：视频成本复算、采集调度接线、三态标识、保鲜环配置、工具幂等契约、增长偏好、夜班候选扩展、场景覆盖审计（26 场景并集 / 52 声明 / 26 缺口）、事件与模型链压测。
- B-78/B-79/B-84：OSS inventory 刷新后 `test:oss` + `oss:check` 全绿；新增表 RLS 用例并**发现修复 growth_daily 视图 security_invoker 缺失导致的 RLS 绕过（0044）**；外部事实复核脚本 + 报告（23 条规格 / 17 项待复核）。
- 回归（2026-09-22）：`pnpm test` 全包绿（base 1038 / server 367 / webc 24 / video-studio 32 / web 101 / webb 6 / audit 64 / contract 40 / runtime 15）；`pnpm suite` 467/467；`suite:geo` 81/81；`suite:hotel` 43/43；`test:scripts` 62/62；`acceptance:onboarding`、`scan:fences`、`scan:knowhow`、`bundle-governance`、`capabilities --check`、`product:verify`、`oss:check`、全仓 typecheck 与三端构建全绿。

### 会话 8 记（2026-09-22 02:30 · G6 部分）

- B-36 五模式执行器：`collaboration/dispatch.ts`（m1 单人 / m2 串行管线 / m3 黑板单主写者 / m4 契约三段 / m5 战役编组；人数与阶段硬约束，fail-closed）。
- B-37 契约持久化：迁移 0045 `task_contracts`（thread_id/bundle_scope/matrix_refs，RLS，app 无 DELETE）+ `collaboration/store.ts`（状态机纯函数推进 + `contract.*` 事件同事务）；PG 用例 4/4。
- B-40（部分）：accept 自动建线程；deliver 事件点名 verifier；settle 事件带结算金额；验收脚本落预算账本并验证幂等去重。
- B-41 验收脚本：`pnpm acceptance:collab` 全链通过（E-24253 起，契约 ct-accept-*）。
- B-44 静态检查：`pnpm scan:rls`（新增写路径双 GUC + 委托助手识别 + `rls-exempt:` 豁免），self-test + 全绿。
- B-67/B-68/B-83：同步声明文档；默认装载裁剪断言 3/3；事件冻结门禁（118 类对象、顶层五元冻结）。
- G6 剩余（未完成，见待办）：B-38 tRPC 侧 agent 写路径、B-39 冲突仲裁对象化、B-40 审批/结算全链、B-45 验收矩阵扩展、B-62..B-66、B-69..B-77、G7 RDAS。

### 会话 9 记（2026-09-22 09:00 · G6 增补 + G7 首轮生产实测）

- B-45：`pnpm acceptance:growth-assets`（growth_daily 真库 7 天 × 2 账号、AI 标识四字段、矩阵 123 条、通道 11 类+声明排除）全绿；B-73：`pnpm acceptance:goal-loop`（goal→契约→线程→六段事件→结算账本）全绿。
- 修复 RDAS matrix SA3_fences 8 项红点：调色四件套与 growth-metrics 未登记技能围栏绑定、BGM 三技能缺 G-BGM5/G-BGM0 → `scripts/skill-bindings.mts` 补登记并复位种子；复跑 `matrix --fail-on-error` 0 红点。
- G7 首轮生产实测（RDAS v3.1，`outputs/acceptance/REPORT.md`）：结论 **条件通过**（L/U/O=未验证，P=不通过）；红线 0；覆盖率 276 项（pass 21 / evidence-present 19 / not-run 62 / manual-missing 170 / fail 4）。
  - P 域实测：`LLM-G1 ok`；`LLM-R1/T1 blocked`（dsh 可执行文件缺失）；`LLM-M1 blocked`（playwright 未安装）；`IMG-01/IMG-02/VID-01 failed`（**Ark 账户欠费 403 AccountOverdueError**）；`PROD-01 blocked`（目标 server 9207 不可达）。未用 selftest 替身数据充当证据。
  - 下一轮解除条件：充值/更换 Ark 账户 → 安装 dsh 与 playwright → 配置 client-runtime 目标 9207 → 重跑 `node scripts/acceptance/live.mjs --env client-runtime` 与 `report-v3`。
| 计划版本 | v1.3：84 个工作包；已整合视频链路修复与基座去审批化，并重定义 B-70/B-72/B-73/B-64 |

### 会话 11 记（2026-09-24 · G6 余项 15 包 + G7 首轮 RDAS）

**G6 落地（4 个提交，全部实测）**

- `29dc200` B-38/B-39/B-40/B-62/B-71：agent 通道 tRPC 写路径（常量时间密钥 + 名册回库 + version 强制）；冲突仲裁对象化（conflict_raise/arbitrate/resolve + 升级落 L4 关卡）；契约全链（共享 settlement 模块：自治预算带 + 结算关卡幂等 + 台账同事务；两路径统一，创建即 offered）；通用围栏规则模板（internal-collaboration，按包前缀展开，基线不再手抄）；协作围栏 G-CON1/G-BB1 + `planDispatch` 跨岗契约强制。顺带修复：事件冻结门禁 schema 名失配、契约/回执/冲突对象未登记冻结清单、技能安装快照漂移（seed/registry 双路径）、evolve 夹具自愈、suite-hotel 编制口径 75→77。
- `6c91f60` B-63/B-64/B-69：首日上岗内容包随 Bundle 分发（3 套 + 通用基线）、进度服务端化（迁移 0046 `state JSONB`）、首登行动卡（待放行关卡/续播/待验收）、引导漏斗事件化 + 晨报栏位；web 在线取服务端包（离线回落本地包）+ 跨端续播 sync 适配器；新增 `acceptance:questline`（18/18）。
- `f95382a` B-65/B-66/B-70/B-72：执行器沙箱（realpath 白名单 + 工具级清单，9 例）；统计口径脚本化（README 统计区块 + 围栏包头计数 + `--check` 门禁与篡改探测）；关卡减负（批量放行/抽检 seed 可复算/H1 仪表，`approvals.batchRelease` + `loadMetrics`）；信任账户接入运行（降档自动收紧 + 升档/补考进关卡 + 晨报栏，修复 trust 查询 RLS 缺上下文）。
- `37f56b8` B-74/B-76/B-77：`drill:backup` 五条回滚路径（PG 恢复/ Bundle 回滚 / 围栏回滚 / 模型回滚 / 执行器回滚）+ 报告；**围栏放宽改为 L4 双闸门**（此前收紧后无法回滚，演练发现的真实缺口）；geo-growth 1.0.0→1.1.0 + CHANGELOG，三包切 **stable + ed25519 签名**（`--release` 验签过，公钥环 `build/bundle-trust.json`，装载期信任根缺省回落修复）；README/计划/能力产物同步。

**G7 首轮 RDAS v3.1（本机预览档 + P 域 client-runtime 档）**

- L 层结构：矩阵 77/77 岗 · 87/87 技能（10 条「装备库预留」提示）；UI 33/33 路由 · 77/77 档案页 · 93/93 技能卡；`acceptance:gates` 11/11（去审批化补偿控制）；`acceptance:questline` 18/18；`acceptance:collab` 通过。
- U 层：机检 39/39（含 axe 近似、键盘、对比度、缩放、reduced-motion）；体验走查 8/10 —— EXP-02（审批中心三手势）属声明式偏离 DEV-01、EXP-01（首价值词表/20s 阈值）属 DEV-02；EXP-03/04/05/10 在清理夹具后转绿。
- O 层：`configured=false`（未配置 outcomes 套件）→ 未验证（未写通过）。
- P 层：0 ok / 3 blocked / 5 failed —— dsh 缺失（LLM-R1/T1）、执行器宿主缺 playwright（LLM-M1）、模型网关 404（LLM-G1）、Ark 账户欠费 403（IMG-01/02、VID-01）、client-runtime 目标 9207 不可达（PROD-01）。
- `release:gate`：**11/11 通过**（ASK ×2 / QUEST ×2 / 编排 ×3 + 前置 4 项；沙箱档）。
- 结论：机器「不通过（1 红线 #2 = DEV-01）」；人工口径建议「条件通过（隔离副本 / 本机预览档）」；生产 Go/No-Go = **No-Go**（P 域未验证），内部演示/继续开发 = Go。

**本轮新增/修复的工程债**

1. `biz_events` 只增不改触发器实测生效——测试夹具必须走安全网关写事件（本轮清理了 18 条伪造事件，属一次性维护，已在提交信息留痕）。
2. 契约读模型跨路径容错：表路径旧事件字段不全不再让列表 500（`/portfolio` 页实测 red 因它）；写入方已补全量快照。
3. 验收执行器：`matrix.mts` 同名岗位取「优先 ready」（Map 后写覆盖语义）。

---

## 2. 批次状态总表

| 批次 | 名称 | 状态 | 提交 SHA | 验收结果 |
|---|---|---|---|---|
| G0 | 计划与账本 | 完成 | `4cf8205` | 文档已推送云端 |
| G1 | 契约与矩阵地基 | 完成 | `ec29c2e` | vitest 38/38；tsc（base+contract）通过；bundle governance 通过；矩阵缺口 0 |
| G2 | 触发器与指挥链 | 完成 | `4287f21` | 三包 triggers 声明合并装载；指挥链 8 条 / 组合 73 岗；suite:geo 81/81、suite:hotel 43/43；B-06c（video seed）单列待办 |
| G3 | 岗位与增长线 | 完成 | `f69e2c0` + 本批次 | B-09..B-12 / B-43 / B-46..B-50 / B-80 / B-82 全部落地；双域套件 + 全包测试 + 场景套件全绿 |
| G4 | 通道与执行器 | 完成 | 本批次 | 五图文通道 + OTA 包 + 四桥 + 多执行器路由 + 桌面 worker + 直播模板 + C 端承接 + 声明排除 + 降级出图；全量回归绿 |
| G5 | 模型、生成与数据 | 完成 | 本批次 | AI 标识/模型台账/NATS/四连接器/增长日表/投影/看门狗/成本/三态/保鲜环/幂等/偏好/夜班/审计/压测/供应链/RLS/复核；全量回归绿 |
| G6 | 协作机制与验收 | 完成 | `29dc200`+`6c91f60`+`f95382a`+`37f56b8` | B-36..B-41/B-44/B-45/B-62..B-77/B-83 全部落地；base 1176/1176 · server 410/410 · web 119/119 · test:scripts 85/85 · 双域套件 81/81 · 43/43 · 全门禁绿 |
| G7 | 真机验收与生产实测 | 首轮完成（条件） | 同上分支 | RDAS v3.1：L = 不通过（1 红线，对应声明式偏离 DEV-01）；U 机检 39/39；O 未配置（未验证）；P 未验证（环境阻塞）；`release:gate` 11/11；报告 `outputs/acceptance/REPORT.md` + `DEVIATIONS.md` |

---

## 3. 待办清单（按批次）

### G1 契约与矩阵地基

- [x] B-01 `packages/industry-contract/src/index.ts`：ProvidesSchema 增加 `triggers`/`matrix`/`platformSpecs`；CompositionSchema 增加 `commandChain`
- [x] B-01a 更新 `packages/industry-contract/src/index.test.ts` 契约用例
- [x] B-04 `packages/db/migrations/0037_trigger_declarative.sql`：triggers 表声明列与索引
- [x] B-13 `bundles/geo-growth/matrix/content-platform-matrix.yml`：123 子类矩阵数据化
- [x] B-14 `packages/base/bundles/matrix.ts`：加载/校验/缺口报告 + 单测
- [x] B-15 `bundles/geo-growth/templates/platform-specs.json`：平台规格注册表（23 条，覆盖第一批 21 个平台概念）
- [x] B-16 `packages/base/publish-rpa/specs.ts`：发布前规格硬校验 + 单测
- [x] B-01b `bundles/geo-growth/bundle.json` 声明新资产并刷新摘要
- [x] G1 验收：typecheck + test + 新增单测全绿（见第 5 节）
- [ ] G2 待办（见下节）

### G2 触发器与指挥链

- [x] B-03a `packages/base/bundles/triggers.ts`：声明解析 / cron 校验 / 跨包合并 / 编制对账 + 单测
- [x] B-02 装配器合并 triggers 并幂等写库（assembly.ts `loadComposedTriggers` + `provisionComposedWorkforce` upsert；工作区后缀 id、客户自建不覆盖、退出声明仅禁用）
- [x] B-03b 声明式触发器 upsert 写库（实现位置在装配器这一唯一装载路径；`night-shift` 引擎无需改动）
- [x] B-05 三包 `triggers.yml` 声明
  - [x] B-05a `bundles/geo-growth/triggers.yml`（14 条）已声明并随包装载
  - [x] B-05b `bundles/hotel/triggers.yml`（12 条，含 system: night-shift）与 `bundles/ai-video/triggers.yml`（7 条）已声明并随包装载
- [ ] B-06 seed 脚本去硬编码
  - [x] B-06a `scripts/seed-geo.ts` 移除硬编码触发器，改回显声明装载结果；`suite-geo` 断言改按 `declared_id` 对账（81/81 通过）
  - [x] B-06b `scripts/seed.ts` 移除硬编码触发器并退役旧 seed 触发器；`suite-hotel` 断言改为组合日历对账（43/43 通过）
  - [ ] B-06c `scripts/seed-video.ts` 去硬编码（video-studio 需先对齐装配围栏版本口径，避免与组合装配互相回滚）
- [x] B-07 指挥权归获客口径：hotel `company-ceo` 更名 `hotel-ceo`，geo-growth `company-ceo` 成为组合权威；遮蔽 4→3 处，组合编制 72→73 岗；酒店获客管线 owner 同步改名
- [x] B-08 `commandChain` 声明与校验：8 条汇报关系（growth-lead→company-ceo、五组→growth-lead、director/hotel-ceo→growth-lead/company-ceo）；两端必须在编，未命中拒绝装配；激活事件带 `commandChain` 计数；岗位退场/同名去重（只停用不删除）已实现
- [x] B-42 合并经营日历触发器
  - [x] B-42a geo-growth 14 条经营日历（情报/决策包/指标/评论/能见度/战报/回测/巡检/人效 + 4 CEO 节拍）
  - [x] B-42b 三包节拍合并与去重：按 beat（CEO 节拍）与 template（如 metrics.collect/comments.ingest）去重，主包优先并留痕；组合日历 23 条（geo 14 + hotel 8 + ai-video 1）
- [x] G2 验收：suite:geo 81/81 / suite:hotel 43/43 / 触发器断言 4/4 全绿（2026-09-22 复跑）

### G3 岗位与增长线

- [x] B-09 creator-partner 下沉主包（`bundles/geo-growth/presets/creator-partner.yml`；G-AD1/G-AD2 两条达人合规围栏随包）
- [x] B-10 四类新对象（creator_collab / growth_asset / account_growth_metric / matrix_entry；`bundles/geo-growth/schemas/objects.json`）
- [x] B-11 增长指标技能（`skills/growth-metrics/SKILL.md`；五项周表分子分母冻结 + LTV/CAC；16 技能五维评估全绿；geo 题库补 2 题）
- [x] B-12 四个岗位参数与工具调整（review-analyst / data-board-officer / live-producer / hotel ai-receptionist；工具白名单与围栏绑定过治理门禁）
- [x] B-43 hotel 与 ai-video 补考题（各 22 / 24 题 + 清单声明 + 装载门禁；技能升级接入晋升门禁：promotion_gate 开启时先过 on-change 考试）
- [x] B-46 账号矩阵编排对象与协同排期（L1–L8 分层 + 排期器 G16 防关联 + 日上限/窗口；7 用例）
- [x] B-47 授权台账下沉主包（ip-curator 权威归主包 + ip_asset + 四维范围校验 + 30/7/1 天预警 + 日巡触发器）
- [x] B-48 获客主包 segment-defaults 客群装配（4 个起步方式，引用零断链/幂等/P2 默认不出场）
- [x] B-49 只读岗位产出进晨报与闭环台账（三个只读岗补 coverage + 晨报固定第六栏，编号连续）
- [x] B-50 P2 条件岗运营指标、退场条件与编制周报（ops_metrics/exit_conditions + 周度评估 + 编制周报）
- [x] B-80 价格与权益确认单工具 + 预售券/退改合规模板（3 模板 + price_confirmation 对象 + 2 岗工具）
- [x] B-82 UGC 征集与授权流程（四线审查 + 脱敏 + 岗位四工具 + 2 道考题）

### G4 通道与执行器

- [x] B-18 五类国内通道适配器（weixin-mp/weibo 骨架 + zhihu/toutiao/baijia 占位；迁移 0041 扩 11 平台）
- [x] B-19 OTA 上传包（携程/美团/飞猪 + 房型图/相册/视频 + 审核状态回写 + fail-closed）
- [x] B-20 私域执行器（private-domain-bridge：企微 API/桌面 RPA 由桥侧承载，回执形状校验）
- [x] B-21 多执行器组合（`WORKLOOM_TOOL_EXECUTOR_MODULES` 前缀路由 + 单模块失败隔离）
- [x] B-22 发布/信源/OTA 执行器适配器（publish/source/ota 三桥 + bridge-client）
- [x] B-23 桌面浏览器驱动（Playwright 驱动 + publish-worker + Toolkit 映射；登录态本机 profile）
- [x] B-24 环境变量与 doctor/connectors-check（执行器路由/OTA/桥/事件总线四段自检）
- [x] B-25 发布重试与日上限参数化（统一重试 3 次 + `dailyLimitFor(platform)`）
- [x] B-51 直播通用模板与切片管线下沉（脚本/战报模板 + live-clip-reuse 管线 + 触发器）
- [x] B-52 C 端前台承接化四组件（/c/actions 四动作 + 来源链/脱敏/幂等回执 + webc 快速承接）
- [x] B-75 海外与视频号通道联调（真机未就绪 → 声明排除 + readiness 矩阵 + 解除条件）
- [x] B-81 内容生产降级路径（HTML/CSS 降级出图 + 「降级产出」标注 + 人工发布挂起）

### G5 模型、生成与数据

- [x] B-26 真实文本模型池配置（`scripts/tools/model-pool-check.mts`；mock 9/9，真实模式按 vendor 装配并报告缺位）
- [x] B-27 生图/生视频配置（`scripts/tools/gen-config-check.mts`；缺项 fail-closed 明确输出）
- [x] B-28 资产 AI 标识字段与迁移（0042：ai_generated/ai_label/generator_model/label_manifest_uri + 注册校验）
- [x] B-29 显式与隐式标识产出（ai-label 清单 + `ffmpegLabelArgs` + `pngTextChunkSpec`）
- [x] B-30 模型版本台账（diff/回滚命令/台账服务 + `scripts/model-ledger.mts`）
- [x] B-31 NATS 事件总线（docker-compose nats JetStream + EVENT_BUS/NATS_URL 配置；工厂已有三实现）
- [x] B-32 四类真实连接器（PMS/OTA 监测/企微客资/抖音本地生活；fail-closed + fake fetch 用例）
- [x] B-33 增长日表（0043 表 + growth_daily 视图 + seed + 查询脚本 + PG 用例）
- [x] B-34 投影扩展（C 端投影带矩阵条目/结构缺口、增长五项与 factTable、AI 标识 schema；`projections:check` 通过）
- [x] B-35 看门狗（触发器漏触发/连接器陈旧/审批 SLA + `scripts/tools/watchdog.mts` + 事件留痕）
- [x] B-53 视频全成本账本（`videoCostBreakdown`：渲染/达人/授权/人工/工具/冲销 + 每分钟成本）
- [x] B-54 真实采集调度接线（连接器取数 → account_metrics → 阈值；未配置 fail-closed）
- [x] B-55 三态标识统一（`delivery-mode.ts`：显式三态/缺失断言/统一角标）
- [x] B-56 技能保鲜环配置（registry/签名密钥/窗口/策略校验）
- [x] B-57 工具调用契约（超时/重试/稳定幂等键；失败 connector-required）
- [x] B-58 增长线偏好注入（增长关键词过滤 + 引用块 + 引用留痕）
- [x] B-59 夜班候选扩展（矩阵缺口/待跑实验/素材缺口三类候选）
- [x] B-60 场景覆盖审计（26 场景并集 × 3 包 = 78 行，52 条声明；缺口报告落 docs/reports/scenario-coverage.md）
- [x] B-61 事件链与模型链压测（p50/p95 + 吞吐；报告落 docs/reports/loadtest.md）
- [x] B-78 依赖与供应链门禁（oss-inventory 刷新；`test:oss` + `oss:check` 全绿）
- [x] B-79 新增表与对象 RLS 用例（account_growth_daily/growth_daily；**修复视图 security_invoker 绕过 RLS**（0044））
- [x] B-84 外部事实季度复核（`specsDueForReview` + `scripts/tools/external-facts-review.mts` + 报告）

### G6 协作机制与验收

- [x] B-36 五模式执行器（`collaboration/dispatch.ts`：编排/人数约束/黑板单主写者；6 用例）
- [x] B-37 契约线程字段与迁移（0045 `task_contracts`：thread_id/bundle_scope/matrix_refs + RLS + 只增不改；4 项 PG 用例）
- [x] B-38 agent actor 与写路径（契约 store 支持 actor type=agent/system；tRPC 侧接线待后续）
- [x] B-39 冲突仲裁对象化
- [x] B-40 契约↔线程↔审批↔结算（accept 自动建线程、deliver 点名 verifier、settle 落预算账本幂等；审批联动待后续）
- [x] B-41 协作闭环验收脚本（`pnpm acceptance:collab` 全链通过：offer→settle + 账本）
- [x] B-44 RLS/GUC 静态检查（`pnpm scan:rls`：新增写路径双 GUC 门禁 + self-test）
- [x] B-45 验收矩阵扩展（`pnpm acceptance:growth-assets` 四类新资产全绿；修复 8 项 SA3_fences 绑定缺口后 matrix 0 红点）
- [x] B-62 「内部协作 auto / 对外动作 review」通用规则模板（覆盖 REF-P-06）
- [x] B-63 首日五关服务端化 + 内容包进 bundle（覆盖 REF-P-09 / UX-01）
- [x] B-64 首登行动卡（覆盖 UX-04）
- [x] B-65 执行器沙箱与动态加载权限治理（覆盖 TECH-15）
- [x] B-66 统计口径脚本化（覆盖 DROP-P-05）
- [x] B-67 sync/ 基座同步机制：书面声明不参与（`docs/BASE-SYNC-DECLARATION.md`，覆盖 TECH-03/DEC-17）
- [x] B-68 默认装载裁剪（P2 岗/商单分账触发器/电影级技能默认不出场；`default-trimming.test.ts` 3 用例）
- [x] B-69 引导漏斗埋点接入真实渠道（覆盖 UX-02）
- [x] B-70 人审减负机制（决策包聚合/批量手势/低风险抽检/H1 仪表）
- [x] B-71 契约强制规则 G-COL1 + 黑板单主写者围栏
- [x] B-72 信任账户接入运行（升降档进决策包、降档自动收紧、补考）
- [x] B-73 目标→执行闭环端到端验收（goal→五环→thread→contract→receipt→report；`pnpm acceptance:goal-loop` 全绿）
- [x] B-74 备份与回滚演练（PG/bundle/围栏/模型/执行器）
- [x] B-76 Bundle 版本与发布治理（geo-growth 1.1.0 + CHANGELOG + 签名规划）
- [x] B-77 文档与演示资产同步（README/capabilities/官网/演示页）
- [x] B-83 事件 schema 冻结与对象枚举扩展门禁（`pnpm scan:event-freeze`：118 类对象冻结 + 顶层五元冻结；2 用例）

### G7 真机验收

- [x] RDAS v3.1 L0–L16 / U / O / P 全量（首轮：L/U 本机预览档已跑，P 域环境阻塞未验证）
- [x] ADR/HIR 报告与 AVR 判定（autonomy-report：交付件 1；ADR-1=100%（CI 20.6–100%，n=1，小样本不显著）；AVR 五条判据未满足）
- [x] Go/No-Go 与回滚演练（回滚演练 5/5 通过；Go/No-Go：生产 No-Go（P 域未验证）/ 内部演示 Go）
- [x] 验收报告四段（覆盖率声明/证据分级/收尾报告/自检表）（`outputs/acceptance/REPORT.md` + `DEVIATIONS.md`）

---

## 4. 提交记录

| 序号 | 提交 SHA | 摘要 | 批次 | 验证 |
|---|---|---|---|---|
| 1 | `4cf8205` | docs(growth): 开发计划与进度账本（跨会话接力） [T-2026-0921-0003] | G0 | 文档已推送 |
| 2 | `ec29c2e` | feat(growth): G1 契约槽位/矩阵/平台规格/发布预检 [T-2026-0921-0003] | G1 | vitest 38/38 + tsc + governance + gap 0 |
| 3 | `24a4dcb` | docs(growth): 账本更新 G1 完成并交接 G2 [T-2026-0921-0003] | G1 | 账本已推送 main |
| 4 | 待回填 | feat(growth): G2 触发器声明层与装配回归 [T-2026-0921-0003] | G2 | 见第 5 节 |
| 5 | `c56d0b2` | fix(growth): 同步 growth 视频链路修复批次（T-2026-0921-0041 整合版） | 外部批次 | 保留 G1 bundle 声明 + 重算摘要 + gap 0 |
| 6 | `01c71fe` | feat(growth): 基座去审批化（T-2026-0921-0050 整合版） | 外部批次 | web 类型检查 + 三文件样例测试通过 |
| 7 | 本次提交 | feat(growth): G2 声明式触发器装配（geo-growth 14 条）与套件回归 | G2 | 迁移 0038 + suite:geo 81/81 + suite:hotel 43/43 + bundles 16/16 |
| 8 | 本次提交 | feat(growth): G2 三包触发器声明与经营日历去重 | G2 | DB 17/17 + suite:geo 81/81 + suite:hotel 43/43 + governance 通过 |
| 9 | 本次提交 | feat(growth): G2 指挥权归位与汇报关系（73 岗） | G2 | acquisition-loop 11/11 + suite:geo 81/81 + suite:hotel 43/43 + acceptance:onboarding 通过 |

---

## 5. 测试与验收记录

| 日期 | 命令 | 结果 | 备注 |
|---|---|---|---|
| 2026-09-21 | `pnpm install --registry=https://registry.npmmirror.com` | 完成 | pnpm 11 提示 `ERR_PNPM_IGNORED_BUILDS`；后续改用 `node_modules/.bin/*` 直跑工具 |
| 2026-09-21 | `vitest run`（industry-contract + bundles/matrix + publish-rpa） | 38/38 通过 | 契约 21 + 矩阵 4 + 规格 6 + 适配器 7 |
| 2026-09-21 | `tsc -p packages/industry-contract/tsconfig.build.json --noEmit` | 通过 | — |
| 2026-09-21 | `tsc -p packages/base/tsconfig.json --noEmit` | 通过 | — |
| 2026-09-21 | `tsx scripts/bundle-governance.mts --refresh-digests` | 通过 | 三包摘要已刷新 |
| 2026-09-21 | `tsx scripts/tools/matrix-gap.mts` | 缺口 0（exit 0） | 报告落 `docs/reports/matrix-gap-latest.md` |
| 2026-09-21 | 挂载 Postgres 17 DMG 并初始化本地 PG（127.0.0.1:5432 / workloom） | 成功 | 见第 7 节环境说明 |
| 2026-09-21 | `tsx --env-file=.env scripts/migrate.ts` | 39 个迁移全部应用（含 0037） | — |
| 2026-09-21 | `tsx --env-file=.env scripts/seed.ts` | 种子完成（ws-yunqi 演示工作区） | — |
| 2026-09-21 | `RUN_DB_TESTS=1 vitest run packages/base/bundles/bundles.test.ts` | 11/11 通过 | 组合装配 72 岗 + 遮蔽 + 摘要门禁 |
| 2026-09-21 | `tsx --env-file=.env scripts/acceptance/onboarding.mts` | 通过（72/72 岗、71 条围栏、影子→试用、账本只增） | — |
| 2026-09-21 | `vitest run packages/base/bundles/triggers.test.ts` | 4/4 通过 | 声明层纯函数 |
| 2026-09-22 | `pnpm suite:geo` | 81/81 通过 | A-02/C-15 断言口径修复（`49ae735`）；C-16/C-17 复跑 pnpm 11 全绿 |
| 2026-09-22 | `pnpm suite:hotel` | 43/43 通过 | 先 `pnpm db:seed` 归位组合装配，消除历史库态假失败 |
| 2026-09-22 | `RUN_DB_TESTS=1 vitest run packages/base/bundles/bundles.test.ts` | 11/11 通过 | 组合 73 岗 + 遮蔽 + 摘要门禁 |
| 2026-09-22 | `vitest run packages/base/bundles/triggers-assembly.test.ts` | 4/4 通过 | 声明式触发器装配 |
| 2026-09-22 | `pnpm acceptance:onboarding` | 通过 | 影子→试用→账本只增 |
| 2026-09-22 | `tsx scripts/tools/matrix-gap.mts` | 缺口 0 | 73 岗 / 74 围栏 / 87 平台引用 / 123 条目 |
| 2026-09-22 | `tsc -p packages/base/tsconfig.json --noEmit` + contract build | 通过 | — |
| 2026-09-22 | `pnpm test`（全包） | 通过 | base 920 / server 354 / web 101 / webb 6 / webc 21 / video-studio 22 / audit 64 / contract 40 / runtime 15 |
| 2026-09-22 | `pnpm suite` | 467/467 通过 | HTTP E2E 51/51 |
| 2026-09-22 | `pnpm test:scripts` | 57/57 通过 | 含调色 core/executor/luts（B-43 后） |
| 2026-09-22 | `vitest run eval-questions + skill-ops + bundles + acquisition-loop` | 60/60 通过 | 含 B-43 题库装载门禁与晋升门禁用例 |
| 2026-09-22 | `pnpm scan:knowhow` | 16/16 通过 | growth-metrics 五维齐全且评测覆盖 |
| 2026-09-22 | `node scripts/generate-capabilities.mjs --check` | 同步 ✓ | B-11 技能数刷新 |
| 2026-09-22 | `pnpm test`（G3 收尾批次） | 通过 | base 967 / server 354 / web 101 / webb 6 / webc 21 / video-studio 22 / audit 64 / contract 40 / runtime 15 |
| 2026-09-22 | 新增模块用例（account-matrix/ip-ledger/geo-segments/p2-ops/price-confirmation/ugc-flow/briefing-readonly/staffing-weekly/eval-questions/skill-ops） | 85/85 通过 | 含 G16 防关联、授权到期、P2 退场、UGC 四线 |
| 2026-09-22 | `pnpm suite:geo` / `pnpm suite:hotel` | 81/81 · 43/43 通过 | 对象模型 65 类（geo）/29 类（hotel）；组合 74 岗 / 5 处遮蔽 |
| 2026-09-22 | G4 全量：`pnpm test` / `pnpm suite` / `test:scripts` | 全绿 | base 996 · server 367 · webc 24 · suite 467/467 · scripts 62/62 |
| 2026-09-22 | `node --test apps/desktop/electron/publish-driver.test.cjs` | 4/4 通过 | Playwright 缺失明确报错 + Toolkit 映射/上传显式检查 |
| 2026-09-22 | `tsx scripts/channel-readiness.mts` | 通过（2 项声明排除） | TikTok/视频号未就绪豁免单见 docs/channel-exclusions.md |
| 2026-09-22 | G5：`pnpm test` / `pnpm suite` | 全绿 | base 1038 · server 367 · video-studio 32 · webc 24 · suite 467/467 |
| 2026-09-22 | `vitest run rls-new-tables.pg.test.ts` | 2/2 通过 | 发现并修复 growth_daily 视图 RLS 绕过（0044 security_invoker） |
| 2026-09-22 | `tsx scripts/tools/{scenario-coverage,external-facts-review,loadtest,model-pool-check,gen-config-check,watchdog}.mts` | 全部可跑 | 报告落 docs/reports/；model 9/9（mock） |
| 2026-09-21 | 整合外部批次后的门禁链 | 全部通过 | `bundle-governance --refresh-digests`、`matrix-gap`（0 缺口，72 围栏）、`tsc`（base/contract/web）、`bundles.test.ts` 11/11（DB）、`acceptance:onboarding` 通过 |
| 2026-09-21 | `cd apps/web && ../../node_modules/.bin/vitest run src/lib/display.test.ts` | 11/11 通过 | web 测试必须在 apps/web 目录用其自身 vitest 配置跑（根配置会因 @workloom/ui 子路径解析误报） |
| 2026-09-21 | `tsx --env-file=.env scripts/migrate.ts` | 0038_trigger_declared_id.sql 已应用 | triggers 新增 declared_id + 唯一索引 |
| 2026-09-21 | `vitest run packages/base/bundles/triggers-assembly.test.ts`（DB） | 1/1 通过 | 14 条幂等装载 / 客户自建不覆盖 / 退出仅禁用 |
| 2026-09-21 | `tsx --env-file=.env scripts/seed-geo.ts` | 通过（声明式触发器 ×14） | seed 不再硬编码触发器 |
| 2026-09-21 | `tsx --env-file=.env scripts/suite-geo.ts` | 81/81 通过 | 含 28 条围栏口径修正与声明触发器对账 |
| 2026-09-21 | `tsx --env-file=.env scripts/suite-hotel.ts`（先重跑 seed.ts 复位夹具） | 43/43 通过 | 见 L-10 夹具污染说明 |
| 2026-09-21 | `vitest run triggers-assembly + triggers + bundles`（DB） | 17/17 通过 | 组合日历幂等 / 客户自建不覆盖 / 退出仅禁用 |
| 2026-09-21 | `suite-geo` / `suite-hotel`（三包声明后） | 81/81、43/43 通过 | 日历条数按装配结果动态对账（23 条） |
| 2026-09-21 | B-07/B-08 后全量回归 | suite:geo 81/81、suite:hotel 43/43、acquisition-loop 11/11、bundles 11/11、triggers-assembly 1/1、acceptance:onboarding 通过 | 组合编制 73 岗、遮蔽 3 处、汇报关系 8 条 |

---

## 6. 阻塞与风险

| 编号 | 描述 | 影响 | 处置 | 状态 |
|---|---|---|---|---|
| L-01 | 本机默认 PATH 无 Node，需要显式加入 Codex 运行时路径 | 命令不可执行 | 计划文档第 4 节已固化 PATH 写法 | 已缓解 |
| L-02 | CNB 推送凭据由会话提供，仅可临时使用 | 安全 | 不写入任何文件；推送后建议轮换 | 已缓解 |
| L-03 | `sync/` 目录缺失 | 跨仓同步 | 依 DEC-17 决策处理 | 待决策 |
| L-04 | pnpm 11 因 `allowBuilds` 占位值触发依赖检查失败 | 脚本不可用 | `pnpm approve-builds --all` 归一为布尔值并提交 `f3e4fb6`；pnpm 11 可直接运行脚本，pnpm 10 仍读 `onlyBuiltDependencies` | 已解决 |
| L-05 | 矩阵平台引用 87 个名称（含分组与别名），注册表 23 条平台规格 | 口径易混 | 分组别名表已覆盖；缺口脚本作为唯一对账口径 | 已缓解 |
| L-06 | `PII_SALT` 未配置（工具运行告警） | 生产脱敏 | 生产部署必须注入；开发态允许占位盐 | 待部署 |
| L-07 | 本机无 Docker/Homebrew，DB 依赖 Postgres.app DMG 挂载 | 会话重启需重新挂载 | 第 7 节已固化启动命令；DMG 缓存于 `/tmp/Postgres-2.9.6-17.dmg`（sha256 与 release-assets 一致） | 已缓解 |
| L-08 | 外部批次可能携带过期 bundle.json（本次视频批次会删除 G1 的 matrix/platformSpecs 声明） | 静默丢失资产声明 | 合并后强制顺序：`bundle-governance --refresh-digests` → `matrix-gap` → DB `bundles.test` → `acceptance:onboarding`；已在计划 §9.3 固化 | 已缓解 |
| L-09 | 产品所有者决策「基座去审批化」（T-2026-0921-0050） | 与 B-70/B-72/B-73/B-64 原口径冲突 | 已重定义为「业务关卡放行」口径；后端 approvals/围栏/业务门保留 | 已对齐 |
| L-10 | 测试夹具污染：acceptance/bundles 测试会以组合装配重写 ws-yunqi 的围栏版本，导致 suite-hotel C-03 期望 `hotel-baseline/v4` 为 0 | 套件假失败 | 跑 suite-hotel 前先 `tsx --env-file=.env scripts/seed.ts` 复位夹具 | 已缓解 |
| L-11 | pnpm 11 的 `verify-deps-before-run` 会拦截所有脚本 | 套件内 `pnpm db:seed:*` / `pnpm db:verify-chain` 失败 | 本机已建 shim `/tmp/wl-bin/pnpm`（注入 `--config.verify-deps-before-run=false`）；跑套件时把 /tmp/wl-bin 放 PATH 首位 | 已缓解 |

---

## 7. 本机开发环境（会话已就绪，重启按此恢复）

```bash
# ① Node（Codex 运行时）
export PATH="/Users/mac/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$PATH"

# ② PostgreSQL 17 + pgvector（Postgres.app DMG，本地 /tmp 数据目录）
PGBIN=/Volumes/Postgres-2.9.6-17/Postgres.app/Contents/Versions/17/bin
export DYLD_LIBRARY_PATH=/Volumes/Postgres-2.9.6-17/Postgres.app/Contents/Frameworks
[ -d /tmp/workloom-pgdata ] || "$PGBIN/initdb" -D /tmp/workloom-pgdata -U postgres --auth=trust -E UTF8 --locale=C
"$PGBIN/pg_ctl" -D /tmp/workloom-pgdata -l /tmp/workloom-pg.log -o "-p 5432 -k /tmp -c listen_addresses=127.0.0.1" start
"$PGBIN/createdb" -h 127.0.0.1 -p 5432 -U postgres workloom 2>/dev/null || true
"$PGBIN/psql" -h 127.0.0.1 -p 5432 -U postgres -d workloom -c "CREATE EXTENSION IF NOT EXISTS vector"
[ -f /tmp/Postgres-2.9.6-17.dmg ] || curl -x http://127.0.0.1:7890 -L -o /tmp/Postgres-2.9.6-17.dmg \
  https://github.com/PostgresApp/PostgresApp/releases/download/v2.9.6/Postgres-2.9.6-17.dmg
hdiutil attach -nobrowse -readonly /tmp/Postgres-2.9.6-17.dmg   # 未挂载时执行

# ③ 依赖与数据库（依赖已装；仅在缺失时重跑）
cd <repo>
[ -d node_modules ] || pnpm install --registry=https://registry.npmmirror.com
./node_modules/.bin/tsx --env-file=.env scripts/migrate.ts
./node_modules/.bin/tsx --env-file=.env scripts/seed.ts        # 需要 ws-yunqi 夹具时
./node_modules/.bin/tsx --env-file=.env scripts/seed-geo.ts    # 需要 ws-geo 获客演示时

# ④ 测试环境变量（vitest 直跑，避免 pnpm 的 ignored-builds 安装检查）
export RUN_DB_TESTS=1
export DATABASE_URL='postgres://postgres:workloom@localhost:5432/workloom'
export DATABASE_APP_URL='postgres://workloom_app:workloom_dev_app@localhost:5432/workloom'
export DATABASE_GATEWAY_URL='postgres://workloom_gateway:workloom_dev_gateway@localhost:5432/workloom'

# ⑤ pnpm 脚本 shim（套件内部会 spawn pnpm；pnpm 11 需绕过 deps status 检查）
mkdir -p /tmp/wl-bin && printf '%s\n' '#!/bin/sh' \
  'exec /Users/mac/.cache/codex-runtimes/codex-primary-runtime/dependencies/bin/fallback/pnpm --config.verify-deps-before-run=false "$@"' \
  > /tmp/wl-bin/pnpm && chmod +x /tmp/wl-bin/pnpm
export PATH="/tmp/wl-bin:$PATH"
```

停止数据库：`"$PGBIN/pg_ctl" -D /tmp/workloom-pgdata stop`；卸载 DMG：`hdiutil detach /Volumes/Postgres-2.9.6-17`。

---

## 8. 接力入口（新会话按此恢复）

1. 读本文件第 1、2、3、7、8 节。
2. `git fetch origin && git checkout task/T-2026-0921-0003 && git pull --rebase`。
3. 核对「云端最新提交」与本地 HEAD；不一致以云端为准并更新本文件。
4. 从「当前批次」的第一个未勾选项继续；每完成一项更新本文件并提交。
5. 会话结束前更新第 1、2、3、4、5、6 节并推送。

---

## 9. 变更记录

| 日期 | 变更 |
|---|---|
| 2026-09-21 | 建账：G0–G7 状态表、G1–G7 待办、提交与测试记录模板、接力入口 |
| 2026-09-21 | G1 完成：契约三槽位、触发器声明迁移、123 条矩阵、平台规格注册表、发布预检、缺口脚本；提交 `ec29c2e` 并推送 |
| 2026-09-21 | 本地 PG 17 + pgvector 就绪；39 迁移 + 种子；bundles 11/11 与 acceptance:onboarding 通过；G2 声明层纯函数（triggers.ts + 4 单测）落地 |
| 2026-09-21 | 计划 v1.1：对账四批方案，补齐 B-46 至 B-68 共 23 项（账号矩阵、授权台账、主包客群、只读产出、P2 岗指标、直播模板、C 端承接、视频成本、采集调度、三态标识、保鲜环、工具幂等、增长偏好、夜班候选、场景审计、压测、协作模板、五关服务端化、首登行动卡、执行器沙箱、统计脚本化、sync、装载裁剪） |
| 2026-09-21 | 计划 v1.2 二轮对账：新增 B-69 至 B-84 共 16 项（引导埋点、人审减负、契约强制、信任账户运行、目标闭环验收、备份回滚、海外通道、Bundle 版本治理、文档同步、供应链门禁、RLS 用例、价格确认单、降级路径、UGC 授权、schema 冻结门禁、外部事实复核），工作包总数 84；补充 DoR/DoD 与 8 个高风险包细则 |
| 2026-09-21 | G2 完成：声明式触发器装配（geo 14 / hotel 12 / ai-video 7，组合日历 23 条）+ 指挥权归位（hotel-ceo，组合 73 岗）；`4287f21` 起 main 为绿色点 |
| 2026-09-21 | G3 首批：B-09 达人岗下沉主包 + B-10 四类新对象 + G-AD1/G-AD2 围栏（`1a9ab29`）；装配探针与名册权威实例修正（`2025d7f`） |
| 2026-09-22 | 会话 3：修复 suite:geo 三项回归（preset 唯一性断言、7 天时序窗口、pnpm 11 allowBuilds 占位值），双域套件与 DB 集成全绿；提交 `f3e4fb6`/`49ae735` |
| 2026-09-21 | 会话 2：拉取并整合 T-2026-0921-0041（视频链路修复）与 T-2026-0921-0050（基座去审批化）；修复 bundle.json 合并回归；计划升级 v1.3 并重定义 4 个工作包口径；全量回归通过 |
| 2026-09-21 | 会话 2 续：B-02/B-03b 落地（装配器声明式触发器装载：0038 迁移、幂等 upsert、客户主权与退出禁用）；geo-growth 14 条声明上线；seed-geo 去硬编码；suite:geo 81/81、suite:hotel 43/43、DB 集成 16/16 全绿 |
| 2026-09-21 | 会话 2 续 2：B-05b/B-06b/B-42b 落地（hotel 12 条 + ai-video 7 条声明；system 动作白名单；按 beat/template 去重的组合经营日历 23 条；seed.ts 去硬编码并退役旧触发器）；双域套件与 DB 集成全绿 |
| 2026-09-21 | 会话 2 续 3：B-07/B-08 落地（指挥权归获客口径，hotel-ceo 独立在编；commandChain 8 条并校验；岗位退场与同名去重只停用不删除）；文档与套件口径同步 73 岗；全量回归通过 |
| 2026-09-21 | 会话 2 续 4：B-09/B-10 实现（creator-partner 下沉主包并成为组合权威，遮蔽 4 处、组合仍 73 岗；新增 creator_collab/growth_asset/account_growth_metric/matrix_entry 四类对象；G-AD1/G-AD2 达人合规围栏）；suite-geo 口径已改（28 preset / 30 围栏）；遗留 `bundles.test` H-15 工具探针失败，未并入 main |
| 2026-09-22 | 会话 3 收尾：PR #7 全门禁绿并合入 main（`119fb98`）；调色批次 T-0042/T-0043 rebase 后依次合入（`2c66df9`/`a8d5450`），main = 74 岗 / 72 技能 / 79 条组合围栏 |
| 2026-09-22 | 会话 4：B-11 增长指标技能、B-12 四岗增长工具与围栏、B-43 hotel/ai-video 题库与技能升级晋升门禁落地；全包测试与双域套件全绿 |
| 2026-09-22 | 会话 5：B-46 账号矩阵 + B-47 授权台账（ip-curator 下沉） + B-48 获客起步方式 + B-49 只读发现进晨报 + B-50 P2 岗指标/编制周报 + B-80 价格确认单 + B-82 UGC 授权流程；G3 全部工作包完成 |
| 2026-09-22 | 会话 6：G4 全部工作包完成（五图文通道/OTA 包/四类执行器桥/多执行器路由/桌面 Playwright worker/直播模板/C 端承接四件套/通道声明排除/降级出图）；迁移 0041 已应用并验链 |
| 2026-09-22 | 会话 7：G5 全部工作包完成（AI 标识 0042/模型台账/NATS/四连接器/增长日表 0043+0044/投影/看门狗/成本/三态/保鲜环/工具契约/偏好/夜班/场景审计/压测/供应链/RLS/外部事实复核） |

| 2026-09-24 | 会话 12：**RDAS 第二轮**（PR #47 → main `acdc037`）。P 域生产实测首次全绿 8/8（LLM×4 / Seedream 图×3 / Seedance 12s / 产品派单；配额 3 图 · 1 段 · ¥15.514）；O 域 outcome 4/4（pass@1=1 · 假成功 0）、redteam 7 例 0 发现、autonomy ADR-1 98.8%（CI 93.3–99.8，N=81）/HIR 4.9%/HIR-NI 1.2%/回执覆盖 80.2%；L/U：matrix 79/79 · 91/91、ui 79/79 档案页 · 97/97 技能卡 · 33/33 路由、experience 9/10（唯一失败=DEV-01）、ux 39/39。修复 9 项真机缺陷（judgeViews 执行真相视图 fail-closed、H2/批量放行不续跑、关卡卡不可见、Seedream 5.0 pro 组图参数、backup-drill 端口硬编码、autonomy 回执口径、redteam 假通过/假告警、交付包技能围栏绑定、release-gate QUEST 等待上限）。合并期间 main 两次推进（摄影师/交付包批次）→ 变基后重装工作区、重跑全部证据并同步 79 岗/91 技能/128 围栏口径；squash 合并后在 main 复跑 capabilities/bundle-governance/test:scripts/typecheck/pnpm test 全绿。 |
| 2026-09-24 | 会话 12 追加：**去审批化补偿控制**复跑 `acceptance:gates 11/11`；真机验证任务页关卡卡三杆（推进/校准/制动）可见可点；`drill:backup 5/5`（PG 逻辑备份恢复 0.48s / 7 表行数一致 / 事件链抽样 200）；`db:verify-chain` 8 段 1120+ 事件全绿。残留与未决风险（drill 工作区行、1 条夹具待放行关卡、QUEST 谷时档位耗时）已写入 `outputs/acceptance/DEVIATIONS.md` §5/§8。 |
