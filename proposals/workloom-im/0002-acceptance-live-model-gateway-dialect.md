# 基座提案：P 域 model-gateway 链路的端点方言分流（workloom-im）

> **状态：待基座维护方裁决（2026-09-29）**。同目录 `0002-acceptance-live-model-gateway-dialect.patch`
> 是针对基座 `HEAD`（本地克隆 `workloom-im@95cf8ff`，文件 `scripts/acceptance/lib/live/providers.mjs`）
> 生成的待实施补丁，已在一次性临时树上 `git apply --check` 通过并跑了单测（8/8）。
> 本仓（`WorkLoom-growthmatrix` 隔离实验车道）**未**改动该受控只读资产
> （`scripts/acceptance/lib/live/providers.mjs` 在 `.workloom-base-sync.json#requiredRootAssetsSha256`
> 的 35 项里），本仓侧只做了 profile 声明层的等价规避（见文末）。
>
> 提案人：WorkLoom-growthmatrix 排雷任务 `T-2026-0929-0001`（问题卡 MC-015 / MC-018）
> 目标：让 `model-gateway` 链路在**任何**按现行封存凭据约定配置的仓库里都能跑通，
> 而不是把「断言永远 404」当成被测产品的缺陷。

## 1. 现象与根因（A 级 · 本机真实调用实测）

`node scripts/acceptance/live.mjs --env client-runtime --keys-file ~/.workloom/live.env --tasks LLM-G1 --require-live`
在 growthmatrix 上稳定失败：

| 任务 | 链路 | 状态 | 原因 |
|---|---|---|---|
| LLM-G1 | `model-gateway` | failed | `调用失败：HTTP 404：`（空体，1.2s） |

同一份封存凭据 `~/.workloom/live.env` 里，两个端点变量是**两种协议方言**：

| 变量 | 值 | 方言 | 谁在用 |
|---|---|---|---|
| `DEEPSEEK_BASE_URL` | `https://api.deepseek.com/anthropic` | Anthropic 兼容（Messages 协议，`<root>/v1/messages`） | `dsh-harness`（`deepseek-official` 适配器） |
| `LLM_BASE_URL` | `https://api.deepseek.com` | OpenAI 兼容（`<root>/chat/completions`） | `model-gateway` / 产品 model-router / 各行业脚本 |

实测复现（同一 key，2026-09-29，本机）：

```
POST https://api.deepseek.com/anthropic/chat/completions  → 404（空体）      # ← LLM-G1 走的正是这条
POST https://api.deepseek.com/chat/completions            → 200（model=deepseek-flash）
```

根因在基座 `scripts/acceptance/lib/live/providers.mjs#resolveLiveModels`：两条链路共用同一套 base 解析

```js
if (adapter === "dsh-harness" || adapter === "model-gateway") {
  const base = pickEnv([...(m.baseUrlEnv ? [m.baseUrlEnv] : []), ...DSH_DEEPSEEK_DEFAULTS.fallbackBaseEnvs], env);
  resolved.baseUrl = base.value ?? DSH_DEEPSEEK_DEFAULTS.baseURL;
```

而 `DSH_DEEPSEEK_DEFAULTS.fallbackBaseEnvs = ["LLM_BASE_URL", "DEEPSEEK_BASE_URL"]` 只是**取值顺序**，
没有任何方言判别。于是任何仓库只要按现行约定声明 `baseUrlEnv: DEEPSEEK_BASE_URL`（或让
`LLM_BASE_URL` 缺席），`model-gateway` 就会把 Anthropic 根交给 `/chat/completions`——
**该断言在任何环境下都永远无法通过**，与「客户端是否安装/被测量产品是否有缺陷」无关。

仓库内既有口径其实早已写明这两条链路的端点必须分开（`scripts/acceptance/live.mjs` 内联注释、
`scripts/tools/explainer-run.mts` 的 base 归一），只是 `resolveLiveModels` 没有跟进。

## 2. 影响面

- 所有跑 P 域（RDAS v3.1 §18.3 四链路）的仓库：`model-gateway` 任务（默认矩阵里的 `LLM-G1`）会假红；
- 报告会把假红写成「调用失败：HTTP 404」，误导排雷/验收结论（growthmatrix 上就曾被归因成
  「客户端运行时未安装」，实际与客户端无关）；
- 反向风险同样存在：若有人为了让 `model-gateway` 过而把 `DEEPSEEK_BASE_URL` 改成 OpenAI 根，
  `dsh-harness`（Messages 协议）会转红——两条链路的端点**必须**分开表达。

## 3. 提案（最小改动，行业零词汇）

补丁 `0002-acceptance-live-model-gateway-dialect.patch` 只动两处 + 新增 1 个单测：

1. 新增 OpenAI 兼容根变量表与归一函数：

   ```js
   export const OPENAI_COMPATIBLE_BASE_ENVS = ["LLM_BASE_URL", "OPENAI_BASE_URL", "OPENAI_API_BASE", "DEEPSEEK_BASE_URL"];

   /** `<root>/anthropic` 的 OpenAI 兼容面在 `<root>`（与 tools/explainer-run.mts 同口径） */
   export function normalizeOpenAiCompatibleBaseUrl(value) {
     const text = String(value ?? "").trim();
     if (!text) return "";
     return text.replace(/\/+$/u, "").replace(/\/anthropic$/u, "");
   }
   ```

2. `resolveLiveModels` 按**链路方言**分流，并保留原语义（缺端点不阻断、缺凭据仍 blocked）：

   ```js
   const declaredBase = pickEnv([...(m.baseUrlEnv ? [m.baseUrlEnv] : []), ...DSH_DEEPSEEK_DEFAULTS.fallbackBaseEnvs], env);
   const openAiBase = pickEnv([
     ...(m.openAiBaseUrlEnv ? [m.openAiBaseUrlEnv] : []),
     ...OPENAI_COMPATIBLE_BASE_ENVS,
     ...(m.baseUrlEnv ? [m.baseUrlEnv] : []),
     ...DSH_DEEPSEEK_DEFAULTS.fallbackBaseEnvs,
   ], env);
   resolved.baseUrl = adapter === "model-gateway"
     ? normalizeOpenAiCompatibleBaseUrl(openAiBase.value ?? DSH_DEEPSEEK_DEFAULTS.baseURL)
     : declaredBase.value ?? DSH_DEEPSEEK_DEFAULTS.baseURL;
   resolved.baseUrlDialect = adapter === "model-gateway" ? "openai" : "anthropic";
   ```

   - 归一时写一条 `warnings`（进报告 `models[].warnings`），不静默改写；
   - profile 可显式声明 `openAiBaseUrlEnv`（优先级最高）；
   - `runChatTask` 里再兜底归一一次，避免 profile 直接把 Anthropic 根声明给 `model-gateway`。

3. 新增 `scripts/acceptance/lib/live/providers.test.mjs`（8 例，`node --test`）：归一函数、
   变量优先级、`model-gateway` 不落 `/anthropic`、`dsh-harness` 不被顺手改坏、缺端点默认值、
   缺凭据仍 blocked。**建议同时加进 `package.json#test:scripts` 的 `node --test` 列表**（补丁不含该行，避免与各仓 package.json 冲突）。

## 4. 验证（A 级）

- 补丁在一次性临时树上 `git apply --check` 通过，应用后 `node --test providers.test.mjs` → **8/8 通过**；
- 以本仓真实 `acceptance/profile.json` + 本机封存凭据复算：`model-gateway` 解析为
  `https://api.deepseek.com` → 实际请求 `https://api.deepseek.com/chat/completions`；
- 端到端：本仓用 profile 声明层等价修复后，LLM-G1 真实调用 **ok**（回执
  `{kind:"model-gateway", endpoint:"https://api.deepseek.com/chat/completions", model:"deepseek-flash", tokens:149, synced:true}`，
  报告 `outputs/acceptance/live-mc015/live-report.md`）。

## 5. 本仓（隔离实验车道）本轮的处置

受控只读资产不可就地修改（改名/同步契约第 3 条：`requiredRootAssetsSha256` 命中文件按上游原字节落盘），
故本仓只在**声明层**做等价修复，并等基座补丁下发后自动兼容（`openAiBaseUrlEnv` 是可选字段）：

```json
{ "id": "deepseek-v4.1-flash-gateway", "kind": "llm", "model": "deepseek-flash",
  "adapter": "model-gateway", "apiKeyEnv": "DEEPSEEK_API_KEY", "baseUrlEnv": "LLM_BASE_URL" }
```

配套本仓回归：`scripts/acceptance/live-profile-dialect.test.mjs`（4 例，锁住 profile 不再漂回 404，
并锁住 `dsh-harness` 仍走 Anthropic 根）。

## 6. 回滚与风险

- 纯增量：无端点变量时行为不变（仍退回内置默认 `https://api.deepseek.com`）；有端点变量时只影响
  `model-gateway` 的 base 选择，`dsh-harness` 路径逐字未动；
- 归一规则只剥 `…/anthropic` 与尾斜杠，不触碰其它路径前缀（如 `/openai/v1`）；
- 若某仓确实把 OpenAI 兼容网关挂在 `…/anthropic` 下（未见先例），`openAiBaseUrlEnv` 可显式覆盖。
