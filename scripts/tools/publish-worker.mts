#!/usr/bin/env node
/**
 * publish-worker · 桌面端发布执行 worker（B-23）
 *
 * 用法（桌面包/工位机侧，服务端经 publish-bridge HTTP 桥调用）：
 *   tsx scripts/tools/publish-worker.mts --task /path/task.json --driver playwright
 *
 * task.json：{ taskId, platform, input: { videoPath, coverPath?, caption, tags, scheduleAt? } }
 * 输出：stdout 单行 JSON —— { ok: true, receipt } 或 { ok: false, error }；退出码 0/1。
 *
 * 纪律：登录态只存本机 profile（WORKLOOM_DESKTOP_PROFILE_DIR）；无回执不报成功；
 *      Playwright 缺失/未登录/适配器缺失一律失败返回（由服务端转人工）。
 */
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  createBaijiaAdapter, createBilibiliAdapter, createDouyinAdapter, createShipinhaoAdapter,
  createTiktokAdapter, createWeixinMpAdapter, createWeiboAdapter, createXiaohongshuAdapter, createYoutubeAdapter,
  type ArticleAdapter, type BrowserDriver, type Platform, type PublishAdapter, type PublishReceipt, type UploadInput,
} from "@workloom/base/publish-rpa";
import type { ArticleUploadInput } from "@workloom/base/publish-rpa";

const require = createRequire(import.meta.url);

export interface PublishWorkerTask {
  taskId: string;
  platform: Platform;
  input: UploadInput;
}

export interface PublishWorkerDeps {
  driver: BrowserDriver;
  adapters?: Partial<Record<Platform, PublishAdapter>>;
}

export type PublishWorkerResult =
  | { ok: true; receipt: PublishReceipt }
  | { ok: false; error: string };

export function defaultPublishAdapters(): Partial<Record<Platform, PublishAdapter>> {
  return {
    douyin: createDouyinAdapter(),
    xiaohongshu: createXiaohongshuAdapter(),
    bilibili: createBilibiliAdapter(),
    youtube: createYoutubeAdapter(),
    shipinhao: createShipinhaoAdapter(),
    tiktok: createTiktokAdapter(),
  };
}

/** 单任务执行：loginCheck → upload → receiptProbe；任一步失败即返回 ok:false（无伪造回执）。 */
export async function executePublish(task: PublishWorkerTask, deps: PublishWorkerDeps): Promise<PublishWorkerResult> {
  const adapter = deps.adapters?.[task.platform] ?? defaultPublishAdapters()[task.platform];
  if (!adapter) return { ok: false, error: `NO_ADAPTER:${task.platform}` };
  try {
    if (!(await adapter.loginCheck(deps.driver))) return { ok: false, error: "LOGIN_REQUIRED" };
    const upload = await adapter.upload(deps.driver, task.input);
    const receipt = await adapter.receiptProbe(deps.driver, { taskId: task.taskId, upload });
    if (!receipt.synced) return { ok: false, error: "NO_RECEIPT" };
    return { ok: true, receipt };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** 图文通道执行（B-18；桌面侧同样走 worker，平台为五类国内图文通道）。 */
export async function executeArticlePublish(
  task: { taskId: string; platform: Platform; input: ArticleUploadInput },
  deps: { driver: BrowserDriver; adapters: Partial<Record<Platform, ArticleAdapter>> },
): Promise<PublishWorkerResult> {
  const adapter = deps.adapters[task.platform];
  if (!adapter) return { ok: false, error: `NO_ADAPTER:${task.platform}` };
  try {
    if (!(await adapter.loginCheck(deps.driver))) return { ok: false, error: "LOGIN_REQUIRED" };
    const upload = await adapter.upload(deps.driver, task.input);
    const receipt = await adapter.receiptProbe(deps.driver, { taskId: task.taskId, upload });
    if (!receipt.synced) return { ok: false, error: "NO_RECEIPT" };
    return { ok: true, receipt };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function buildPlaywrightDriver(): BrowserDriver {
  interface DriverFactory { createPlaywrightPublishDriver(opts?: Record<string, unknown>): unknown }
  const { createPlaywrightPublishDriver } = require(
    join(process.cwd(), "apps/desktop/electron/publish-driver.cjs"),
  ) as DriverFactory;
  const profileDir = process.env.WORKLOOM_DESKTOP_PROFILE_DIR?.trim()
    || join(process.cwd(), ".vm-work", "publish-profile");
  return createPlaywrightPublishDriver({
    userDataDir: profileDir,
    headless: process.env.WORKLOOM_DESKTOP_HEADLESS === "1",
    executablePath: process.env.WORKLOOM_DESKTOP_CHROMIUM?.trim() || undefined,
  }) as BrowserDriver;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const taskPath = args[args.indexOf("--task") + 1];
  const driverKind = args.includes("--driver") ? args[args.indexOf("--driver") + 1] : "playwright";
  if (!taskPath) {
    console.log(JSON.stringify({ ok: false, error: "缺少 --task <task.json>" }));
    process.exitCode = 1;
    return;
  }
  if (driverKind !== "playwright") {
    console.log(JSON.stringify({ ok: false, error: `不支持的驱动 ${driverKind}（桌面 worker 仅内置 playwright；toolkit 由桌面包注入）` }));
    process.exitCode = 1;
    return;
  }
  let task: PublishWorkerTask;
  try {
    task = JSON.parse(readFileSync(taskPath, "utf8")) as PublishWorkerTask;
  } catch (error) {
    console.log(JSON.stringify({ ok: false, error: `任务读取失败：${error instanceof Error ? error.message : String(error)}` }));
    process.exitCode = 1;
    return;
  }
  const driver = buildPlaywrightDriver();
  const result = await executePublish(task, { driver });
  await (driver as { close?: () => Promise<void> }).close?.().catch(() => undefined);
  console.log(JSON.stringify(result));
  process.exitCode = result.ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
