/**
 * 本仓客户端基座门禁的"实验车道产品分叉面"回归。
 *
 * 口径（docs/DEVELOPMENT-PROTOCOL.md §10.3，2026-09-27 起）：仓级行业扩展路径的唯一事实源是
 * **仓内 `.workloom-ui-governance.json` 的 `lane: "experiment"` + `industryExtensionPaths`**
 * （由 rollout 依据基座 `sync/child-repos.json` 写入）。本仓 2026-09-19 自持的
 * `.workloom-client-extensions.json` 机制在 2026-09-29 门禁修复（MC-011）中退场：
 * 它只在本仓 fork 的门禁里有意义，与基座现行门禁重复，且让治理指纹核对长期红灯。
 *
 * 本测试锁定四件事：
 *  ① 未登记实验车道（缺治理文件 / lane 非 experiment）时，受管指纹漂移与非白名单文件必须继续报错
 *     （容差不是默认放宽，fail closed）；
 *  ② 登记后这些路径被当作本仓自有（0 错误），且必备受管入口仍在受管集合里；
 *  ③ 非法声明（越界 / 反斜杠路径）必须报错，不能静默忽略；
 *  ④ 非实验车道（行业仓）不可用该容差。
 */
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { verifyClientFoundationConsumer } from "./verify-client-foundation-consumer.mjs";

const ALLOWED_EXTENSIONS = [
  "apps/*/src/extensions/**",
  "apps/*/src/projections/**",
  "apps/*/src/config/industry/**",
  "apps/*/src/theme/industry/**",
  "apps/*/public/industry/**",
];
const VERSION = "0.1.1";
const roots: string[] = [];
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

/** 造一个"已是基座消费方、但产品层与基座不一致"的最小仓骨架 */
function fixtureRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "wl-growth-foundation-"));
  roots.push(root);
  const files: Record<string, string> = {
    "apps/web/src/main.tsx": 'export const client = "web";\n',
    "apps/webb/src/main.tsx": 'export const client = "webb";\n',
    "apps/webc/src/main.tsx": 'export const client = "webc";\n',
    "apps/webc/public/service-front.config.json": '{"industryProjectionPath":"industry/service-front.config.json"}\n',
    // 受管文件：磁盘内容与 state 指纹不一致（产品层定制）
    "apps/web/src/pages/p1/P1.tsx": 'export const p1 = "growth-own";\n',
    // 非白名单文件（基座快照里没有）
    "apps/web/src/shell/PageExitLink.tsx": 'export const exitLink = true;\n',
  };
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  writeJson(join(root, ".workloom-client-foundation.json"), {
    schemaVersion: "workloom.client-foundation-state/v1",
    baseRepository: "workloom-ai/workloom-im",
    version: VERSION,
    sourceRef: `refs/tags/ui-v${VERSION}`,
    sourceCommit: "a".repeat(40),
    updatePolicy: "upgrade-pr-only",
    clients: { bPc: "apps/web", bMobile: "apps/webb", cMobile: "apps/webc" },
    allowedIndustryExtensionPaths: ALLOWED_EXTENSIONS,
    managedFiles: {
      "apps/web/src/main.tsx": { sha256: sha256(files["apps/web/src/main.tsx"]!), mode: 420 },
      "apps/webb/src/main.tsx": { sha256: sha256(files["apps/webb/src/main.tsx"]!), mode: 420 },
      "apps/webc/src/main.tsx": { sha256: sha256(files["apps/webc/src/main.tsx"]!), mode: 420 },
      "apps/webc/public/service-front.config.json": { sha256: sha256(files["apps/webc/public/service-front.config.json"]!), mode: 420 },
      // 指纹来自基座快照（这里用另一段内容模拟"基座版"）
      "apps/web/src/pages/p1/P1.tsx": { sha256: sha256('export const p1 = "base";\n'), mode: 420 },
    },
  });
  writeJson(join(root, ".workloom-ui.json"), { package: "@workloom/ui", version: VERSION });
  return root;
}

/** 写治理文件（实验车道登记：lane + 行业扩展路径） */
function writeGovernance(root: string, input: { lane?: string; paths?: unknown }): void {
  writeJson(join(root, ".workloom-ui-governance.json"), {
    schemaVersion: "workloom.ui-governance-state/v1",
    dependency: "npm:typescript@5.9.3",
    yamlDependency: "npm:yaml@2.9.0",
    updatePolicy: "stable-upgrade-pr-only",
    lane: input.lane ?? "experiment",
    industryExtensionPaths: input.paths ?? ["apps/*/src/pages/**", "apps/*/src/shell/**"],
    files: {},
  });
}

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("客户端基座门禁 · 实验车道产品分叉声明", () => {
  it("没有治理文件时：指纹漂移与非白名单文件继续报错（fail closed）", () => {
    const errors = verifyClientFoundationConsumer(fixtureRepo());
    expect(errors.some((error) => error.includes("指纹漂移：apps/web/src/pages/p1/P1.tsx"))).toBe(true);
    expect(errors.some((error) => error.includes("非白名单行业文件：apps/web/src/shell/PageExitLink.tsx"))).toBe(true);
  });

  it("登记 lane=experiment + 扩展路径后：0 错误，且必备受管入口仍在受管集合内", () => {
    const root = fixtureRepo();
    writeGovernance(root, {});
    expect(verifyClientFoundationConsumer(root)).toEqual([]);

    // 必备入口仍是受管文件：把它删掉必须报错（防止用声明把基座入口一并豁免）
    rmSync(join(root, "apps/webb/src/main.tsx"));
    const errors = verifyClientFoundationConsumer(root);
    expect(errors.some((error) => error.includes("apps/webb/src/main.tsx"))).toBe(true);
  });

  it("非实验车道（行业仓）不可用该容差：lane=industry 仍报分叉", () => {
    const root = fixtureRepo();
    writeGovernance(root, { lane: "industry" });
    const errors = verifyClientFoundationConsumer(root);
    expect(errors.some((error) => error.includes("指纹漂移：apps/web/src/pages/p1/P1.tsx"))).toBe(true);
    expect(errors.some((error) => error.includes("非白名单行业文件：apps/web/src/shell/PageExitLink.tsx"))).toBe(true);
  });

  it("非法声明路径（越界 / 反斜杠）必须报错，不能静默忽略", () => {
    const root = fixtureRepo();
    writeGovernance(root, { paths: ["apps/../etc/**", "apps\\web\\src\\pages\\**"] });
    const errors = verifyClientFoundationConsumer(root);
    expect(errors.filter((error) => error.includes("仓级行业扩展路径非法")).length).toBe(2);
  });
});
