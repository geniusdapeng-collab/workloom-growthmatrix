/**
 * 工具声明一致性守护回归（TOOL-DECL-01）。
 * 背景：`material-scout` 声明 `visualread.search_stock` 但桥白名单没有它——调用必被拒（软失败→未核实）；
 *       `bgm-composer` 需要的 `bgmwrite.tag`/`bgmwrite.library` 桥本体已实现、客户端白名单却漏登记。
 * 本测试锁死：两类漂移都必须被检出，且当前真实仓库树必须零漂移。
 */
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  buildNamespaceIndex,
  checkDeclarations,
  collectDeclaredTools,
  namespaceOf,
} from "./check-tool-declarations.mjs";

const REPO_ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");

describe("命名空间与索引（TOOL-DECL-01）", () => {
  it("命名空间取点号前一段；无点号时整串即命名空间", () => {
    expect(namespaceOf("visualread.search_stock")).toBe("visualread");
    expect(namespaceOf("bgmwrite.tag")).toBe("bgmwrite");
    expect(namespaceOf("plainTool")).toBe("plainTool");
  });

  it("同一命名空间跨连接器取并集", () => {
    const index = buildNamespaceIndex({
      a: ["visualread.health"],
      b: ["visualread.assets", "visualwrite.compose"],
    });
    expect(index.visualread).toEqual(["visualread.assets", "visualread.health"]);
    expect(index.visualwrite).toEqual(["visualwrite.compose"]);
  });
});

describe("漂移检测（TOOL-DECL-01）", () => {
  it("声明了已被接管命名空间里不存在的工具 → 违规（历史缺陷：visualread.search_stock）", () => {
    const declared = [{ bundle: "geo-growthmatrix", preset: "material-scout", tool: "visualread.search_stock" }];
    const r = checkDeclarations(declared, { "geo/visual": ["visualread.health", "visualwrite.fetch_stock"] }, {});
    expect(r.violations).toHaveLength(1);
    expect(r.violations[0]!.tool).toBe("visualread.search_stock");
    // 违规信息只列出「同命名空间」的白名单（visualwrite.* 属另一个命名空间，不在此列）
    expect(r.violations[0]!.allowed).toEqual(["visualread.health"]);
    expect(r.executorGaps).toHaveLength(0);
  });

  it("桥本体已实现但客户端白名单未放行 → executorGaps（历史缺陷：bgmwrite.tag/library）", () => {
    const r = checkDeclarations([], { "ai-video/bgm-bridge": ["bgmwrite.mix"] }, { "ai-video/bgm-bridge": ["bgmwrite.mix", "bgmwrite.tag", "bgmwrite.library"] });
    expect(r.executorGaps.map((g) => g.tool)).toEqual(["bgmwrite.tag", "bgmwrite.library"]);
  });

  it("未接线命名空间只提示不红灯（与「未核实」语义一致）", () => {
    const declared = [{ bundle: "geo-growthmatrix", preset: "growth-lead", tool: "growth.plan.write" }];
    const r = checkDeclarations(declared, { "geo/visual": ["visualread.health"] }, {});
    expect(r.violations).toHaveLength(0);
    expect(r.executorGaps).toHaveLength(0);
    expect(r.unwired).toHaveLength(1);
  });
});

describe("真实仓库树（TOOL-DECL-01）", () => {
  it("全仓 85 个岗位的工具声明与执行面双向一致（零违规、零漏登记）", () => {
    const declared = collectDeclaredTools(REPO_ROOT);
    expect(declared.length).toBeGreaterThanOrEqual(300);
    const r = checkDeclarations(declared);
    expect(r.totalPresets).toBeGreaterThanOrEqual(80);
    expect(r.violations).toEqual([]);
    expect(r.executorGaps).toEqual([]);
    // 未接线仍应被如实统计（不是红灯，但不能为 0——否则说明统计面失效）
    expect(r.unwired.length).toBeGreaterThan(0);
  });
});
