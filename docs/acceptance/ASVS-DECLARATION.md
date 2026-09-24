# ASVS 目标等级声明与抽验记录（L6-13 / L10-04）

> 生成：2026-09-24T15:30:16.933Z｜依据：RDAS v3.1 检查单 L6-13/L10-04（建议 L2）｜范围：本仓 = workloom-growthmatrix（隔离副本）

## 1. 目标等级声明

- 目标：**OWASP ASVS 4.0.3 Level 2**（涉及客户数据与多租户工作区的基线档位）。
- 声明口径：本仓不宣称通过 ASVS 认证；本文件声明目标等级 + 抽样复核记录，供产品所有者与安全复核使用。

## 2. 抽验样本（5 项，抽样非全量）

| 控制项 | 证据 | 结果 |
|---|---|---|
| V1.1.1 安全开发生命周期 | pnpm typecheck；pnpm test；pnpm acceptance:gates；pnpm bundle:governance --release | pass |
| V4.1.1/V4.1.2 访问控制与租户隔离 | pnpm scan:rls；apps/server 租户隔离用例；redteam RT-08 跨租户拒读 | pass |
| V8.2.1 敏感数据不进日志 | outputs/acceptance/manual/evidence/L12-02-pii-scan.json | pass |
| V7.1.1/V7.1.2 日志与审计留痕 | 五元事件账本 + pnpm db:verify-chain（8 段/1100+ 事件全绿） | pass |
| V11.1.1 业务逻辑与围栏 fail-closed | packages/base/fence-engine 判定器用例（auto/review/block + 求值异常→block）；redteam 7 例 0 发现 | pass |

## 3. 未覆盖与后续

- 未抽验：认证与会话细节（V2/V3）、传输与存储加密强度（V6/V9）、业务连续性（V16）等。
- 后续：由安全复核按 Level 2 逐章抽样（建议每次抽 10%），并把结论回写本文件与验收报告。
