# 三端客户端基座 · 本仓产品分叉声明（实验车道口径）

> 适用：`WorkLoom-growthmatrix`（隔离副本）｜ 首次落地：2026-09-19 ｜
> 机制迁移：2026-09-29（`[T-2026-0929-0001]` MC-011 门禁修复）

## 1. 背景：为什么本仓会"门禁失败"

基座的三端客户端基座（`apps/web` / `apps/webb` / `apps/webc` + `@workloom/ui` 稳定版）默认要求：
**行业仓不得直接修改受管客户端文件**，行业差异只能放在 Bundle / theme / projection / config / extension 白名单目录里
（`scripts/verify-client-foundation-consumer.mjs` 的基座口径）。

但 growthmatrix 不是"行业仓"，而是**三端壳之上的产品分叉**：页面（`src/pages/**`）、应用壳（`src/App.tsx`、
`src/shell/**`）、语音（`src/voice/**`）、首日上岗引导（`src/onboarding/**`、`src/components/mate-guide/**`）、
织球/织伴/星环等产品层组件都是获客增长产品面，天然不可能与基座三端壳逐字节一致。

## 2. 机制：实验车道容差（协议 §10.3，基座现行口径）

**仓级行业扩展路径的唯一事实源是仓内 `.workloom-ui-governance.json`**：

```json
{
  "lane": "experiment",
  "industryExtensionPaths": ["apps/*/src/pages/**", "apps/*/src/shell/**", "…"]
}
```

`scripts/verify-client-foundation-consumer.mjs`（基座随仓门禁，SHA-256 记在同一个治理文件里）读取它，
把其中路径视为**本仓自有**：

- 豁免「客户端根存在非白名单行业文件」检查；
- 豁免受管文件的**指纹比对**（维护责任在本仓，基座历史指纹不再是判据）；
- 未登记 `lane=experiment`（缺治理文件、或 lane 为行业仓）时行为与基座原口径完全一致（fail closed）。

同时**仍然强制**（不允许用声明绕过）：

| 约束 | 强制点 |
|---|---|
| 四个必备受管入口存在且受管（三端 `main.tsx` + `apps/webc/public/service-front.config.json`） | 门禁 `REQUIRED_MANAGED_ENTRIES` |
| 全局 5 条行业扩展白名单与 state 逐条相等 | 门禁白名单相等校验 |
| `@workloom/ui` 与 `.workloom-ui.json` 同版、消费门禁通过 | `scripts/verify-ui-consumer.mjs --require-governance-state` |
| 门禁脚本本体与 `.workloom-ui-governance.json` 的 SHA-256 一致 | 治理指纹校验（行业仓不得私改门禁） |
| 声明路径必须是 `apps/` 下、不含 `..` / `\` | 门禁对声明本身做格式校验（非法即红） |

回归测试：`scripts/verify-client-foundation-extensions.test.ts`（`pnpm test:scripts` 内执行）——
无治理文件仍报错；登记后 0 错误；删掉必备入口仍报错；`lane=industry` 不适用；非法声明路径报错。

### 2.1 本仓 2026-09-19 ~ 2026-09-29 的历史机制（已退场）

本仓曾在**自持 fork 的门禁**（`scripts/verify-client-foundation-consumer.mjs` 本地改造版）里读仓内
`.workloom-client-extensions.json` 来放行产品分叉。该机制的问题（2026-09-29 实测）：

1. 门禁脚本本体与 `.workloom-ui-governance.json` 记录的 SHA-256 不一致 → `--require-governance-state` 永远红灯；
2. canonical UI 制品地址仍写 GitHub，而本仓已迁 CNB → 「UI 制品契约」三条恒红；
3. 基座 2026-09-27（`39ce1f5`）已落地同语义的 `lane=experiment` 容差 → 仓内自持机制重复且会持续漂移。

现机制改为**直接消费基座现行门禁**（三份脚本字节一致，SHA-256 记入治理文件），
自持声明文件 `.workloom-client-extensions.json` 已删除。

## 3. 声明清单的来源与残余风险（诚实边界）

- **本仓是隔离副本**（`sync/child-repos.json#isolatedRepos`：既不接收基座下发，也不回流基座），
  因此治理文件里的 `industryExtensionPaths` 由**本仓自持**，取值 =
  基座对 `WorkLoom-growth` 的登记项（`children[].industryExtensionPaths`）∪ 本仓 2026-09-19 声明
  ∪ 本仓实测产品分叉面（2026-09-29 门禁修复补齐，含织球/织伴/星环/媒资与三端壳定制文件）。
- **万一本仓恢复同步**（须产品所有者重新下令）：先删掉本声明块、按基座 rollout 重新生成治理文件，
  否则基座 rollout 会因「快照占用行业扩展路径」fail closed（协议 §10.3 的退管迁移由 rollout 负责）。
- **基座版本的织球（LoomBall）已在 2026-09-27 公共化**：本仓当前仍带着 0.1.1 快照下的旧实现，
  已在 2026-09-29 按基座版本（语义令牌肤色 + 去英文双语文案）对齐；下次升级 UI 稳定版时，
  `apps/web/src/components/loomball/**` 应从声明清单中移除以恢复基座托管。

## 4. 维护约定

新增产品层目录（不在声明内）时：

1. 在 `.workloom-ui-governance.json#industryExtensionPaths` 增加对应 glob（`apps/` 前缀、无 `..`）；
2. 同步在本文件 §3 记录用途与归属；
3. 跑 `pnpm test:scripts`、`node scripts/verify-client-foundation-consumer.mjs`、
   `node scripts/verify-ui-consumer.mjs --require-governance-state`。

**不要**把这些路径写进 `.workloom-client-foundation.json`（那是基座下发的受管 state，升级会覆盖），
也不要放宽任何"必备入口 / UI 同版 / 门禁指纹"约束。
