# GrowthMatrix 系统调整开发计划（v1.0）

> 制定日期：2026-09-21（Asia/Shanghai）
> 事实基线：`workloom-ai/workloom-Growthmatrix`，基线提交 `a4b2b20`
> 方案依据：《第一批 业务底盘与社媒作战矩阵》《第二批 产品架构与系统盘点》《第三批 技术架构与内部自动化协作机制》《第四批 AI 自主经营闭环与开工施工图》
> 本计划同时维护一份进度账本：`docs/GROWTHMATRIX-DEV-LEDGER.md`（跨会话接力的唯一状态源）

---

## 1. 目标与范围

**总目标**：把四批方案落成可运行的系统调整——两个主场景（图片/图文、视频）日更自动化；获客与增长双线闭环；数字员工与自动化工作流在无人值守下继续运转；关键动作可度量、可审计、可回滚。

**范围**：第四批施工图的 45 个改造点（B-01 至 B-45）+ 对前三批交付物的覆盖补齐 39 项（B-46 至 B-84），合计 84 项；12 项 Agent 参数调整、10 项技术组件替换；显式排除项见第 8 节「声明式排除」。

**硬约束**：

1. 实验车道纪律：本仓语义不下发、不覆盖、不回流；公共化先提提案任务卡（L2→L1→L0）。
2. 开发协议：一任务一分支一 PR；任务号进提交信息；先声明后落笔；合并在机器且串行；无回执不算完成。
3. 十二不变量的前六条优先：租户隔离、只增不改、先围栏后动作、高风险人审、无回执不算完成、客户原始数据不上行。
4. 秘密不进仓库、日志与事件；平台登录态与凭据只存本机或受控秘密存储。
5. 演示与真实严格区分：mock 数据标 `mode=mock`，模拟回执不得宣称完成。

---

## 2. 批次划分（G0–G7）

每个批次独立可验收、独立提交、独立推送；批次内出现阻塞即记账并停在本批次，不跨批合并。

| 批次 | 名称 | 覆盖施工点 | 交付物 | 验收命令 |
|---|---|---|---|---|
| G0 | 计划与账本 | 本计划 + 账本 | 两份文档落盘并推送云端 | `git log` 可见、云端分支可见 |
| G1 | 契约与矩阵地基 | B-01、B-04、B-13、B-14、B-15、B-16 | 契约三槽位；触发器声明列迁移；矩阵数据与加载器；平台规格注册表与发布预检 | `pnpm typecheck`、`pnpm test`、新增矩阵/规格单测 |
| G2 | 触发器与指挥链 | B-02、B-03、B-05、B-06、B-07、B-08、B-42 | 触发器随包声明与合并装载；三包节拍并入经营日历；指挥权归获客口径 | `pnpm suite:geo`、`pnpm suite:hotel`、触发器断言 |
| G3 | 岗位与增长线 | B-09、B-10、B-11、B-12、B-43、B-46 至 B-50 | creator-partner 下沉主包；四类新对象；增长指标技能；考试覆盖；账号矩阵编排；授权台账；主包客群装配；只读产出进战报；P2 岗运营指标 | `pnpm suite:geo`、对象/围栏契约校验 |
| G4 | 通道与执行器 | B-18 至 B-25、B-51、B-52 | 五类国内通道适配器；OTA 上传包；私域执行器；多执行器组合；桌面浏览器驱动；直播模板与切片下沉；C 端承接化 | `pnpm acceptance:channels`（新增）、发布预检单测 |
| G5 | 模型、生成与数据 | B-26 至 B-35、B-53 至 B-61 | 真实模型池；生图生视频；AI 标识；NATS；四类连接器；增长日表；看门狗；视频成本账本；采集调度；三态标识；保鲜环配置；工具幂等；增长偏好；夜班候选；场景审计；压测 | `pnpm connectors:check`、`node scripts/acceptance/live.mjs` |
| G6 | 协作机制与验收 | B-36 至 B-41、B-44、B-45、B-62 至 B-68 | 五模式执行器；契约↔线程↔审批↔结算；RLS 静态检查；验收矩阵；协作规则模板；首日五关服务端化；首登行动卡；执行器沙箱；统计口径脚本化；sync 同步；默认装载裁剪 | `pnpm acceptance:collab`（新增）、`pnpm acceptance:matrix` |
| G7 | 真机验收与生产实测 | 路线 P5 | RDAS v3.1 全量 + P 域配额 + Go/No-Go 报告 | `pnpm release:gate` + RDAS 报告四段齐全 |

---

## 3. 每批执行流程（固定动作）

1. **读账本**：先读 `docs/GROWTHMATRIX-DEV-LEDGER.md` 的「接力入口」与「当前状态」。
2. **建任务卡**：按协议建 CNB Issue（标题 `[T-2026-09-21-XXXX] 目标`）或沿用主任务号 `T-2026-0921-0003` 的子批次。
3. **分支**：主线分支 `task/T-2026-0921-0003`；跨批不新建分支，批次内单独提交。
4. **实现**：按施工点逐项落地；每个改动同步更新类型、测试、bundle 摘要与文档索引。
5. **自测**：先跑最接近改动面的验证，再按风险扩大范围（类型检查 → 单测 → 域套件 → 验收脚本）。
6. **记账**：在账本写入本批提交 SHA、测试结果、未完成项与下一步；账本随提交一起入库。
7. **提交与推送**：提交信息格式 `<type>(growth): <摘要> [T-2026-0921-0003]`；`git push origin HEAD`。
8. **云端固化**：推送后校验云端 SHA 一致；如可建 PR 则建 PR，等待门禁；门禁全绿且无冲突时按协议串行合并。

---

## 4. 验收命令清单（跨批复用）

环境前置（本机已固化，见账本第 7 节）：Node 走 Codex 运行时路径；PostgreSQL 17 + pgvector 以 Postgres.app DMG 挂载启动；`pnpm <script>` 因 pnpm 11 的 ignored-builds 安装检查会失败，统一改用 `node_modules/.bin/*` 直跑。

```bash
# 静态与单测
./node_modules/.bin/tsc -p packages/base/tsconfig.json --noEmit
./node_modules/.bin/tsc -p packages/industry-contract/tsconfig.build.json --noEmit
./node_modules/.bin/vitest run <目标测试文件或目录>
./node_modules/.bin/tsx scripts/tools/matrix-gap.mts            # 矩阵覆盖缺口（0 = 通过）
./node_modules/.bin/tsx scripts/bundle-governance.mts --refresh-digests
./node_modules/.bin/tsx scripts/bundle-governance.mts           # 完整性/契约门禁

# 数据库链路（需 PG 就绪 + RUN_DB_TESTS=1）
./node_modules/.bin/tsx --env-file=.env scripts/migrate.ts
./node_modules/.bin/tsx --env-file=.env scripts/seed.ts
./node_modules/.bin/tsx --env-file=.env scripts/seed-geo.ts
./node_modules/.bin/tsx --env-file=.env scripts/verify-chain.ts          # 事件哈希链
./node_modules/.bin/vitest run packages/base/bundles/bundles.test.ts     # DB 集成
./node_modules/.bin/tsx --env-file=.env scripts/acceptance/onboarding.mts
./node_modules/.bin/tsx --env-file=.env scripts/acceptance/scale-s8.mts
./node_modules/.bin/tsx --env-file=.env scripts/acceptance/matrix.mts
./node_modules/.bin/tsx --env-file=.env scripts/suite-geo.ts             # 域套件（重）
./node_modules/.bin/tsx --env-file=.env scripts/suite-hotel.ts
./node_modules/.bin/tsx --env-file=.env scripts/suite.ts                 # 主套件（重）

# UI / 能力 / 发布 / 供应链（G4 起按需）
node scripts/generate-capabilities.mjs --check
node scripts/generate-client-projections.mts
node scripts/e2e-service-c.mjs
node scripts/acceptance/ui-probe.mjs
node scripts/acceptance/live.mjs            # P 域真实模型 + 配额硬闸
bash scripts/oss-watch.sh --inventory && bash scripts/oss-watch.sh --check
./node_modules/.bin/tsx scripts/scan/fences.mts 2>/dev/null || ./node_modules/.bin/tsx scripts/tools/fence-alias-scan.mts
```

---

## 5. 决策默认值（未收到逐项答复前按此执行）

DEC-01 P0 平台集合：小红书、抖音、视频号、公众号、微博、携程、美团、私域。
DEC-02 内容比例：60% 蓄水 / 40% 获客。
DEC-03 达人链路下沉主包：执行。
DEC-04 OTA 范围：携程、美团、飞猪先行。
DEC-05 数据接通顺序：PMS → 抖音本地生活 → OTA → 企微。
DEC-06 价格确认机制：一店一档实体卡 + 客户确认单。
DEC-07 日更产能：图片 3–6 条/日、视频 1–2 条/日。
DEC-08 实验车道纪律：不下发、不覆盖、不回流。
DEC-09 指挥链：方案 B（获客口径 CEO 权威，酒店版更名 hotel-ceo）。
DEC-10 渠道账号与桌面机：客户侧 1 台桌面机 + 6 平台账号清单。
DEC-11 真实数据授权：四类授权书 + 厂商对接窗口。
DEC-12 事件总线：内嵌 NATS 缺省，Redis 备选。
DEC-13 执行器：多模块组合（视觉/发布/信源/OTA/私域）。
DEC-14 AI 标识：显式角标 + 文件元数据（生成属性 + 模型编号）。
DEC-15 增长指标：五项周表分子分母固定并写入技能。
DEC-16 验收范围与预算：P5 全量 RDAS + P 域配额。
DEC-17 实验仓与基座同步：优先引回 sync 资产；若暂不引回，在账本显式声明。
DEC-18 首个试点客户：1 家低星单体或民宿共创。

---

## 6. 风险与依赖（开工版）

| 编号 | 风险/依赖 | 缓解 | 当前状态 |
|---|---|---|---|
| R-01 | 平台官方规格变动 | 规格注册表含来源/复核日期/有效期 | G1 落地 |
| R-02 | 平台账号与登录态未就绪 | 先占位骨架与回执回填；账号清单提前冻结 | 待 DEC-10 |
| R-03 | 自动化触发风控 | 模拟人工节奏 + 单账号上限 + G16 | G4 落地 |
| R-04 | 真实数据授权周期长 | 双跑对照 + mock 显式标注 | 待 DEC-11 |
| R-05 | 模型成本超预算 | 预算带 + 谷时调度 + 积分三池 | G5 落地 |
| R-06 | AI 标识合规 | 显式 + 隐式双检；法规原文复核 | G5 落地 |
| R-07 | 达人授权与广告标识 | G-AD1/G-AD2 + 授权台账 | G3 落地 |
| R-08 | 实验仓与基座失联 | 引回 sync 资产或声明不参与 | 待 DEC-17 |
| R-09 | 指挥链调整引发断言失败 | 同步更新遮蔽断言与组合测试 | G2 落地 |
| R-10 | 五模式执行器并发写冲突 | 单主写者 + 版本单调 + 围栏 | G6 落地 |

---

## 7. 跨会话接力协议

1. **新会话第一件事**：读 `docs/GROWTHMATRIX-DEV-LEDGER.md` → 看「当前状态」「接力入口」「待办清单」。
2. **第二件事**：`git fetch origin && git checkout task/T-2026-0921-0003 && git pull --rebase`，核对账本中的提交 SHA 与本地一致。
3. **第三件事**：跑一次账本中记录的最小验证命令，确认环境可用（Node 路径见第 4 节）。
4. **第四件事**：从「当前批次」的第一个未勾选项继续；每完成一项即更新账本并提交，避免状态只存在对话里。
5. **会话结束前**：必须更新账本（进度/提交/未完成/下一步/阻塞），提交并推送。

---

## 8. 四批方案覆盖矩阵与补齐清单

### 8.1 覆盖结论（逐批对账）

| 来源 | 条目总量 | 已纳入批次 | 本版补齐 | 声明式排除 |
|---|---:|---:|---:|---:|
| 第一批 业务层（ACT-B-01 至 14、AC-B-01 至 10） | 24 | 22 | 4（B-46、B-47、B-51、B-53）+ B-84（外部事实季度复核） | 2（ACT-B-12 行业复制、ACT-B-14 精品内容线） |
| 第二批 产品层（KEEP 15 / DROP 7 / ADD 14 / REF 10 / SCALE 8 / WF 8 / UX 5） | 67 | 47 | 20（B-46 至 B-50、B-62 至 B-64、B-66、B-68 至 B-70、B-72、B-77、B-82、B-83） | 0（叙事类调整随 B-68 一并处理） |
| 第三批 技术层（TECH-01 至 26） | 26 | 17 | 9（B-54 至 B-61、B-65、B-67） | 0 |
| 第四批 施工点（B-01 至 B-45、参数 12、组件 10） | 67 | 67 | 0 | 0 |

### 8.2 补齐工作包（B-46 至 B-68）

| 编号 | 归属批次 | 覆盖来源 | 交付 | 验收 |
|---|---|---|---|---|
| B-46 | G3 | ACT-B-07 / ADD-P-11 | 账号矩阵编排对象与协同排期（主账号/门店/员工 IP/达人；防关联纪律） | 排期器单测 + G16 联动用例 |
| B-47 | G3 | ACT-B-10 / REF-05 | 授权台账下沉主包：`ip-curator` 岗位 + `ip_asset` 对象 + 到期预警 | 授权到期用例 + 使用范围校验 |
| B-48 | G3 | ADD-P-14 / UX-03 | 获客主包 `segment-defaults.yml`（自己的「起步方式」客群装配） | 装配幂等 + 引用存在性校验 |
| B-49 | G3 | REF-P-08 / SCALE-05 | 只读岗位产出进晨报固定栏位与闭环台账（巡检/竞对/驾驶舱） | 战报栏位用例 |
| B-50 | G3 | SCALE-07 / SCALE-08 | P2 条件岗运营指标、退场条件与编制周报接入 | 激活/退场用例 |
| B-51 | G4 | ACT-B-09 | 直播通用模板下沉（脚本模板 + 切片管线 + 战报模板 + 触发器） | 直播战役端到端用例 |
| B-52 | G4 | REF-P-10 / UX-05 | C 端前台承接化（领券/留资/预约/咨询四类组件，与线索对象打通） | 承接链路用例 + 回执 |
| B-53 | G5 | ACT-B-08 / WF-07 / ADD-P-12 | 视频全成本账本（实拍/剪辑/渲染/达人素材统一入账） | 单条视频成本可复算 |
| B-54 | G5 | TECH-11 | 真实采集调度接线（social-listening 定时拉取→落账→阈值告警） | 采集调度用例 + 陈旧告警 |
| B-55 | G5 | TECH-16 | mock/live/simulated 三态标识统一（投影与战报同口径） | 三态渲染用例 |
| B-56 | G5 | TECH-23 | 技能保鲜环配置（registry URL + 签名密钥 + auto_sync 策略） | 夜班窗口同步演练 |
| B-57 | G5 | TECH-21 | 工具调用统一超时/重试/幂等键规范 | 工具层契约测试 |
| B-58 | G5 | TECH-19 | 增长线偏好注入（实验/预算/内容决策引用组织偏好） | 偏好引用留痕用例 |
| B-59 | G5 | TECH-26 | 夜班候选扩展（矩阵缺口/增长实验待跑/素材缺口） | 候选清单用例 |
| B-60 | G5 | TECH-17 | 场景覆盖审计表（51 场景 × 套餐 × 档位） | 审计脚本 + 缺场景告警 |
| B-61 | G5 | TECH-14 | 事件链与模型链压测（写入吞吐 + S8 扩到事件维度） | 压测报告含 p50/p95 |
| B-62 | G6 | REF-P-06 | 「内部协作 auto / 对外动作 review」通用规则模板随包分发 | 跨包规则模板用例 |
| B-63 | G6 | REF-P-09 / UX-01 | 首日五关服务端化 + 内容包进 bundle（`bundles/*/onboarding/*.yml`） | 断点续播跨端用例 |
| B-64 | G6 | UX-04 | 首登行动卡（今天要做哪三件事） | 首登载荷断言 |
| B-65 | G6 | TECH-15 | 执行器沙箱与动态加载权限治理 | 越权模块拒绝用例 |
| B-66 | G6 | DROP-P-05 | 统计口径脚本化（README/能力地图/围栏头注释由脚本生成） | `capabilities:check` + 漂移门禁 |
| B-67 | G6 | TECH-03 | `sync/` 基座同步机制引入或书面声明不参与（依 DEC-17） | 计划文档 + 同步演练或豁免说明 |
| B-68 | G6 | DROP-P-01 至 07 | 默认装载裁剪：分账管线/电影级技能库/酒店演示主入口/P2 岗默认不出场/商单默认节拍 | 默认装配清单断言 |
| B-69 | G6 | UX-02 | 引导漏斗埋点接入真实渠道（questline.* 事件化 + 周报栏位） | 埋点事件与周报可查 |
| B-70 | G6 | 第三批 §9.6 / H1 负载 | 人审减负机制：决策包聚合、批量手势、低风险抽检、H1 负载仪表 | H1 ≤7 件/日、≤30 秒/件 |
| B-71 | G6 | 第三批 §9.2 协作纪律 | 契约强制规则：跨岗交付无契约禁止排产（G-COL1）+ 黑板单主写者围栏 | 无契约排产被拒用例 |
| B-72 | G6 | 第三批 §2.3 / P4 | 信任账户接入运行：升降档建议进决策包、降档自动收紧、补考闭环 | 升/降档用例 + 决策包留痕 |
| B-73 | G6 | 第四批 §2 闭环 | 目标→执行闭环贯通验收：goal→五环→thread→contract→receipt→report 端到端 | `acceptance:goal-loop`（新增） |
| B-74 | G6 | 第四批 §6.4 | 备份与回滚演练：PG 备份恢复、bundle 回滚、围栏回滚、模型切换回滚、执行器回滚 | 演练报告 + RTO/RPO 记录 |
| B-75 | G4 | 第三批 §6.2 | 海外与视频号通道联调（TikTok/视频号真实账号；未就绪则转声明排除） | 真机回执或豁免单 |
| B-76 | G1/G6 | 第四批施工图治理 | Bundle 版本与发布治理：版本递增（geo-growth 1.1.0）、CHANGELOG、签名密钥规划、稳定态切换 | `bundle:governance --release` 通过 |
| B-77 | G6 | DROP-P-05 / B-66 延伸 | 文档与演示资产同步：README、capabilities 自动生成、官网与演示页、教学文档 | `capabilities:check` + 官网构建 |
| B-78 | G5 | 供应链纪律 | 依赖与供应链门禁：`oss:inventory`/`oss:check`、新增依赖登记、runtime lock | `pnpm test:oss` + `oss:check` 全绿 |
| B-79 | G5/G6 | 新增表治理 | 新增表与对象的 RLS/租户隔离用例（contracts/threads/growth 明细等） | RLS 越权零行用例 |
| B-80 | G3 | 第一批 §8.4 合规 | 价格与权益确认单工具 + 预售券/退改合规模板（在线旅游与价格法规口径） | 确认单留痕 + 退改模板用例 |
| B-81 | G4 | 第一批 §6.5 降级 | 内容生产降级路径：无工位/无桥时 HTML/CSS 出图与人工发布挂起，产物标「降级产出」 | 降级用例 + 标注断言 |
| B-82 | G3 | 第一批 §6.3 UGC | UGC 征集与授权流程：授权回收、去个人信息、广告标识 | UGC 授权用例 |
| B-83 | G1/G5 | 附录 E 冻结纪律 | 事件 schema 冻结与对象枚举扩展门禁：新增对象不改顶层字段 + hardcode scan | `pnpm scan:fences` + 事件 schema 测试 |
| B-84 | G5 | ACT-B-13 | 外部事实季度复核任务：平台规格/OTA 规范/平台规则变更清单与影响评估 | 复核任务卡 + 变更影响清单 |

### 8.3 声明式排除（不在本计划范围内，需另行开卡）

| 排除项 | 来源 | 原因 | 触发条件 |
|---|---|---|---|
| ACT-B-12 行业复制模板包 | 第一批 P2 | 酒店尚未跑通，复制无意义 | P3 双场景日更连续 14 天达标后 |
| ACT-B-14 精品内容线（品牌片/达人联名） | 第一批 P2 | 与日更主线争产能 | G6 完成后按客户需求开卡 |
| 跨行业第二条行业包 | 总体目标后段 | 当前聚焦酒店垂直 | G7 Go 决策后 |

## 9. 外部批次整合与产品决策影响（v1.3）

### 9.1 已整合的外部批次

| 批次 | 来源 | 对本计划的影响 |
|---|---|---|
| T-2026-0921-0041 视频链路修复 | `sync/video-chain-fixes-20260921-mx` | 交付视频生成完整接入、预生产门 G1–G7 全自动、渲染提交 `render_auto`、vendor 兼容层、G-C04 素材制作放行；直接推进 B-22（视频执行器面）、B-25（发布/门禁边界）、B-27（生视频）、B-29（门禁标识前置） |
| T-2026-0921-0050 基座去审批化 | `task/T-2026-0921-0050` | 下线审批中心/任务中心审批状态/统一待办审批计数/三手势 UI 与移动端审批页；保留 `fence-engine`、`review-console`、`approvals` 表与 tRPC、业务链路关卡（就地放行/退回） |

### 9.2 去审批化对工作包的重定义（原口径 → 新口径）

| 工作包 | 原口径 | 新口径 |
|---|---|---|
| B-70 人审减负 | 决策包聚合 + 审批中心批量手势 + 抽检 | **业务关卡批量放行**：关卡队列聚合、就地批量放行/退回、低风险抽检、关卡负载仪表（H1 口径仍以 approvals 表与事件为准） |
| B-72 信任账户运行 | 升降档建议进「决策包」 | 升降档建议进**晨报与业务关卡队列**；降档自动收紧不变；补考闭环不变 |
| B-73 目标闭环验收 | goal→…→approval→report | goal→五环→thread→contract→**业务关卡放行**→receipt→report；断言改为关卡放行事件 |
| B-64 首登行动卡 | 待拍板事项卡 | **待放行关卡卡**（今天需要放行/确认的业务关卡 + 今日三件事） |
| B-50/B-49 | 决策包/审批计数 | 关卡队列与战报栏位（不恢复已下线的审批中心） |

### 9.3 合并回归风险与纪律（新增）

外部批次可能携带“过期的 bundle.json 快照”：本次 `sync/video-chain-fixes-*` 的提交内容会把 G1 新增的 `provides.matrix` 与 `provides.platformSpecs` 删除。处置：整合时保留双方改动，随后执行 `bundle-governance --refresh-digests` 重算摘要，并以 `matrix-gap` 验证。今后任何外部分支合并后必须依次跑：`bundle-governance` → `matrix-gap` → `bundles.test.ts`（DB）→ `acceptance:onboarding`。

## 10. 工作包细则规范（Definition of Ready / Definition of Done）

### 9.1 每个工作包开工前必须补齐六项（缺一不得开跑，写入账本）

1. **改动面**：涉及的精确文件/目录清单（新建/修改/迁移分开列）。
2. **接口与数据**：新增/变更的函数、事件动作、对象类型、表字段、bundle 槽位；是否触碰五个信任要素（租户边界/围栏/审批/事件/回执）。
3. **前置依赖**：迁移编号、其他工作包、外部凭据、决策项（DEC-*）。
4. **验证证据**：至少一条可复跑命令 + 期望输出；DB 变更必须含 `db:verify-chain`；UI 变更必须含真机截图或 ui-probe；bundle 变更必须含 `bundle:governance`。
5. **回滚路径**：明确“回滚动作 + 影响数据 + 是否需要人审”，默认优先开关/版本回退，禁止不可逆删除。
6. **证据等级声明**：结论中标注 A/B/C/D，未验证项不得写成已验证。

### 9.2 DoD（每个工作包完成的判定）

1. 代码/资产入库且摘要/投影/文档等派生值同步刷新；
2. 类型检查 + 目标单测通过；涉及 DB/事件/围栏/审批的包另跑对应集成门禁；
3. 账本勾选并写入提交 SHA 与验证输出摘要；
4. 分支与 main 云端同步（分支推送 + main 快进或 PR 合并）；
5. 回滚路径经过一次演练或至少一次 dry-run 验证。

### 9.3 重点高风险工作包细则（先行写全，其余包开工时按 9.1 补齐）

| 工作包 | 改动面（文件） | 接口/数据 | 前置 | 测试与证据 | 回滚 |
|---|---|---|---|---|---|
| B-02 装配合并触发器 | `packages/base/bundles/assembly.ts`、`packages/base/bundles/triggers.ts`（已建）、`packages/base/bundles/bundles.test.ts` | `loadComposedTriggers(slug)`；写入 `triggers` 表（含 `source_bundle`/`declared_version`）；激活事件 `composition.triggers` | B-01/B-04（已完成） | `vitest run packages/base/bundles/bundles.test.ts`（新增触发器断言）+ `matrix-gap` 同构的 `triggers-gap` | 删除 `source_bundle` 命中的触发器行或 `enabled=false`；客户自建触发器不受影响 |
| B-07 指挥权切换 | `bundles/hotel/presets/company-ceo.yml` → `hotel-ceo.yml`、`bundles/hotel/bundle.json`、`bundles/geo-growth/bundle.json#composition`、`packages/base/bundles/bundles.test.ts`、`scripts/seed*.ts`、`scripts/suite-hotel.ts` | preset_key 改名；`presetOwners` 去除 `company-ceo`；组合编制 72→73（+B-09 后 74）；激活事件 `shadowed` 从 4 处变 3 处 | 无 | `RUN_DB_TESTS=1 vitest run packages/base/bundles/bundles.test.ts` + `acceptance:onboarding`（72→73 断言同步） | `git revert` 该包提交 + 重新装配；DB 中旧 `company-ceo` 行保留只增，按需 disable |
| B-13/B-14 矩阵 | `bundles/geo-growth/matrix/content-platform-matrix.yml`、`packages/base/bundles/matrix.ts`、`scripts/tools/matrix-gap.mts`（已完成） | `GrowthMatrixSchema`；缺口四类（岗位/围栏/平台/目标+账号位） | 无 | `tsx scripts/tools/matrix-gap.mts`（0 缺口）+ `vitest matrix.test.ts` | 移除 `provides.matrix` 声明并刷新摘要；文件保留不删 |
| B-21/B-22 执行器组合 | `apps/server/src/runtime/tool-executor.ts`、`bundles/geo-growth/connectors/{publish,source,ota}-bridge/server-adapter.mts`、`.env.example`、`scripts/doctor.sh` | `WORKLOOM_TOOL_EXECUTOR_MODULES`（逗号列表）+ 按工具前缀路由；单模块失败 fail-closed 不影响其他模块 | B-18/B-19/B-20 | `vitest run packages/base/publish-rpa` + 视觉桥 runtime-smoke + 发布回执链路演练 | 删除环境变量即回退到“未核实”语义；桥代码保留 |
| B-36/B-40 协作执行器 | `packages/base/collaboration/dispatch.ts`、`schema.ts`、`packages/db/migrations/0040_contract_thread.sql`、`apps/server/src/service/collaboration.ts`、`apps/server/src/trpc/collaboration-router.ts`、`packages/runtime/src/loop.ts` | 契约新增 `thread_id/bundle_scope/matrix_refs`；agent actor（presetKey+fenceBindings）；deliver 自动触发 verifier；settle 写 `budget_ledger` | B-37 迁移、B-38 actor | `tsx scripts/acceptance/collab-loop.mts` + 五模式用例 + RLS 越权零行 | 关闭 agent 派发开关（配置）并停用 dispatch；表字段只增，无需回滚迁移 |
| B-42 经营日历 | `bundles/{geo-growth,hotel,ai-video}/triggers.yml`、`bundles/geo-growth/bundle.json`、`scripts/seed-geo.ts` | 触发器 id 前缀 `tg-*`；三包合并主包优先；覆盖 07:00/07:30/08:30/09:00/2h/30min/19-23/夜班/周/月全时点 | B-02/B-03b | `tsx scripts/tools/triggers-gap.mts`（新增）+ `suite:geo` 触发器断言 + 幂等重跑 | 按 `source_bundle` 禁用声明行；触发账本 `trigger_fires` 只增 |
| B-68 默认装载裁剪 | `bundles/*/segment-defaults.yml`、`scripts/seed*.ts`、`bundles/*/bundle.json`（标签/描述）、README 叙事段 | 默认不装 `settlement-recon`、电影级技能库；演示主入口固定 ws-geo；P2 岗默认不出场；商单默认不排触发器 | 无 | 默认装配清单断言 + `acceptance:onboarding` | 恢复默认清单开关（保留技能市场安装入口） |
| B-76 Bundle 版本治理 | `bundles/geo-growth/{bundle.json,CHANGELOG.md}`、`scripts/bundle-governance.mts`、签名密钥配置 | 版本 1.0.0 → 1.1.0；`release --refresh-digests`；稳定态签名（密钥托管，不落库） | B-01、B-17 | `tsx scripts/bundle-governance.mts --refresh-digests`；`--release` 需密钥环境；`product:verify` | 版本回退 + 摘要随回滚版本重算；签名密钥可吊销 |

## 11. 变更记录

| 日期 | 版本 | 变更 |
|---|---|---|
| 2026-09-21 | v1.0 | 首版：G0–G7 批次划分、执行流程、验收命令、决策默认值、风险与接力协议 |
| 2026-09-21 | v1.1 | 对账四批方案，新增 B-46 至 B-68 共 23 项补齐工作包与覆盖矩阵；声明三项排除 |
| 2026-09-21 | v1.2 | 二轮对账：新增 B-69 至 B-84 共 16 项（引导埋点、人审减负、契约强制、信任账户运行、目标闭环验收、备份回滚、海外通道、Bundle 版本治理、文档同步、供应链门禁、RLS 用例、价格确认单、降级路径、UGC 授权、schema 冻结门禁、外部事实复核）；补充工作包 DoR/DoD 与 8 个高风险包细则；命令清单扩展 |
| 2026-09-21 | v1.3 | 整合外部批次（T-2026-0921-0041 视频链路修复、T-2026-0921-0050 基座去审批化）；按去审批化重定义 B-70/B-72/B-73/B-64 的交互口径；记录 bundle.json 合并回归风险与处置 |
