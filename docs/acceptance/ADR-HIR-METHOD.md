# ADR/HIR 口径与方法（ADR-01 / ADR-02 / ADR-13 / ADR-15）

> 生成：2026-09-24T15:31:54.197Z｜数据源：`outputs/acceptance/autonomy/autonomy-report.json`（M1 遥测口径，B 级）+ O 域受控任务（A 级）

## 1. 交付单位与分母（ADR-01）

- 交付单位：`thread`（终态 = completed/failed/paused；ADR 分母默认 completed）。
- 最小实质标准：线程有 ≥1 条五元事件且推进步数 ≥1（防 replay 假完成，见 `acceptance/outcomes/geo-growth-ops.yaml` 断言）。
- 去重键：`thread.id`；同会话重复派单不去重（按真实派单口径计）。
- 排除规则：夹具（标题/ID 含 `suite.`/`suite-`/`apr-suite-`/`T-suite`）+ 近零时长审批（<1s 且已裁决，视为橡皮图章）。

## 2. 干预事件契约（ADR-02）

| 级 | 判据（代码口径，`scripts/acceptance/autonomy.mjs`） | 事件落点 |
|---|---|---|
| H0 | 无人工介入 | — |
| H1 | `approvals.status=approved` 且无修改/驳回/接管 | `approval.gesture` + `approvals.gesture` |
| H2 | `approvals.status=edited` 或线程内人类动作 | 同上（`edit_kind=correction/preference`） |
| H3 | `rejected` / `threads.paused_by` / `failed` + 人类动作 | `approval.gesture` + 线程状态 |
| H4 | `c_tickets` 关联到线程（返工线索） | 工单 payload |

线下补录：HMPO 以 `approval latency proxy` 记下限；人工工时未登记（覆盖不足时只作下限估计，不用于对外结论）。

## 3. AVR 五判据与四象限（ADR-13）

- 五判据同时成立才可称「AI 自主价值提升」：业务 KPI 达标 + ADR↑ + HIR-NI↓ + HMPO↓ + 质量/护栏不劣化。
- 四象限：以 ADR 与业务结果为两轴；**仅 A 象限（高自主 + 高结果）**允许对外称「提升」，B/C/D 象限必须逐条解释。

## 4. 对照与替代解释（ADR-15）

- 有对照（影子/AB/阶梯）→ 可作因果表述；无对照 → 只报观察值 + 替代解释（含人工投入变化、任务混合变化）。
- 本仓现状：受控任务集（`outcome`，n=4）为**无对照观察**；M1 遥测为小样本 → 报告只给区间与「不显著」标注。

## 5. 与红线的关系

- 红线 #12：不得用 LLM 评审单独判定红线；ADR/HIR 的判据均为**确定性代码**（事件字段与状态），LLM 只参与任务执行。
