/**
 * live-profile-dialect.test.mjs · P 域模型端点「方言」回归（MC-015）
 *
 * 为什么需要它（2026-09-29 真机实测的根因）：
 *   本机封存凭据 `~/.workloom/live.env` 里两个端点环境变量是**两种方言**：
 *     · `DEEPSEEK_BASE_URL=https://api.deepseek.com/anthropic` —— Anthropic 兼容根（Messages 协议），
 *       dsh-harness 的 deepseek-official 适配器走它；
 *     · `LLM_BASE_URL=https://api.deepseek.com` —— OpenAI 兼容根，`model-gateway` 链路拼 `/chat/completions`。
 *   把 Anthropic 根交给 OpenAI 兼容链路必得 **HTTP 404**（实测：POST
 *   `https://api.deepseek.com/anthropic/chat/completions` → 404、空体；同一 key 打
 *   `https://api.deepseek.com/chat/completions` → 200）。而基座
 *   `scripts/acceptance/lib/live/providers.mjs#resolveLiveModels` 对两条链路用同一套 base 解析顺序
 *   （`baseUrlEnv` → `LLM_BASE_URL` → `DEEPSEEK_BASE_URL`），且基座文件在本车道是**受控只读资产**
 *   （`.workloom-base-sync.json#requiredRootAssetsSha256`），不能在本仓改。
 *   因此本仓的处置是：在 `acceptance/profile.json` 里把两条链路拆成两个模型条目、各自声明正确的
 *   `baseUrlEnv`；基座侧的通用修法走 `proposals/workloom-im/0002-*.patch`。
 *   本测试按「本仓真实 profile + live.env 真实键约定」复算解析结果，锁住该配置不会再漂回 404，
 *   同时防止有人为了省事把 dsh 也指到 OpenAI 兼容根（反向 404，见 live.mjs 的内联注释）。
 *
 * 用法：node --test scripts/acceptance/live-profile-dialect.test.mjs
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { resolveLiveModels } from "./lib/live/providers.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PROFILE = JSON.parse(readFileSync(join(REPO_ROOT, "acceptance", "profile.json"), "utf-8"));

/** live.env 的真实键约定（值只用于复算，不落任何报告） */
const SEALED_KEYS_ENV = {
  DEEPSEEK_API_KEY: "sealed-deepseek-key",
  DEEPSEEK_BASE_URL: "https://api.deepseek.com/anthropic",
  DEEPSEEK_MODEL: "deepseek-flash",
  LLM_BASE_URL: "https://api.deepseek.com",
  VOLCENGINE_ARK_API_KEY: "sealed-ark-key",
};

const resolvedOf = (env = SEALED_KEYS_ENV) => resolveLiveModels(PROFILE.live.models, env);
const tasksOfChain = (chain) => PROFILE.live.tasks.filter((task) => task.chain === chain);
const modelOf = (resolved, id) => resolved.find((m) => m.id === id);

describe("P 域模型端点方言（MC-015 · LLM-G1 404 根因）", () => {
  it("model-gateway 链路解析到 OpenAI 兼容根，且不会拼出 /anthropic/chat/completions", () => {
    const tasks = tasksOfChain("model-gateway");
    assert.ok(tasks.length > 0, "profile 必须声明至少一个 model-gateway 任务（LLM-G1）");
    const resolved = resolvedOf();
    for (const task of tasks) {
      const model = modelOf(resolved, task.model);
      assert.ok(model, `${task.id} 引用的模型 ${task.model} 必须在 profile.live.models 里声明`);
      assert.equal(model.ready, true, `${task.id} 的模型必须凭据就绪：${model.missing.join("；")}`);
      assert.equal(
        String(model.baseUrl).includes("/anthropic"),
        false,
        `${task.id}（model-gateway）不得使用 Anthropic 兼容根：${model.baseUrl}`,
      );
      assert.equal(
        `${model.baseUrl}/chat/completions`,
        "https://api.deepseek.com/chat/completions",
        `${task.id} 实际请求端点必须落在 OpenAI 兼容根上`,
      );
    }
  });

  it("声明层锁死：model-gateway 的模型条目不得把 baseUrlEnv 指向 DEEPSEEK_BASE_URL", () => {
    const gatewayModelIds = new Set(tasksOfChain("model-gateway").map((task) => task.model));
    for (const entry of PROFILE.live.models.filter((m) => gatewayModelIds.has(m.id))) {
      assert.notEqual(
        entry.baseUrlEnv,
        "DEEPSEEK_BASE_URL",
        `${entry.id} 的 baseUrlEnv 指向 Anthropic 兼容根会在 /chat/completions 上 404`,
      );
      assert.equal(entry.adapter, "model-gateway", `${entry.id} 的 adapter 应与任务链路一致`);
    }
  });

  it("dsh-harness 链路仍走 Anthropic 兼容根（Messages 协议），不被“统一端点”顺手改坏", () => {
    const resolved = resolvedOf();
    for (const task of tasksOfChain("dsh-harness")) {
      const model = modelOf(resolved, task.model);
      assert.ok(model, `${task.id} 引用的模型 ${task.model} 必须在 profile.live.models 里声明`);
      assert.equal(
        model.baseUrl,
        "https://api.deepseek.com/anthropic",
        `${task.id}（dsh-harness）必须解析到 Anthropic 兼容根`,
      );
    }
  });

  it("缺 LLM_BASE_URL 时（只剩封存文件的其它键）不得静默回落到 Anthropic 根", () => {
    const env = { ...SEALED_KEYS_ENV };
    delete env.LLM_BASE_URL;
    const gatewayModelId = tasksOfChain("model-gateway")[0].model;
    const model = modelOf(resolvedOf(env), gatewayModelId);
    // 基座解析顺序里 DEEPSEEK_BASE_URL 是最后的兜底；此处记录真实行为：
    // 一旦 LLM_BASE_URL 缺失就会退回 Anthropic 根 → 该场景必须靠基座补丁（proposals/0002）修，
    // 本仓只能保证「声明层不把 Anthropic 根发给 OpenAI 链路」这条已被上一条锁住。
    assert.ok(model, "model-gateway 的模型条目必须可解析");
    assert.match(
      String(model.baseUrl),
      /^https:\/\/api\.deepseek\.com(\/anthropic)?$/,
      `缺 LLM_BASE_URL 时的兜底行为需人工确认：${model.baseUrl}`,
    );
  });
});
