# geo-growth Bundle 变更日志

> 版本遵循语义化版本；本文件与 `bundle.json` 的 `version` 同批提交（发布治理见 `docs/bundle-release-policy.md`）。
> 规则：任何对外可观察的资产变化（presets/fences/skills/schemas/pipelines/ui/serviceFront）都必须在此登记。

## 1.1.0（2026-09-24）

**新增能力**
- 协作纪律围栏包 `fences/geo-growth-collaboration.yml`：`G-CON1` 跨岗排产必须带任务契约、`G-BB1` 黑板单主写者（B-71）。
- 通用围栏规则模板 `internal-collaboration`：内部协作 auto / 花钱与付费生成 review / 对外动作 review，按包前缀 `G-C` 展开为 `G-C01`~`G-C03`（B-62；模板唯一事实源）。
- 首日上岗内容包 `onboarding/questline.yml`：员工卡/目标卡/任务卡/驳回枚举随包分发（B-63），
  与 `packages/base/bundles/templates/questline-base.yml` 合并为四关引导；服务端按工作区活动 Bundle 下发。
- 对象模型新增 `blackboard_entry`（共享黑板条目）。

**治理与一致性**
- 围栏基线由手写 G-C01/G-C02 改为模板声明（`templates:`），规则口径单源；
- `provides.onboarding` 槽位接入 Bundle 契约（`packages/industry-contract`）；
- 完整性摘要按发布流程重算并签名（ed25519，密钥托管见发布策略）。

**兼容性**
- 仍兼容 base `>=0.1.0 <1.0.0`、ui `>=0.1.0 <1.0.0`、契约 `2.0.0`；依赖 hotel `3.4.0`、ai-video `1.0.0`（同批切稳定态）。
