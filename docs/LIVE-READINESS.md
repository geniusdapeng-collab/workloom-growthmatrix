# 真实发布与图文产能就绪说明（MC-010）

> 目的：把「真实发布 / 图文日更产能」从口头承诺变成**可机器判定**的档位条件。
> 门禁：`node scripts/ci/env-tier.mjs`（档位前置条件）+ `pnpm publish:evidence`（发布回执可核验）
> 相关规范：`docs/REAL-DEVICE-ACCEPTANCE-SPEC.md`（P 域生产实测口径，RDAS v3.1 §19）

## 1. 三档定义与判定方式

| 档位 | 含义 | 机器判定 |
|---|---|---|
| `local-preview` | 本机预览：本地库 + `LLM_PROVIDER=mock` + dry-run 发布。证明「代码与装配」，**不构成生产实测证据** | `node scripts/ci/env-tier.mjs --tier local-preview` |
| `client-runtime` | 真实客户端：已安装桌面客户端运行时（自持 PG/NATS）+ 真实模型凭据 + 桌面发布驱动 | `node scripts/ci/env-tier.mjs --tier client-runtime` |
| `deployed` | 生产部署：客户可访问的正式地址 + 正式库（默认只读，写入需显式授权） | `node scripts/ci/env-tier.mjs --tier deployed` |

档位不是标签而是断言：声明 `client-runtime` / `deployed` 时，以下条件缺一项即 **fail-closed**（退出码 1，且结论不得对外使用）。

| 检查项 | local-preview | client-runtime | deployed |
|---|---|---|---|
| `LLM_PROVIDER` 非 mock/stub/fake | 允许（告警） | 必需 | 必需 |
| 内置模型凭据（`DEEPSEEK_API_KEY` / `LLM_API_KEY`） | 允许缺失 | 必需 | 必需 |
| 图文产能密钥（`VOLCENGINE_ARK_API_KEY` → Seedream） | 允许缺失 | 必需 | 必需 |
| 视频产能密钥（`VOLCENGINE_ARK_API_KEY` → Seedance） | 允许缺失 | 必需 | 必需 |
| `PUBLISH_DRIVER=desktop` | 允许 dry-run | 必需 | 必需 |
| `PUBLISH_TEST_FENCE_OVERRIDE` 未开启 | 允许（告警） | 必需 | 必需 |
| `ops/publish-accounts.json` 至少 1 个 30 天内核验的已登录账号 | 不适用 | 必需 | 必需 |
| 客户端 harness（`packages/runtime/dsh-gate/node_modules/.bin/dsh`） | 告警 | 必需 | 必需 |
| `DATABASE_URL` | 告警 | 必需 | 必需 |
| `NODE_ENV=production` | 不适用 | 不适用 | 必需 |
| 数据库非本机 | 不适用 | 不适用 | 必需 |

## 2. 本机实测档位（2026-09-29，A 级）

对已安装的桌面客户端运行时（`~/Library/Application Support/WorkLoom 织元/runtime`，VERSION `v0.1.1`）按其 `runtime/.env` 实测 `client-runtime`：

```
✓ tier.declared       档位 client-runtime
✗ llm.provider        LLM_PROVIDER=mock（mock 链路不得用于真实档位）
✗ llm.credential      缺少 DEEPSEEK_API_KEY / LLM_API_KEY
✗ capacity.image      缺少 VOLCENGINE_ARK_API_KEY（Seedream 出图）
✗ capacity.video      缺少 VOLCENGINE_ARK_API_KEY（Seedance 出视频）
✗ publish.driver      PUBLISH_DRIVER=(空)，要求 desktop
✓ publish.fence-override  未开启测试围栏放行
✗ publish.accounts    缺少 ops/publish-accounts.json
✓ runtime.dsh-harness dsh 已安装
✓ env.database        DATABASE_URL 已配置
结论：不满足（6 项阻断）
```

同时本机存在仓库外密钥文件 `~/.workloom/live.env`（权限 `600`，键：`DEEPSEEK_API_KEY` / `DEEPSEEK_BASE_URL` / `DEEPSEEK_MODEL` / `LLM_BASE_URL` / `SEEDANCE_MODEL` / `SEEDREAM_MODEL` / `VOLCENGINE_ARK_API_KEY`），可支撑 RDAS P 域模型任务实测：

```bash
pnpm acceptance:live --keys-file ~/.workloom/live.env --env client-runtime --require-live
```

**结论（诚实口径）**：本机可以跑「真实模型 + 真实出图/出视频」的 P 域实测，但**发布链路仍停在 dry-run**——客户端运行时未配置桌面发布驱动与平台登录声明，因此「真实发布」结论不成立。

## 3. 真实发布（六平台）现状与本档位要求

发布链路：`publish_tasks` 入队 → G9 围栏预检（`publish.execute`，非 `auto` 即挂起待审）→ 单账号日上限（默认 5）→ 登录态检测 → 适配器上传 → 回执探测 → 事件落账（无回执 = 未核实）。

| 平台 | 适配器状态（代码事实） | 真实发布前置 |
|---|---|---|
| `douyin` | 参考实现（`packages/base/publish-rpa/adapters/douyin.ts`） | 桌面客户端本人登录 + `PUBLISH_DRIVER=desktop` + 人审放行 |
| `xiaohongshu` | 参考实现 | 同上（图文主阵地，优先级最高） |
| `bilibili` | 参考实现 | 同上 |
| `youtube` | 参考实现 | 同上 + 网络与合规前置 |
| `shipinhao` | 占位壳（无真实上传实现） | 先实现适配器，禁止提前声明可发布 |
| `tiktok` | 占位壳 | 同上 |

硬性纪律（代码已实现，不需要额外开关）：

1. **演练与真实分明**：dry-run 驱动的回执被强制改写为 `synced:false` + `mode:"dry-run"`，并追加更正事件（`publish.dryrun_receipt_corrected`）。
2. **测试围栏放行只在非生产有效**：`PUBLISH_TEST_FENCE_OVERRIDE=1` 仅在 `NODE_ENV!=production` 且驱动为 dry-run 时生效；`client-runtime` / `deployed` 档位下门禁直接判失败。
3. **回执可核验**：`pnpm publish:evidence` 扫描 `status='succeeded'` 的发布任务，回执必须含 `platformPostId` 或 `url`，且不得是 dry-run；否则退出码 1。

## 4. 图文日更产能（主场景 1）需要什么

| 环节 | 现状 | 补齐动作 | 判定 |
|---|---|---|---|
| 素材库（房型/餐饮/设施/活动实拍） | 仓内无客户素材；素材寻源岗的图库检索工具未接线（已显式登记缺口） | 客户提供实拍，或接线检索通道产出候选清单 | 素材清点产出 ≥N 张可用原图 |
| 文案与选题 | 行业包技能与管线齐备（内容日历、选题研究、平台规格注册表） | 无需改造，按行业包执行 | `pnpm suite` 471/471 |
| 出图通道 | 代码齐备，缺 `VOLCENGINE_ARK_API_KEY`（Seedream） | 在客户端运行时或本机密钥文件配置 | `env-tier --tier client-runtime` 的 `capacity.image` 通过 |
| 合规审核 | AI 标识 / 极限词 / 肖像授权围栏已实现 | 按围栏执行，挂起项人审 | 事件账本留痕 |
| 发布 | dry-run（平台账号未登录） | 桌面客户端登录 + `PUBLISH_DRIVER=desktop` + 账号声明 | `publish.accounts` 通过 + `pnpm publish:evidence` 通过 |
| 数据回收 | 连接器可检查（`pnpm connectors:check`），缺社媒开放平台凭据 | 配置 `DOUYIN_ACCESS_TOKEN` 等 | 连接器 ready |

## 5. 命令清单

```bash
# 档位自检（本仓默认 local-preview；声明真实档位就必须满足条件）
node scripts/ci/env-tier.mjs --tier local-preview
node scripts/ci/env-tier.mjs --tier client-runtime
node scripts/ci/env-tier.mjs --describe            # 打印完整条件矩阵

# 发布回执可核验（连库）
pnpm publish:evidence
pnpm publish:evidence -- --workspace ws-geo --json

# 连接器就绪（缺凭据 fail-closed，不回退 mock）
pnpm connectors:check

# P 域生产实测（真实模型 + 配额硬闸；不带 --require-live 时 blocked 不阻断）
pnpm acceptance:live --keys-file ~/.workloom/live.env --env client-runtime
pnpm acceptance:live --keys-file ~/.workloom/live.env --env client-runtime --require-live

# 单任务复跑（模型网关链路，MC-015；端点方言回归见 §8）
node scripts/acceptance/live.mjs --env client-runtime --keys-file ~/.workloom/live.env --tasks LLM-G1 --require-live

# 结构回归（与档位无关，始终应通过）
pnpm suite && pnpm release:gate
```

## 6. 仍属外部依赖（本仓无法自行闭环）

1. **平台账号登录**：抖音 / 小红书 / B 站 / YouTube 的登录态只能在用户本人的桌面客户端完成（凭据只存本机，不入库、不进日志）。
2. **云渲染与出图密钥**：Seedream / Seedance 需要火山方舟密钥；`client-runtime` 档位要求写入客户端运行时配置。
3. **客户素材**：房型与实拍素材由客户提供；无素材时链路只能产出缺口报告，不得编造。
4. **社媒开放平台凭据**：评论与指标回收依赖开放平台授权（`DOUYIN_ACCESS_TOKEN` 等）。
5. **占位平台适配器**：视频号 / TikTok 需先实现适配器再接账号。

## 7. 判定口径（防止误读）

- 只有 `env-tier` 对应档位**全部阻断项通过**、且 `publish.evidence` 通过，才可以写「本仓具备真实发布能力」；
- `--selftest` 与 dry-run 报告一律标注「非生产实测证据」；
- 任何「已发布」结论必须能指到 `publish_tasks.receipt` 里的平台帖 ID/URL；
- 本文件是就绪说明，不是能力承诺；状态变更以命令输出为准（`--json` 可归档）。

## 8. 模型端点「方言」与 P 域 LLM-G1（MC-015，2026-09-29）

### 8.1 现象与根因（A 级）

`LLM-G1`（`chain: model-gateway`）在本机实测里长期 `failed / 调用失败：HTTP 404：`（空体）。
根因不是客户端运行时未安装，而是**端点方言错配**：封存凭据里两个变量分属两种协议面，
而基座 `scripts/acceptance/lib/live/providers.mjs#resolveLiveModels` 对 `dsh-harness` 与
`model-gateway` 用了同一套 base 解析，于是把 Anthropic 兼容根交给了 OpenAI 兼容调用。

| 变量 | 值 | 方言 | 链路 |
|---|---|---|---|
| `DEEPSEEK_BASE_URL` | `https://api.deepseek.com/anthropic` | Anthropic 兼容（Messages 协议） | `dsh-harness` |
| `LLM_BASE_URL` | `https://api.deepseek.com` | OpenAI 兼容（`/chat/completions`） | `model-gateway` |

```
POST https://api.deepseek.com/anthropic/chat/completions  → 404（空体）   # 修复前 LLM-G1 打的就是这条
POST https://api.deepseek.com/chat/completions            → 200（model=deepseek-flash）
```

### 8.2 本仓修法（声明层，不动受控只读资产）

`scripts/acceptance/live.mjs`、`.../lib/live/providers.mjs` 属基座受控只读资产
（`.workloom-base-sync.json#requiredRootAssetsSha256`），本仓不得就地修改；因此把两条链路
拆成两个模型条目、各自声明正确的端点变量：

```json
{ "id": "deepseek-v4.1-flash-gateway", "kind": "llm", "model": "deepseek-flash",
  "adapter": "model-gateway", "apiKeyEnv": "DEEPSEEK_API_KEY", "baseUrlEnv": "LLM_BASE_URL" }
```

- `acceptance/profile.json`：新增上述条目，`LLM-G1.model` 指向它；
- 回归：`scripts/acceptance/live-profile-dialect.test.mjs`（4 例，`node --test`，已进 `pnpm test:scripts`）——
  锁住 `model-gateway` 不落 `/anthropic`、`dsh-harness` 仍走 Anthropic 根；
- 基座通用修法（含归一函数 + 8 例单测）：`proposals/workloom-im/0002-acceptance-live-model-gateway-dialect.md`
  （补丁已在一次性临时树 `git apply --check` 通过，本仓不代推基座）。

### 8.3 修复后证据（2026-09-29 真实调用）

```bash
node scripts/acceptance/live.mjs --env client-runtime --keys-file ~/.workloom/live.env \
  --tasks LLM-G1 --require-live --out outputs/acceptance/live-mc015
# → [acceptance:live] ✓ LLM-G1 ok；结论：pass；exit 0
```

回执：`{kind:"model-gateway", endpoint:"https://api.deepseek.com/chat/completions",
model:"deepseek-flash", tokens:149, synced:true}`（报告 `outputs/acceptance/live-mc015/live-report.md`）。

### 8.4 仍未闭环（外部依赖，不在 §8 修复范围）

- `pnpm env:readiness` 仍 6 项阻断：客户端运行时 `LLM_PROVIDER=mock`、模型/出图密钥未注入客户端
  `runtime/.env`、`PUBLISH_DRIVER` 未设 `desktop`、`ops/publish-accounts.json` 缺平台登录声明；
- 客户端运行时 `install-state.json` 仍为 `failed/recovery`（2026-09-19 的 PG 端口占用，**与 LLM-G1 无关**），
  `127.0.0.1:9207` 未拉起 → 影响的是 `PROD-01` 产品派单与真实发布，不是模型网关任务；
- 平台登录态 / 客户素材 / 真实发布：需人工提供（§6）。
