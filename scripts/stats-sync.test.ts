/**
 * B-66 统计口径脚本化 · 门禁用例：
 *  ① `pnpm capabilities --check` 必须通过（README 统计块 / 围栏包头计数 / 能力产物三处同门禁）；
 *  ② README 统计块与围栏包头部计数注释真实存在，且数字与实物口径一致（独立重算交叉验证）；
 *  ③ 篡改一个围栏包头部计数 → check 必须报漂移（证明门禁不是摆设）。
 */
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import YAML from "yaml";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const run = (args: string[]): { ok: boolean; out: string } => {
  try {
    const out = execFileSync(process.execPath, [join(ROOT, "scripts/generate-capabilities.mjs"), ...args], {
      cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    });
    return { ok: true, out };
  } catch (error) {
    const e = error as { stdout?: string; stderr?: string; status?: number };
    return { ok: false, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
};

describe("B-66 统计口径脚本化", () => {
  it("capabilities --check 通过（README 统计块 + 围栏包头计数 + 能力产物一致）", () => {
    const r = run(["--check"]);
    expect(r.ok, r.out).toBe(true);
  });

  it("README 统计块数字与围栏包实物独立重算一致", () => {
    const readme = readFileSync(join(ROOT, "README.md"), "utf8");
    const block = /<!-- STATS:BEGIN -->([\s\S]*?)<!-- STATS:END -->/.exec(readme)?.[1] ?? "";
    expect(block.length).toBeGreaterThan(0);
    // 独立重算：三包围栏规则总数 + 模板派生数
    let rules = 0;
    const bundleDirs = readdirSync(join(ROOT, "bundles"));
    for (const bundleId of bundleDirs) {
      const fencesDir = join(ROOT, "bundles", bundleId, "fences");
      let files: string[] = [];
      try { files = readdirSync(fencesDir).filter((f) => f.endsWith(".yml") && !f.includes("patch")); } catch { continue; }
      for (const file of files) {
        const doc = YAML.parse(readFileSync(join(fencesDir, file), "utf-8")) as { rules?: unknown[]; fences?: unknown[] };
        rules += [...(doc.rules ?? []), ...(doc.fences ?? [])].length;
      }
    }
    const templateRules = (YAML.parse(readFileSync(join(ROOT, "packages/base/bundles/templates/internal-collaboration.yml"), "utf-8")) as { rules?: unknown[] }).rules?.length ?? 0;
    expect(block).toContain(`围栏规则 | ${rules + templateRules} 条`);
    expect(block).toContain("数字员工岗位定义");
    // 组合去重口径以生成器实测为准（本仓 2026-09-25 实测 80 岗 / 遮蔽 5 处；历史 78 → 79 → 80，
    // 最近一次变化来自 bundles/ai-video/presets/cover-designer.yml）
    expect(block).toContain("组合去重后 80 岗");
    for (const bundleId of ["hotel", "geo-growth", "ai-video"]) {
      const fencesDir = join(ROOT, "bundles", bundleId, "fences");
      const files = readdirSync(fencesDir).filter((f) => f.endsWith(".yml") && !f.includes("patch"));
      for (const file of files) {
        const text = readFileSync(join(fencesDir, file), "utf-8");
        const m = /# workloom:stats:begin[\s\S]*?# 本包 (\d+) 条规则（基线 (\d+) 条）[\s\S]*?# workloom:stats:end/.exec(text);
        expect(m, `${bundleId}/${file} 缺统计头注释`).toBeTruthy();
        const doc = YAML.parse(text) as { rules?: unknown[]; fences?: unknown[] };
        const actual = [...(doc.rules ?? []), ...(doc.fences ?? [])].length;
        expect(Number(m![1]), `${bundleId}/${file} 统计头与实际规则数不一致`).toBe(actual);
      }
    }
  });

  it("篡改围栏包头部计数 → check 报漂移（门禁非摆设）", () => {
    const file = join(ROOT, "bundles/hotel/fences/hotel-baseline.yml");
    const original = readFileSync(file, "utf-8");
    try {
      writeFileSync(file, original.replace(/# 本包 (\d+) 条规则/, (_m, n) => `# 本包 ${Number(n) + 1} 条规则`));
      const r = run(["--check"]);
      expect(r.ok).toBe(false);
      expect(r.out).toContain("hotel-baseline.yml");
    } finally {
      writeFileSync(file, original);
    }
    // 还原后必须重新变绿
    expect(run(["--check"]).ok).toBe(true);
  });
});
