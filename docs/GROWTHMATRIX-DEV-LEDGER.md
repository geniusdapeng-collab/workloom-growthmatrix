# GrowthMatrix 开发进度账本（跨会话唯一状态源）

> 用途：记录批次进度、提交 SHA、测试结果、未完成项与下一步；任何会话结束前必须更新本文件。
> 配套计划：`docs/GROWTHMATRIX-EXECUTION-PLAN.md`
> 基线：`a4b2b20`（2026-09-21）｜任务号：`T-2026-0921-0003`｜主线分支：`task/T-2026-0921-0003`

---

## 1. 当前状态

| 项 | 值 |
|---|---|
| 当前批次 | G1 契约与矩阵地基 |
| 批次状态 | 进行中 |
| 最近更新 | 2026-09-21（会话 1） |
| 分支 | `task/T-2026-0921-0003` |
| 云端最新提交 | 待首次推送后回填 |
| 本地 HEAD | 待首次提交后回填 |
| 阻塞 | 无 |
| 下一步 | G1：契约三槽位（B-01）→ 迁移（B-04）→ 矩阵数据与加载器（B-13/B-14）→ 规格注册表与预检（B-15/B-16） |

---

## 2. 批次状态总表

| 批次 | 名称 | 状态 | 提交 SHA | 验收结果 |
|---|---|---|---|---|
| G0 | 计划与账本 | 进行中（本文件） | 待提交 | 文档落盘 + 云端可见 |
| G1 | 契约与矩阵地基 | 未开始 | — | — |
| G2 | 触发器与指挥链 | 未开始 | — | — |
| G3 | 岗位与增长线 | 未开始 | — | — |
| G4 | 通道与执行器 | 未开始 | — | — |
| G5 | 模型、生成与数据 | 未开始 | — | — |
| G6 | 协作机制与验收 | 未开始 | — | — |
| G7 | 真机验收与生产实测 | 未开始 | — | — |

---

## 3. 待办清单（按批次）

### G1 契约与矩阵地基

- [ ] B-01 `packages/industry-contract/src/index.ts`：ProvidesSchema 增加 `triggers`/`matrix`/`platformSpecs`；CompositionSchema 增加 `commandChain`
- [ ] B-01a 更新 `packages/industry-contract/src/index.test.ts` 契约用例
- [ ] B-04 `packages/db/migrations/0037_trigger_declarative.sql`：triggers 表声明列与索引
- [ ] B-13 `bundles/geo-growth/matrix/content-platform-matrix.yml`：123 子类矩阵数据化
- [ ] B-14 `packages/base/bundles/matrix.ts`：加载/校验/缺口报告 + 单测
- [ ] B-15 `bundles/geo-growth/templates/platform-specs.json`：21 平台规格注册表
- [ ] B-16 `packages/base/publish-rpa/specs.ts`：发布前规格硬校验 + 单测
- [ ] B-01b `bundles/geo-growth/bundle.json` 声明新资产并刷新摘要
- [ ] G1 验收：typecheck + test + 新增单测全绿

### G2 触发器与指挥链

- [ ] B-02 装配器合并 triggers 并幂等写库
- [ ] B-03 声明式触发器 upsert 与校验
- [ ] B-05 三包 `triggers.yml` 声明
- [ ] B-06 seed 脚本去硬编码
- [ ] B-07 指挥权归获客口径（hotel company-ceo 更名 hotel-ceo）
- [ ] B-08 commandChain 记录与组合看板展示
- [ ] B-42 合并经营日历触发器
- [ ] G2 验收：suite:geo / suite:hotel / 触发器断言全绿

### G3 岗位与增长线

- [ ] B-09 creator-partner 下沉主包
- [ ] B-10 四类新对象（creator_collab / growth_asset / account_growth_metric / matrix_entry）
- [ ] B-11 增长指标技能
- [ ] B-12 四个岗位参数与工具调整
- [ ] B-43 hotel 与 ai-video 补考题

### G4 通道与执行器

- [ ] B-18 五类国内通道适配器
- [ ] B-19 OTA 上传包
- [ ] B-20 私域执行器
- [ ] B-21 多执行器组合
- [ ] B-22 发布/信源/OTA 执行器适配器
- [ ] B-23 桌面浏览器驱动
- [ ] B-24 环境变量与 doctor/connectors-check
- [ ] B-25 发布重试与日上限参数化

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

### G6 协作机制与验收

- [ ] B-36 五模式执行器
- [ ] B-37 契约线程字段与迁移
- [ ] B-38 agent actor 与写路径
- [ ] B-39 冲突仲裁对象化
- [ ] B-40 契约↔线程↔审批↔结算
- [ ] B-41 协作闭环验收脚本
- [ ] B-44 RLS/GUC 静态检查
- [ ] B-45 验收矩阵扩展

### G7 真机验收

- [ ] RDAS v3.1 L0–L16 / U / O / P 全量
- [ ] ADR/HIR 报告与 AVR 判定
- [ ] Go/No-Go 与回滚演练
- [ ] 验收报告四段（覆盖率声明/证据分级/收尾报告/自检表）

---

## 4. 提交记录

| 序号 | 提交 SHA | 摘要 | 批次 | 验证 |
|---|---|---|---|---|
| 1 | 待回填 | docs(growth): 开发计划与进度账本 [T-2026-0921-0003] | G0 | 文档审阅 |

---

## 5. 测试与验收记录

| 日期 | 命令 | 结果 | 备注 |
|---|---|---|---|
| 2026-09-21 | `pnpm install`（registry.npmmirror.com） | 进行中 | 首次装依赖 |

---

## 6. 阻塞与风险

| 编号 | 描述 | 影响 | 处置 | 状态 |
|---|---|---|---|---|
| L-01 | 本机默认 PATH 无 Node，需要显式加入 Codex 运行时路径 | 命令不可执行 | 计划文档第 4 节已固化 PATH 写法 | 已缓解 |
| L-02 | CNB 推送凭据由会话提供，仅可临时使用 | 安全 | 不写入任何文件；推送后建议轮换 | 已缓解 |
| L-03 | `sync/` 目录缺失 | 跨仓同步 | 依 DEC-17 决策处理 | 待决策 |

---

## 7. 接力入口（新会话按此恢复）

1. 读本文件第 1、2、3、7 节。
2. `git fetch origin && git checkout task/T-2026-0921-0003 && git pull --rebase`。
3. 核对「云端最新提交」与本地 HEAD；不一致以云端为准并更新本文件。
4. 从「当前批次」的第一个未勾选项继续；每完成一项更新本文件并提交。
5. 会话结束前更新第 1、2、3、4、5、6 节并推送。

---

## 8. 变更记录

| 日期 | 变更 |
|---|---|
| 2026-09-21 | 建账：G0–G7 状态表、G1–G7 待办、提交与测试记录模板、接力入口 |
