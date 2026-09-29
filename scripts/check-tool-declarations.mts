#!/usr/bin/env node
/**
 * 工具声明一致性检查（TOOL-DECL-01）。
 *
 * 背景（2026-09-29 审计实证）：`material-scout` 岗位声明了 `visualread.search_stock`，
 * 而视觉工位桥的白名单 `VISUAL_BRIDGE_TOOLS` 里只有 `visualwrite.fetch_stock`——
 * 调用必被桥拒绝（软失败 → `receipt.synced=false` → 线程按「未核实」收尾）。
 * 这类「声明面 ↔ 执行面」漂移此前没有任何门禁守护，只能靠人肉比对。
 *
 * 规则（确定性、可复现）：
 *  1. 收集所有行业包岗位（`bundles/<包>/presets/*.yml`）声明的工具名；
 *  2. 收集所有连接器执行器导出的白名单（`*_BRIDGE_TOOLS`），按命名空间（点号前一段）建索引；
 *  3. **违规**：声明的工具其命名空间已被某个白名单接管，但该工具不在白名单内 → 红灯；
 *  4. **未接线（提示，不红灯）**：命名空间没有任何白名单接管 → 属「声明但未接线」，
 *     逐条打印（与 CLAUDE/AGENTS 的「未核实」语义一致），不阻塞门禁。
 *
 * 用法：
 *   tsx scripts/check-tool-declarations.mts            # CI 门禁：有违规即 exit 1
 *   tsx scripts/check-tool-declarations.mts --json     # 机器可读
 *   tsx scripts/check-tool-declarations.mts --list-unwired  # 只列未接线工具
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import YAML from "yaml";
import { VISUAL_BRIDGE_TOOLS } from "../bundles/geo-growthmatrix/connectors/visual-bridge/executor.js";
import { BGM_BRIDGE_TOOLS } from "../bundles/ai-video/connectors/bgm-bridge/executor.js";
import { COLOR_BRIDGE_TOOLS } from "../bundles/ai-video/connectors/color-bridge/executor.js";
import { POST_BRIDGE_TOOLS } from "../bundles/ai-video/connectors/post-bridge/executor.js";
import { SUBTITLE_BRIDGE_TOOLS } from "../bundles/ai-video/connectors/subtitle-bridge/executor.js";
import { VOICE_BRIDGE_TOOLS } from "../bundles/ai-video/connectors/voice-bridge/executor.js";
import { BGM_TOOLS } from "../bundles/ai-video/connectors/bgm-bridge/core.mjs";
import { COLOR_TOOLS } from "../bundles/ai-video/connectors/color-bridge/core.mjs";
import { POST_TOOLS } from "../bundles/ai-video/connectors/post-bridge/core.mjs";
import { SUBTITLE_TOOLS } from "../bundles/ai-video/connectors/subtitle-bridge/core.mjs";
import { VOICE_TOOLS } from "../bundles/ai-video/connectors/voice-bridge/core.mjs";

export const EXECUTOR_ALLOWLISTS: Record<string, readonly string[]> = {
  "geo-growthmatrix/visual-bridge": VISUAL_BRIDGE_TOOLS,
  "ai-video/bgm-bridge": BGM_BRIDGE_TOOLS,
  "ai-video/color-bridge": COLOR_BRIDGE_TOOLS,
  "ai-video/post-bridge": POST_BRIDGE_TOOLS,
  "ai-video/subtitle-bridge": SUBTITLE_BRIDGE_TOOLS,
  "ai-video/voice-bridge": VOICE_BRIDGE_TOOLS,
};

/**
 * 桥本体（工位侧）实际实现的工具面。`executor` 白名单必须 ≥ 本体实现面——
 * 少登记一个工具，就等于「工位能做、客户端不放行」，能力被自己的闸门挡住（2026-09-29 bgm 实测）。
 */
export const BRIDGE_CORES: Record<string, readonly string[]> = {
  "ai-video/bgm-bridge": BGM_TOOLS,
  "ai-video/color-bridge": COLOR_TOOLS,
  "ai-video/post-bridge": POST_TOOLS,
  "ai-video/subtitle-bridge": SUBTITLE_TOOLS,
  "ai-video/voice-bridge": VOICE_TOOLS,
};

export interface DeclaredTool {
  bundle: string;
  preset: string;
  tool: string;
}

export interface DeclarationCheckResult {
  totalDeclared: number;
  totalPresets: number;
  namespaces: Record<string, string[]>;
  violations: Array<DeclaredTool & { allowed: string[] }>;
  executorGaps: Array<{ connector: string; tool: string; executorAllows: number }>;
  unwired: DeclaredTool[];
}

/** 命名空间 = 工具名点号前一段（`visualread.health` → `visualread`） */
export function namespaceOf(tool: string): string {
  const idx = tool.indexOf(".");
  return idx === -1 ? tool : tool.slice(0, idx);
}

/** 由白名单集合构建命名空间索引：namespace → 允许的工具全集（跨连接器取并集） */
export function buildNamespaceIndex(allowlists: Record<string, readonly string[]> = EXECUTOR_ALLOWLISTS): Record<string, string[]> {
  const index: Record<string, Set<string>> = {};
  for (const tools of Object.values(allowlists)) {
    for (const tool of tools) {
      const ns = namespaceOf(tool);
      (index[ns] ??= new Set()).add(tool);
    }
  }
  const out: Record<string, string[]> = {};
  for (const [ns, set] of Object.entries(index)) out[ns] = [...set].sort();
  return out;
}

/** 读取所有行业包岗位声明的工具 */
export function collectDeclaredTools(root: string): DeclaredTool[] {
  const bundlesDir = join(root, "bundles");
  const out: DeclaredTool[] = [];
  if (!existsSync(bundlesDir)) return out;
  for (const bundle of readdirSync(bundlesDir, { withFileTypes: true })) {
    if (!bundle.isDirectory()) continue;
    const presetsDir = join(bundlesDir, bundle.name, "presets");
    if (!existsSync(presetsDir)) continue;
    for (const file of readdirSync(presetsDir)) {
      if (!file.endsWith(".yml") && !file.endsWith(".yaml")) continue;
      const text = readFileSync(join(presetsDir, file), "utf8");
      let doc: unknown;
      try {
        doc = YAML.parse(text);
      } catch (err) {
        throw new Error(`岗位 YAML 解析失败：${bundle.name}/presets/${file}：${err instanceof Error ? err.message : String(err)}`);
      }
      const tools = (doc as { tools?: Array<{ name?: unknown }> } | null)?.tools ?? [];
      for (const entry of tools) {
        const name = typeof entry?.name === "string" ? entry.name.trim() : "";
        if (name.length === 0) continue;
        out.push({ bundle: bundle.name, preset: file.replace(/\.ya?ml$/, ""), tool: name });
      }
    }
  }
  return out;
}

/** 执行一致性检查（纯函数，便于测试注入 fixture） */
export function checkDeclarations(
  declared: DeclaredTool[],
  allowlists: Record<string, readonly string[]> = EXECUTOR_ALLOWLISTS,
  cores: Record<string, readonly string[]> = BRIDGE_CORES,
): DeclarationCheckResult {
  const namespaces = buildNamespaceIndex(allowlists);
  const violations: DeclarationCheckResult["violations"] = [];
  const unwired: DeclaredTool[] = [];
  for (const item of declared) {
    const ns = namespaceOf(item.tool);
    const allowed = namespaces[ns];
    if (!allowed) {
      unwired.push(item);
      continue;
    }
    if (!allowed.includes(item.tool)) violations.push({ ...item, allowed });
  }
  // 反向检查：桥本体实现了、客户端白名单却没放行的工具（能力被自己的闸门挡住）
  const executorGaps: DeclarationCheckResult["executorGaps"] = [];
  for (const [connector, coreTools] of Object.entries(cores)) {
    const allows = allowlists[connector];
    if (!allows) continue;
    for (const tool of coreTools) {
      if (!allows.includes(tool)) executorGaps.push({ connector, tool, executorAllows: allows.length });
    }
  }
  const presetKeys = new Set(declared.map((d) => `${d.bundle}/${d.preset}`));
  return { totalDeclared: declared.length, totalPresets: presetKeys.size, namespaces, violations, executorGaps, unwired };
}

function main(): void {
  const root = resolve(import.meta.dirname, "..");
  const argv = new Set(process.argv.slice(2));
  const declared = collectDeclaredTools(root);
  const result = checkDeclarations(declared);

  if (argv.has("--json")) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else if (argv.has("--list-unwired")) {
    for (const item of result.unwired) console.log(`${item.bundle}/${item.preset}\t${item.tool}`);
    console.log(`共 ${result.unwired.length} 条未接线声明`);
  } else {
    console.log(`工具声明一致性检查：${result.totalPresets} 个岗位 · ${result.totalDeclared} 条工具声明`);
    console.log(`已接管的命名空间：${Object.keys(result.namespaces).sort().join(" ")}`);
    console.log(`未接线（提示，不红灯）：${result.unwired.length} 条`);
    if (result.executorGaps.length > 0) {
      console.error(`\n✗ 桥本体已实现、客户端白名单未放行（${result.executorGaps.length} 条）：`);
      for (const gap of result.executorGaps) {
        console.error(`  - ${gap.connector}：本体实现 ${gap.tool}，executor 白名单只放行 ${gap.executorAllows} 个工具`);
      }
      console.error("修复方式：把本体已实现的工具登记进 executor 白名单（声明面与执行面双向对齐）。");
    }
    if (result.violations.length > 0) {
      console.error(`\n✗ 声明与执行面不一致（${result.violations.length} 条）：`);
      for (const v of result.violations) {
        console.error(`  - ${v.bundle}/${v.preset} 声明 ${v.tool}，但命名空间 ${namespaceOf(v.tool)} 的白名单不含它`);
        console.error(`    白名单：${v.allowed.join(", ")}`);
      }
      console.error("\n修复方式：改用白名单内的工具名，或先在连接器里实现并登记该工具（不允许只改声明）。");
    } else {
      console.log("✓ 所有已接管命名空间的工具声明都能落到执行面白名单");
    }
  }
  if (result.violations.length > 0 || result.executorGaps.length > 0) process.exitCode = 1;
}

const isDirectRun = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) main();
