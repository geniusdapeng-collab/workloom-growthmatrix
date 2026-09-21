# GrowthMatrix 开发进度账本（跨会话唯一状态源）

> 用途：记录批次进度、提交 SHA、测试结果、未完成项与下一步；任何会话结束前必须更新本文件。
> 配套计划：`docs/GROWTHMATRIX-EXECUTION-PLAN.md`
> 基线：`a4b2b20`（2026-09-21）｜任务号：`T-2026-0921-0003`｜主线分支：`task/T-2026-0921-0003`

---

## 1. 当前状态

| 项 | 值 |
|---|---|
| 当前批次 | G3 岗位与增长线 |
| 批次状态 | G2 完成（仅余 B-06c video seed，依赖围栏版本口径对齐）；G3 待开工 |
| 最近更新 | 2026-09-21（会话 2 · B-07/B-08 指挥权归位 + 汇报关系；组合编制 73 岗，双域套件全绿） |
| 分支 | `task/T-2026-0921-0003` |
| 云端最新提交 | 本地整合后待推送（含 T-2026-0921-0041 / T-2026-0921-0050） |
| 本地 HEAD | 整合提交（视频链路修复 + 去审批化 + 计划 v1.3） |
| 阻塞 | 无 |
| 下一步 | G3 首项：B-09 creator-partner 下沉主包 → B-10 四类新对象 → B-11/B-12 增长指标与岗位参数 → B-46..B-50 |
| 计划版本 | v1.3：84 个工作包；已整合视频链路修复与基座去审批化，并重定义 B-70/B-72/B-73/B-64 |

---

## 2. 批次状态总表

| 批次 | 名称 | 状态 | 提交 SHA | 验收结果 |
|---|---|---|---|---|
| G0 | 计划与账本 | 完成 | `4cf8205` | 文档已推送云端 |
| G1 | 契约与矩阵地基 | 完成 | `ec29c2e` | vitest 38/38；tsc（base+contract）通过；bundle governance 通过；矩阵缺口 0 |
| G2 | 触发器与指挥链 | 进行中 | 待提交 | 声明层纯函数单测通过；DB 装载与指挥链待续 |
| G3 | 岗位与增长线 | 未开始 | — | — |
| G4 | 通道与执行器 | 未开始 | — | — |
| G5 | 模型、生成与数据 | 未开始 | — | — |
| G6 | 协作机制与验收 | 未开始 | — | — |
| G7 | 真机验收与生产实测 | 未开始 | — | — |

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
- [ ] B-05 三包 `triggers.yml` 声明
  - [x] B-05a `bundles/geo-growth/triggers.yml`（14 条）已声明并随包装载
  - [x] B-05b `bundles/hotel/triggers.yml`（12 条，含 system: night-shift）与 `bundles/ai-video/triggers.yml`（7 条）已声明并随包装载
- [ ] B-06 seed 脚本去硬编码
  - [x] B-06a `scripts/seed-geo.ts` 移除硬编码触发器，改回显声明装载结果；`suite-geo` 断言改按 `declared_id` 对账（81/81 通过）
  - [x] B-06b `scripts/seed.ts` 移除硬编码触发器并退役旧 seed 触发器；`suite-hotel` 断言改为组合日历对账（43/43 通过）
  - [ ] B-06c `scripts/seed-video.ts` 去硬编码（video-studio 需先对齐装配围栏版本口径，避免与组合装配互相回滚）
- [x] B-07 指挥权归获客口径：hotel `company-ceo` 更名 `hotel-ceo`，geo-growth `company-ceo` 成为组合权威；遮蔽 4→3 处，组合编制 72→73 岗；酒店获客管线 owner 同步改名
- [x] B-08 `commandChain` 声明与校验：8 条汇报关系（growth-lead→company-ceo、五组→growth-lead、director/hotel-ceo→growth-lead/company-ceo）；两端必须在编，未命中拒绝装配；激活事件带 `commandChain` 计数；岗位退场/同名去重（只停用不删除）已实现
- [ ] B-42 合并经营日历触发器
  - [x] B-42a geo-growth 14 条经营日历（情报/决策包/指标/评论/能见度/战报/回测/巡检/人效 + 4 CEO 节拍）
  - [x] B-42b 三包节拍合并与去重：按 beat（CEO 节拍）与 template（如 metrics.collect/comments.ingest）去重，主包优先并留痕；组合日历 23 条（geo 14 + hotel 8 + ai-video 1）
- [ ] G2 验收：suite:geo / suite:hotel / 触发器断言全绿

### G3 岗位与增长线

- [ ] B-09 creator-partner 下沉主包
- [ ] B-10 四类新对象（creator_collab / growth_asset / account_growth_metric / matrix_entry）
- [ ] B-11 增长指标技能
- [ ] B-12 四个岗位参数与工具调整
- [ ] B-43 hotel 与 ai-video 补考题
- [ ] B-46 账号矩阵编排对象与协同排期（覆盖 ACT-B-07 / ADD-P-11）
- [ ] B-47 授权台账下沉主包（ip-curator + ip_asset + 到期预警，覆盖 ACT-B-10）
- [ ] B-48 获客主包 segment-defaults 客群装配（覆盖 ADD-P-14 / UX-03）
- [ ] B-49 只读岗位产出进晨报与闭环台账（覆盖 REF-P-08 / SCALE-05）
- [ ] B-50 P2 条件岗运营指标、退场条件与编制周报（覆盖 SCALE-07/08）
- [ ] B-80 价格与权益确认单工具 + 预售券/退改合规模板（覆盖第一批合规条目）
- [ ] B-82 UGC 征集与授权流程（授权回收/去个人信息/广告标识）

### G4 通道与执行器

- [ ] B-18 五类国内通道适配器
- [ ] B-19 OTA 上传包
- [ ] B-20 私域执行器
- [ ] B-21 多执行器组合
- [ ] B-22 发布/信源/OTA 执行器适配器
- [ ] B-23 桌面浏览器驱动
- [ ] B-24 环境变量与 doctor/connectors-check
- [ ] B-25 发布重试与日上限参数化
- [ ] B-51 直播通用模板与切片管线下沉（覆盖 ACT-B-09）
- [ ] B-52 C 端前台承接化四组件（覆盖 REF-P-10 / UX-05）
- [ ] B-75 海外与视频号通道联调（TikTok/视频号；未就绪转声明排除）
- [ ] B-81 内容生产降级路径（无工位/无桥时的降级出图与人工发布挂起）

### G5 模型、生成与数据

- [ ] B-26 真实文本模型池配置
- [ ] B-27 生图/生视频配置
- [ ] B-28 资产 AI 标识字段与迁移
- [ ] B-29 显式与隐式标识产出
- [ ] B-30 模型版本台账
- [ ] B-31 NATS 事件总线
- [ ] B-32 四类真实连接器
- [ ] B-33 增长日表
- [ ] B-34 投影扩展
- [ ] B-35 看门狗
- [ ] B-53 视频全成本账本（覆盖 ACT-B-08 / WF-07 / ADD-P-12）
- [ ] B-54 真实采集调度接线（覆盖 TECH-11）
- [ ] B-55 mock/live/simulated 三态标识统一（覆盖 TECH-16）
- [ ] B-56 技能保鲜环 registry 与签名配置（覆盖 TECH-23）
- [ ] B-57 工具调用统一超时/重试/幂等规范（覆盖 TECH-21）
- [ ] B-58 增长线偏好注入（覆盖 TECH-19）
- [ ] B-59 夜班候选扩展（覆盖 TECH-26）
- [ ] B-60 场景覆盖审计表（覆盖 TECH-17）
- [ ] B-61 事件链与模型链压测（覆盖 TECH-14）
- [ ] B-78 依赖与供应链门禁（oss:inventory/oss:check/runtime lock）
- [ ] B-79 新增表与对象的 RLS/租户隔离用例
- [ ] B-84 外部事实季度复核任务（覆盖 ACT-B-13）

### G6 协作机制与验收

- [ ] B-36 五模式执行器
- [ ] B-37 契约线程字段与迁移
- [ ] B-38 agent actor 与写路径
- [ ] B-39 冲突仲裁对象化
- [ ] B-40 契约↔线程↔审批↔结算
- [ ] B-41 协作闭环验收脚本
- [ ] B-44 RLS/GUC 静态检查
- [ ] B-45 验收矩阵扩展
- [ ] B-62 「内部协作 auto / 对外动作 review」通用规则模板（覆盖 REF-P-06）
- [ ] B-63 首日五关服务端化 + 内容包进 bundle（覆盖 REF-P-09 / UX-01）
- [ ] B-64 首登行动卡（覆盖 UX-04）
- [ ] B-65 执行器沙箱与动态加载权限治理（覆盖 TECH-15）
- [ ] B-66 统计口径脚本化（覆盖 DROP-P-05）
- [ ] B-67 sync/ 基座同步机制引入或声明不参与（覆盖 TECH-03，依 DEC-17）
- [ ] B-68 默认装载裁剪（覆盖 DROP-P-01 至 07）
- [ ] B-69 引导漏斗埋点接入真实渠道（覆盖 UX-02）
- [ ] B-70 人审减负机制（决策包聚合/批量手势/低风险抽检/H1 仪表）
- [ ] B-71 契约强制规则 G-COL1 + 黑板单主写者围栏
- [ ] B-72 信任账户接入运行（升降档进决策包、降档自动收紧、补考）
- [ ] B-73 目标→执行闭环端到端验收（goal→五环→thread→contract→receipt→report）
- [ ] B-74 备份与回滚演练（PG/bundle/围栏/模型/执行器）
- [ ] B-76 Bundle 版本与发布治理（geo-growth 1.1.0 + CHANGELOG + 签名规划）
- [ ] B-77 文档与演示资产同步（README/capabilities/官网/演示页）
- [ ] B-83 事件 schema 冻结与对象枚举扩展门禁

### G7 真机验收

- [ ] RDAS v3.1 L0–L16 / U / O / P 全量
- [ ] ADR/HIR 报告与 AVR 判定
- [ ] Go/No-Go 与回滚演练
- [ ] 验收报告四段（覆盖率声明/证据分级/收尾报告/自检表）

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
| L-04 | pnpm 11 因 ignored builds 使 `pnpm <script>` 触发安装检查失败 | 脚本不可用 | 使用 `node_modules/.bin/tsx`、`node_modules/.bin/vitest` 直跑；不改仓库 pnpm 配置 | 已缓解 |
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
| 2026-09-21 | 会话 2：拉取并整合 T-2026-0921-0041（视频链路修复）与 T-2026-0921-0050（基座去审批化）；修复 bundle.json 合并回归；计划升级 v1.3 并重定义 4 个工作包口径；全量回归通过 |
| 2026-09-21 | 会话 2 续：B-02/B-03b 落地（装配器声明式触发器装载：0038 迁移、幂等 upsert、客户主权与退出禁用）；geo-growth 14 条声明上线；seed-geo 去硬编码；suite:geo 81/81、suite:hotel 43/43、DB 集成 16/16 全绿 |
| 2026-09-21 | 会话 2 续 2：B-05b/B-06b/B-42b 落地（hotel 12 条 + ai-video 7 条声明；system 动作白名单；按 beat/template 去重的组合经营日历 23 条；seed.ts 去硬编码并退役旧触发器）；双域套件与 DB 集成全绿 |
| 2026-09-21 | 会话 2 续 3：B-07/B-08 落地（指挥权归获客口径，hotel-ceo 独立在编；commandChain 8 条并校验；岗位退场与同名去重只停用不删除）；文档与套件口径同步 73 岗；全量回归通过 |
