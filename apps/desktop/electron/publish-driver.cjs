"use strict";
/**
 * WorkLoom 桌面端 · 发布浏览器驱动（B-23）
 *
 * 两条实现路径（同一 BrowserDriver seam，供 publish-rpa 适配器直接使用）：
 *  ① Playwright（桌面包内置 Chromium）：首选；文件上传走 setInputFiles，登录态落在本机 profile 目录；
 *  ② computer-use ToolkitDriver（CDP/AXTree）：复用 packages/base/computer-use 的能力，
 *     通过注入的 duck-typed driver 适配；uploadFile 需要驱动暴露 browserSetFileInputFiles（CDP
 *     DOM.setFileInputFiles），未暴露时明确报错，绝不静默跳过上传。
 *
 * 纪律：Playwright 未安装 / 浏览器未就绪 → 抛错由 worker 转人工；不伪造回执。
 */

function loadPlaywright() {
  try {
    // eslint-disable-next-line global-require
    return require("playwright");
  } catch (err) {
    throw new Error(
      "Playwright 未安装：桌面发布驱动需随桌面包注入（extraResources 或 pnpm add playwright），当前环境不可用",
    );
  }
}

/**
 * Playwright 发布驱动。
 * @param {{ userDataDir?: string, headless?: boolean, executablePath?: string }} [opts]
 */
function createPlaywrightPublishDriver(opts = {}) {
  const playwright = loadPlaywright();
  let context = null;
  let page = null;

  async function ensurePage() {
    if (page) return page;
    context = await playwright.chromium.launchPersistentContext(opts.userDataDir || undefined, {
      headless: opts.headless === true,
      executablePath: opts.executablePath || undefined,
      viewport: { width: 1440, height: 900 },
    });
    page = context.pages()[0] || (await context.newPage());
    return page;
  }

  return {
    kind: "playwright",
    async goto(url) {
      const p = await ensurePage();
      await p.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
    },
    async isLoggedIn(pageUrl, loginIndicatorSelector) {
      const p = await ensurePage();
      if (pageUrl) await p.goto(pageUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
      return (await p.locator(loginIndicatorSelector).count()) > 0;
    },
    async uploadFile(selector, filePath) {
      const p = await ensurePage();
      await p.locator(selector).setInputFiles(filePath, { timeout: 120_000 });
    },
    async typeText(selector, text, typeOpts = {}) {
      const p = await ensurePage();
      const locator = p.locator(selector);
      if (typeOpts.delayMs && typeOpts.delayMs > 0) {
        await locator.click();
        await locator.pressSequentially(text, { delay: typeOpts.delayMs });
      } else {
        await locator.fill(text);
      }
    },
    async click(selector) {
      const p = await ensurePage();
      await p.locator(selector).click({ timeout: 60_000 });
    },
    async waitForSelector(selector, waitOpts = {}) {
      const p = await ensurePage();
      try {
        await p.locator(selector).first().waitFor({ state: "visible", timeout: waitOpts.timeoutMs || 15_000 });
        return true;
      } catch {
        return false;
      }
    },
    async wait(ms) {
      await new Promise((resolve) => setTimeout(resolve, ms));
    },
    async close() {
      if (context) await context.close().catch(() => undefined);
      context = null;
      page = null;
    },
  };
}

/**
 * 把 computer-use 驱动适配成发布 BrowserDriver（复用 ToolkitDriver 的 L1 浏览器能力）。
 * @param {any} computerDriver ToolkitDriver 或同形状 duck-typed 驱动
 */
function createToolkitPublishDriver(computerDriver) {
  if (!computerDriver || typeof computerDriver.browserGoto !== "function") {
    throw new Error("ToolkitPublishDriver 需要注入 computer-use 驱动（browserGoto/browserEval/...）");
  }
  const ok = (result) => {
    if (!result || result.ok === false) throw new Error(`computer-use 动作失败：${result && result.error ? result.error : "unknown"}`);
    return result;
  };
  const unwrap = (result) => {
    const data = result && result.data;
    return data && Object.prototype.hasOwnProperty.call(data, "result") ? data.result : data;
  };
  return {
    kind: "toolkit",
    async goto(url) {
      ok(await computerDriver.browserGoto(url));
    },
    async isLoggedIn(pageUrl, loginIndicatorSelector) {
      if (pageUrl) ok(await computerDriver.browserGoto(pageUrl));
      const r = ok(await computerDriver.browserEval(`!!document.querySelector(${JSON.stringify(loginIndicatorSelector)})`));
      return String(unwrap(r)).includes("true");
    },
    async uploadFile(selector, filePath) {
      if (typeof computerDriver.browserSetFileInputFiles !== "function") {
        throw new Error(
          "computer-use 驱动未暴露 browserSetFileInputFiles（CDP DOM.setFileInputFiles）：无法完成文件上传，转人工",
        );
      }
      ok(await computerDriver.browserSetFileInputFiles(selector, filePath));
    },
    async typeText(selector, text) {
      ok(await computerDriver.browserFill(selector, text));
    },
    async click(selector) {
      ok(await computerDriver.browserClick(selector));
    },
    async waitForSelector(selector) {
      const r = ok(await computerDriver.browserEval(`!!document.querySelector(${JSON.stringify(selector)})`));
      return String(unwrap(r)).includes("true");
    },
    async wait(ms) {
      await new Promise((resolve) => setTimeout(resolve, ms));
    },
    async close() {
      if (typeof computerDriver.close === "function") await computerDriver.close().catch(() => undefined);
    },
  };
}

module.exports = {
  createPlaywrightPublishDriver,
  createToolkitPublishDriver,
  loadPlaywright,
};
