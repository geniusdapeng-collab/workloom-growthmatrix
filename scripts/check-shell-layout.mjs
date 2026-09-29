#!/usr/bin/env node
/**
 * C 端壳几何回归探针（MC-012）。
 *
 * 背景：`apps/webc` 的服务前台底栏曾悬停在屏幕中部（390×844 实测 top=391、下方 46% 空白），
 * 根因是应用层 `.phone-shell{display:flex}` 覆盖了共享壳 `.wl-app-shell{display:grid}` 的三段式
 * （同特异性、应用样式在产物里更晚出现）。静态契约由
 * `scripts/check-webc-shell-contract.test.ts` 守住，**真实几何**由本脚本用真机浏览器量测。
 *
 * 用法：
 *   node scripts/check-shell-layout.mjs                       # 用已有 apps/webc/dist 起 preview 量测
 *   node scripts/check-shell-layout.mjs --build                # 先构建再量测
 *   node scripts/check-shell-layout.mjs --url http://localhost:3202   # 量测已运行的前端（dev 或 prod）
 *   node scripts/check-shell-layout.mjs --viewport 390x844,430x932 --save-screens work/ui-gate/screens
 *
 * 判据（任一不满足即退出码 1）：
 *   ① 底栏底边 ≈ 视口底边（容差 2px）；② 底栏下方空白 ≤ 视口高度 5%；
 *   ③ 主区底边 ≈ 底栏顶边（主区把剩余高度吃满）；④ 壳高 ≥ 视口高；⑤ 无未捕获异常（pageerror）。
 * 说明：本机预览没有后端，接口 401/404 会在 console 里报「Failed to load resource」——那属于
 * 数据面而非布局面，按信息记录、不判失败；未捕获异常（React 崩溃等）才判失败。
 */
import { createRequire } from "node:module";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function argValue(name, fallback = null) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] ?? fallback : fallback;
}

const shouldBuild = process.argv.includes("--build");
const explicitUrl = argValue("--url");
const viewports = String(argValue("--viewport", "390x844,430x932"))
  .split(",")
  .map((item) => item.trim())
  .filter(Boolean)
  .map((item) => {
    const [width, height] = item.split("x").map((value) => Number(value));
    if (!Number.isFinite(width) || !Number.isFinite(height)) throw new Error(`非法视口：${item}`);
    return { width, height };
  });
const screenshotDir = argValue("--save-screens");
const BLANK_RATIO_LIMIT = 0.05;
const EDGE_TOLERANCE_PX = 2;

function run(command, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd: REPO_ROOT, stdio: "inherit", ...options });
    child.on("error", reject);
    child.on("exit", (code) => (code === 0 ? resolvePromise() : reject(new Error(`${command} ${args.join(" ")} 退出码 ${code}`))));
  });
}

function resolvePlaywright() {
  const require = createRequire(join(REPO_ROOT, "package.json"));
  const direct = join(REPO_ROOT, "node_modules", "playwright");
  if (existsSync(direct)) return require(direct);
  const pnpmDir = join(REPO_ROOT, "node_modules", ".pnpm");
  const hit = readdirSync(pnpmDir).find((entry) => /^playwright@/.test(entry));
  if (!hit) throw new Error(`未找到 playwright 包（${pnpmDir}）`);
  return require(join(pnpmDir, hit, "node_modules", "playwright"));
}

async function waitForServer(url, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    try {
      const response = await fetch(url, { method: "GET", signal: controller.signal });
      if (response.ok || response.status === 404) return;
    } catch {
      /* 未就绪：继续等 */
    } finally {
      clearTimeout(timer);
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
  }
  throw new Error(`预览服务在 ${timeoutMs}ms 内未就绪：${url}`);
}

async function startPreview() {
  const dist = join(REPO_ROOT, "apps/webc/dist");
  if (!existsSync(dist)) throw new Error("缺少 apps/webc/dist：先跑 pnpm -C apps/webc build 或加 --build");
  const port = 3210 + Math.floor(Math.random() * 40);
  const url = `http://127.0.0.1:${port}/`;
  /**
   * `--host 127.0.0.1`：vite preview 默认只绑 localhost（可能是 ::1），按 127.0.0.1 探活会永远等不到；
   * `detached` + 只接管道：停止时能整组回收（否则 pnpm→vite 孙进程会继续持有管道，父进程卡住）。
   */
  const child = spawn("pnpm", ["-C", "apps/webc", "exec", "vite", "preview", "--host", "127.0.0.1", "--port", String(port), "--strictPort"], {
    cwd: REPO_ROOT,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stop = () => {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      child.kill("SIGTERM");
    }
  };
  await waitForServer(url);
  return { url, stop };
}

async function measure(page, viewport, url) {
  await page.setViewportSize({ width: viewport.width, height: viewport.height });
  await page.goto(url, { waitUntil: "load", timeout: 45_000 });
  await page.waitForTimeout(2500);
  return page.evaluate(() => {
    const rect = (selector) => {
      const el = document.querySelector(selector);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { top: Math.round(r.top), bottom: Math.round(r.bottom), height: Math.round(r.height), width: Math.round(r.width) };
    };
    return {
      innerHeight: window.innerHeight,
      client: document.querySelector("[data-workloom-client]")?.getAttribute("data-workloom-client") ?? null,
      appShell: rect(".wl-app-shell"),
      shellDisplay: (() => {
        const shell = document.querySelector(".wl-app-shell");
        return shell ? getComputedStyle(shell).display : null;
      })(),
      main: rect(".wl-app-shell__main"),
      bottomTabs: rect(".wl-bottom-tabs"),
      bodyScrollHeight: document.body.scrollHeight,
    };
  });
}

function evaluate(facts, viewport) {
  const failures = [];
  const { innerHeight, bottomTabs, main, appShell, shellDisplay } = facts;
  if (!appShell || !bottomTabs) {
    failures.push("缺少共享壳或底栏元素（.wl-app-shell / .wl-bottom-tabs）");
    return failures;
  }
  if (shellDisplay !== "grid") failures.push(`共享壳 display 必须为 grid（当前 ${String(shellDisplay)}）——应用层样式不得覆盖壳布局`);
  const gap = innerHeight - bottomTabs.bottom;
  if (Math.abs(gap) > EDGE_TOLERANCE_PX) failures.push(`底栏底边未贴底：视口 ${innerHeight}px，底栏底边 ${bottomTabs.bottom}px，差 ${gap}px`);
  if (gap > innerHeight * BLANK_RATIO_LIMIT) failures.push(`底栏下方空白 ${gap}px 超过视口 5%（${Math.round(innerHeight * BLANK_RATIO_LIMIT)}px）`);
  if (main && Math.abs(main.bottom - bottomTabs.top) > EDGE_TOLERANCE_PX) {
    failures.push(`主区底边与底栏顶边不连续：主区 ${main.bottom}px，底栏 ${bottomTabs.top}px`);
  }
  if (appShell.height < innerHeight - EDGE_TOLERANCE_PX) failures.push(`壳高 ${appShell.height}px 小于视口 ${innerHeight}px`);
  if (viewport.width <= 640 && appShell.width > viewport.width + EDGE_TOLERANCE_PX) {
    failures.push(`窄屏壳宽 ${appShell.width}px 溢出视口 ${viewport.width}px`);
  }
  return failures;
}

async function main() {
  if (shouldBuild) await run("pnpm", ["-C", "apps/webc", "build"]);
  const server = explicitUrl ? { url: explicitUrl, stop: () => {} } : await startPreview();
  const { chromium } = resolvePlaywright();
  const browser = await chromium.launch();
  const report = [];
  let failed = false;
  try {
    for (const viewport of viewports) {
      const page = await browser.newPage({ viewport, deviceScaleFactor: 1 });
      const consoleErrors = [];
      const pageErrors = [];
      page.on("console", (message) => {
        if (message.type() === "error") consoleErrors.push(message.text());
      });
      page.on("pageerror", (error) => pageErrors.push(`pageerror: ${error.message}`));
      const facts = await measure(page, viewport, server.url);
      const failures = evaluate(facts, viewport);
      if (pageErrors.length > 0) failures.push(`未捕获异常 ${pageErrors.length} 条：${pageErrors[0]}`);
      if (screenshotDir) {
        mkdirSync(screenshotDir, { recursive: true });
        await page.screenshot({ path: join(screenshotDir, `webc-${viewport.width}x${viewport.height}.png`), fullPage: false });
      }
      await page.close();
      report.push({ url: server.url, viewport, facts, consoleErrors: consoleErrors.slice(0, 5), failures });
      if (failures.length > 0) failed = true;
    }
  } finally {
    await browser.close();
    server.stop();
  }
  console.log(JSON.stringify(report, null, 2));
  if (failed) {
    console.error(`❌ C 端壳几何不合格：${report.flatMap((entry) => entry.failures).length} 项`);
    process.exit(1);
  }
  console.log(`✅ C 端壳几何通过（${viewports.map((v) => `${v.width}×${v.height}`).join(" / ")}）：底栏贴底、主区吃满剩余高度`);
}

main().catch((error) => {
  console.error(`❌ C 端壳几何探针失败：${String(error?.message ?? error)}`);
  process.exit(1);
});
