# 基座同步声明（B-67 / DEC-17）

> 结论：本仓（`workloom-growthmatrix`，实验车道派生实例）**不引入 `sync/` 运行时同步器**，
> 采用「书面声明不参与」路径；受控根级资产仍按 `.workloom-base-sync.json` 的摘要约定手工/脚本比对。

## 1. 为什么

- 本仓由 `WorkLoom-growth` 复制派生并做 GrowthMatrix 语义改造（实验车道）；按实验车道纪律
  「不下发、不覆盖、不回流」，启用基座 fanout 的自动合并会与本地改造冲突。
- 本仓已按任务线维护自己的计划/账本（`docs/GROWTHMATRIX-EXECUTION-PLAN.md`、`docs/GROWTHMATRIX-DEV-LEDGER.md`），
  跨会话状态源在本仓内部闭环。

## 2. 当前同步口径

| 资产 | 口径 |
|---|---|
| `WORKLOOM_PRODUCT_CONTEXT.md` / `AGENTS.md` / `docs/DEVELOPMENT-PROTOCOL.md` | 只读参考；需要更新时人工比对受控原文并单独提交 |
| `.workloom-base-sync.json` | 保留摘要记录，用于发现漂移；不启用自动 fanout 合并 |
| `packages/base/**` 等运行时代码 | 本仓自持；如与基座冲突，以本仓任务卡决策为准 |
| 实验扩展路径 | 已在 `sync/child-repos.json`（基座侧）登记为实验车道；本仓不反向回流 |

## 3. 解除条件（任一）

1. 本仓改造毕业为公共能力：按 L2→L1→L0 提案任务卡把能力迁回基座；
2. 产品所有者明确要求本仓纳入自动 fanout：在基座 `sync/child-repos.json` 登记本仓 + 引入 `sync/` 目录；
3. 本仓降级为普通行业仓：停止实验语义并接受常规基座同步。

## 4. 风险

- 漂移不可自动发现：依赖本仓 CI（`static/db/test` 三闸门）与账本中的「同步对账」记录；
- 基座安全补丁需人工评估后 cherry-pick（见账本风险表 L-03）。
