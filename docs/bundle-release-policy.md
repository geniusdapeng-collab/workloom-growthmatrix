# 行业包版本与发布治理（B-76）

> 制定日期：2026-09-24｜适用：本仓三个行业包（`hotel` / `ai-video` / `geo-growth`）
> 相关实现：`scripts/bundle-governance.mts`（门禁/发布）、`packages/industry-contract`（契约）、
> `packages/base/bundles/assembly.ts`（装载期验签）、`build/bundle-trust.json`（公钥环）

## 1. 版本口径

| 变更类型 | 版本位 | 例子 | 判定 |
|---|---|---|---|
| 资产内容修正、文档、注释 | PATCH | 3.4.0 → 3.4.1 | 不改契约、不改判定面 |
| 新增岗位/技能/围栏规则/对象/管线/内容包 | MINOR | 1.0.0 → 1.1.0 | 只增不改；旧能力语义不变 |
| 契约槽位、判定口径放宽、破坏性字段变更 | MAJOR | 2.x | 需提案 + L4 放行 + 迁移方案 |

规则：
1. `bundle.json#version` 与 `CHANGELOG.md` 必须同批提交（`pnpm bundle:governance --check` 校验签名与摘要）；
2. 任何对外可观察资产变化都要进 CHANGELOG（写清"新增/变更/兼容性"三段）；
3. 主包依赖用**精确版本**（`dependencies[].version`），不允许范围版本——发布后不得漂移。

## 2. 稳定态的充分条件

`workloom.status = stable` 的包在**装载期强制验签**（`verifyStableBundleSignature`）：
签名缺失、密钥被吊销、公钥不在信任环、摘要不符，任一情况直接拒绝装载（fail-closed）。
因此切稳定态必须同时满足：

1. 三个包（主包 + 其依赖）**全部** stable——"稳定主包不能组合未稳定依赖"；
2. 每个包都有 `integrity.signature`（ed25519）+ 已重算的 `integrity.digest` 与 `assets`；
3. 公钥环 `build/bundle-trust.json` 已包含对应 `keyId` 且未被吊销；
4. 门禁全绿：`pnpm bundle:governance --release`（含发布验签）。

## 3. 签名与密钥托管（规划）

| 项 | 口径 |
|---|---|
| 算法 | ed25519（`integrity.signature.algorithm`） |
| 签名对象 | `canonicalBundleArtifactPayload(manifest, assets)` 的 sha256 摘要 |
| keyId | 公钥 SPKI PEM 的 sha256 前 16 位（`ed25519-<hex>`），随签名与公钥环公开 |
| 私钥存放 | **只放受控秘密存储**，环境变量 `BUNDLE_SIGNING_PRIVATE_KEY` 注入（PKCS8 PEM）；绝不入库、入仓、入日志 |
| 公钥环 | `build/bundle-trust.json`（位于 `bundles/` 之外，可作为独立受签名资源分发）或 `BUNDLE_VERIFICATION_KEYS` 内联注入 |
| 轮换 | 新 keyId 先加入公钥环 → 用新钥重签并发布 → 观察一个发布周期 → 旧钥进 `revoked`（撤销后其包一律拒绝装载） |
| 撤销演练 | 把 keyId 写入 `revoked` 后重跑 `pnpm bundle:governance`，预期失败（拒绝装载）——撤销是安全动作，宁拒绝不放行 |
| 本机开发钥 | `~/.workloom/keys/bundle-signing-dev.pem`（600，仓库外），keyId 记于 `~/.workloom/keys/bundle-signing-dev.keyid`；**仅供本机演示/门禁演练**，生产必须换成托管密钥 |

发布命令（CI/发布机）：

```bash
export BUNDLE_SIGNING_PRIVATE_KEY="$(cat /path/to/ed25519-pkcs8.pem)"   # 来自秘密存储
export BUNDLE_SIGNING_KEY_ID="ed25519-xxxxxxxxxxxxxxxx"
pnpm --dir . exec tsx scripts/bundle-governance.mts --release --refresh-digests
pnpm --dir . exec tsx scripts/bundle-governance.mts --release            # 复跑校验（含验签）
```

## 4. 回滚

| 场景 | 动作 | 依据 |
|---|---|---|
| 新版本装载异常 | 回滚到上一稳定版本制品 + 重算/重签（私钥仍在托管） | 版本号只增：回滚=发布新 PATCH 版本指向旧内容 |
| 摘要被篡改 | 装载期直接拒绝（`INTEGRITY_FAILED`） | 验签 + 逐资产摘要 |
| 密钥泄漏 | 立即把 keyId 加入 `revoked` 并重签发布 | 撤销后旧钥签名的包一律拒载 |
| 围栏被放宽 | 仅允许经 **L4 董事长级** 放行的放宽（`activateRuleVersion` 双闸门），只增不改留痕 | B-74 演练修复；见 `packages/base/fence-engine/lifecycle.ts` |

## 5. 当前状态（2026-09-24）

- `geo-growth 1.1.0`（candidate → **stable**，含协作围栏包/模板化协作规则/首日上岗内容包/blackboard_entry 对象）；
- `hotel 3.4.0`、`ai-video 1.0.0` 同批切 **stable**（稳定主包不得依赖未稳定包）；
- 三包均已签名：keyId `ed25519-12613d8b27999511`（本机开发钥，生产需轮换为托管钥）；
- 回滚演练：`pnpm drill:backup` 五条路径全过，报告见 `docs/reports/backup-drill.md`。
