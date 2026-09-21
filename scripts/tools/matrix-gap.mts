#!/usr/bin/env node
/**
 * matrix-gap —— 获客矩阵覆盖缺口报告（B-14 验收工具）
 *
 * 用法：
 *   pnpm matrix:gap [--bundle geo-growth] [--json]
 *
 * 口径：
 *  - 岗位引用对账 = 主包 + dependencies 全部 preset_key 的并集；
 *  - 围栏引用对账 = 主包 + dependencies 全部 fences 文件中的 rule_id 并集；
 *  - 平台引用对账 = platformSpecs 注册表的 id/label/alias/group 并集。
 *  未命中项如实报告（含尚未落地的计划围栏），退出码 1 表示存在缺口。
 */
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import YAML from "yaml";
import {
  formatMatrixGaps,
  loadGrowthMatrix,
  matrixGapReport,
  matrixStats,
} from "@workloom/base/bundles";
import { loadPlatformSpecs } from "@workloom/base/publish-rpa";

const root = resolve(import.meta.dirname, "..", "..");
const bundlesRoot = resolve(process.env.BUNDLES_ROOT ?? join(root, "bundles"));
const args = process.argv.slice(2);
const arg = (name: string, fallback?: string): string | undefined => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
};
const asJson = args.includes("--json");
const primary = arg("--bundle", "geo-growth")!;

interface BundleJson {
  workloom: {
    industry: string;
    dependencies?: Array<{ bundleId: string; version: string }>;
    provides: {
      presets: string[];
      fences: string[];
      matrix?: string;
      platformSpecs?: string;
    };
  };
}

function readBundle(slug: string): BundleJson {
  const file = join(bundlesRoot, slug, "bundle.json");
  if (!existsSync(file)) throw new Error(`行业包不存在：${slug}（${file}）`);
  return JSON.parse(readFileSync(file, "utf-8")) as BundleJson;
}

function collectOwners(slugs: readonly string[]): string[] {
  const owners = new Set<string>();
  for (const slug of slugs) {
    const bundle = readBundle(slug);
    for (const presetPath of bundle.workloom.provides.presets) {
      const file = join(bundlesRoot, slug, presetPath);
      const doc = YAML.parse(readFileSync(file, "utf-8")) as { preset_key?: string };
      if (doc?.preset_key) owners.add(doc.preset_key);
    }
  }
  return [...owners].sort();
}

function collectFences(slugs: readonly string[]): string[] {
  const fences = new Set<string>();
  for (const slug of slugs) {
    const bundle = readBundle(slug);
    for (const fencePath of bundle.workloom.provides.fences) {
      const file = join(bundlesRoot, slug, fencePath);
      const doc = YAML.parse(readFileSync(file, "utf-8")) as { rules?: Array<{ rule_id?: string }>; fences?: Array<{ rule_id?: string }> };
      for (const rule of [...(doc?.rules ?? []), ...(doc?.fences ?? [])]) {
        if (rule?.rule_id) fences.add(rule.rule_id);
      }
    }
  }
  return [...fences].sort();
}

const primaryBundle = readBundle(primary);
const slugs = [primary, ...(primaryBundle.workloom.dependencies ?? []).map((dep) => dep.bundleId)];
const matrixPath = primaryBundle.workloom.provides.matrix;
if (!matrixPath) throw new Error(`主包 ${primary} 未声明 provides.matrix`);
const matrix = loadGrowthMatrix(join(bundlesRoot, primary, matrixPath));

const specsPath = primaryBundle.workloom.provides.platformSpecs;
const platformNames: string[] = [];
if (specsPath) {
  const specs = loadPlatformSpecs(join(bundlesRoot, primary, specsPath));
  for (const platform of specs.platforms) {
    platformNames.push(platform.id, platform.label, ...platform.aliases);
  }
  platformNames.push(...Object.keys(specs.groups));
}

const owners = collectOwners(slugs);
const fences = collectFences(slugs);
const gaps = matrixGapReport(matrix, {
  owners,
  fences,
  ...(platformNames.length > 0 ? { platforms: platformNames } : {}),
});
const stats = matrixStats(matrix);

if (asJson) {
  console.log(JSON.stringify({ primary, bundles: slugs, stats, gaps }, null, 2));
} else {
  console.log(`# 获客矩阵缺口报告（${new Date().toISOString()}）`);
  console.log(`- 主包：${primary}；组合包：${slugs.join(" + ")}`);
  console.log(`- 在编岗位引用：${owners.length} 个；围栏引用：${fences.length} 条；平台引用：${platformNames.length} 个`);
  console.log(`- 矩阵规模：${stats.classes} 大类 / ${stats.items} 条目`);
  console.log(formatMatrixGaps(gaps));
}

process.exit(gaps.length === 0 ? 0 : 1);
