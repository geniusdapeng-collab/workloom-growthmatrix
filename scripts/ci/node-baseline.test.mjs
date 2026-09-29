/**
 * Node 运行时基线一致性（U-04 回归）
 *
 * 背景（排雷台账 U-04）：`package.json` 声明 `engines.node >=24`，
 * 但在 Node 22 上做过实跑（全功能正常、只有 pnpm 的 EBADENGINE 警告），
 * 于是出现「声明 ≥24 vs 实测 22 可用」的口径差。
 *
 * 本仓的结论是**声明不变**（Node ≥24 才是支持基线）：
 *  - dsh 运行时自 0.1.2-rc.1 起要求 Node ≥24 的 zstd API（见 docs/AUDIT.md、docs/OPEN_SOURCE_COMPONENTS.md）；
 *  - 桌面发布载荷固定 node-v24.19.0（scripts/release-assets.json），CI 与桌面流水线断言 v24.19.0。
 * 本测试把这些散落的固定点锁在一起，防止「改了声明/固定版本却没人同步其它三处」的漂移。
 * Node 22 的实跑只作兼容参考，不构成支持承诺（README 已注明）。
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const read = (p) => fs.readFileSync(path.join(root, p), "utf8");
const json = (p) => JSON.parse(read(p));

const EXPECTED_NODE_BASELINE = ">=24.0.0";
const PINNED_NODE = "v24.19.0";

test("package.json engines.node 声明支持基线（>=24.0.0）", () => {
  const pkg = json("package.json");
  assert.equal(pkg.engines?.node, EXPECTED_NODE_BASELINE, "engines.node 与文档/流水线口径不一致");
});

test("CI 与桌面流水线固定 Node 24.19.0", () => {
  const cnb = read(".cnb.yml");
  assert.ok(cnb.includes(`NODE_VERSION=${PINNED_NODE}`), `.cnb.yml 应固定 NODE_VERSION=${PINNED_NODE}`);
  assert.ok(cnb.includes(`test "$(node --version)" = ${PINNED_NODE}`), ".cnb.yml 应断言 node --version");
  const gha = read(".github/workflows/build-desktop.yml");
  assert.ok(gha.includes(`test "$(node --version)" = "${PINNED_NODE}"`), "桌面流水线应断言 node --version");
});

test("桌面发布载荷固定 node-v24.19.0 三种目标", () => {
  const assets = json("scripts/release-assets.json");
  const names = JSON.stringify(assets);
  for (const target of ["darwin-arm64", "darwin-x64", "win-x64"]) {
    assert.ok(names.includes(`node-${PINNED_NODE}-${target}`), `发布载荷缺 node-${PINNED_NODE}-${target}`);
  }
});

test("README 声明 Node ≥24.0.0 且注明 Node 22 仅为实测参考", () => {
  const readme = read("README.md");
  assert.ok(/Node\.js \*\*≥24\.0\.0\*\*/.test(readme), "README 快速开始应声明 Node.js ≥24.0.0");
  assert.ok(/Node 22/.test(readme), "README 应注明 Node 22 的实测口径（U-04）");
});

test("doctor.sh 对低于 24 的 Node 判阻断（与声明一致）", () => {
  const doctor = read("scripts/doctor.sh");
  assert.ok(/MAJOR.*-ge 24|\[ "\$MAJOR" -ge 24 \]/.test(doctor), "doctor.sh 应以 24 为支持基线判阻断");
});

test("当前运行时可执行 node 且版本可解析（报告实际版本，不强制等于基线）", () => {
  const v = execFileSync(process.execPath, ["--version"], { encoding: "utf8" }).trim();
  const major = Number(v.replace(/^v/, "").split(".")[0]);
  assert.ok(Number.isInteger(major) && major > 0, `无法解析 node 版本：${v}`);
  console.log(`[node-baseline] 当前运行时 ${v}（支持基线 ${EXPECTED_NODE_BASELINE}，桌面载荷固定 ${PINNED_NODE}）`);
});
