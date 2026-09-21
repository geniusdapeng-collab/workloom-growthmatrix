"use strict";
/**
 * B-23 桌面发布驱动测试（node --test）：
 *  - Playwright 缺失 → 明确报错（fail-closed，不静默）；
 *  - Toolkit 驱动映射（goto/click/type/waitForSelector）与文件上传显式检查。
 */
const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const { createPlaywrightPublishDriver, createToolkitPublishDriver, loadPlaywright } = require("./publish-driver.cjs");

function hasPlaywright() {
  try {
    loadPlaywright();
    return true;
  } catch {
    return false;
  }
}

describe("B-23 Playwright 发布驱动", () => {
  it("Playwright 未安装时给出明确错误（而非静默跳过）", () => {
    if (hasPlaywright()) {
      const driver = createPlaywrightPublishDriver({ headless: true });
      assert.equal(driver.kind, "playwright");
      return;
    }
    assert.throws(() => createPlaywrightPublishDriver(), /Playwright 未安装/);
  });
});

describe("B-23 Toolkit 发布驱动映射", () => {
  const calls = [];
  const computerDriver = {
    async browserGoto(url) { calls.push(["goto", url]); return { ok: true, data: { result: true } }; },
    async browserEval(expr) { calls.push(["eval", expr]); return { ok: true, data: { result: true } }; },
    async browserFill(sel, value) { calls.push(["fill", sel, value]); return { ok: true }; },
    async browserClick(sel) { calls.push(["click", sel]); return { ok: true }; },
  };

  it("goto/click/type/waitForSelector/isLoggedIn 正确映射", async () => {
    const driver = createToolkitPublishDriver(computerDriver);
    await driver.goto("https://example.com");
    await driver.click("#submit");
    await driver.typeText("#title", "hello");
    assert.equal(await driver.waitForSelector("#ok"), true);
    assert.equal(await driver.isLoggedIn("https://example.com", "#avatar"), true);
    assert.deepEqual(calls[0], ["goto", "https://example.com"]);
    assert.ok(calls.some((c) => c[0] === "click" && c[1] === "#submit"));
    assert.ok(calls.some((c) => c[0] === "fill"));
  });

  it("缺少 browserSetFileInputFiles → 文件上传明确失败（不静默跳过）", async () => {
    const driver = createToolkitPublishDriver(computerDriver);
    await assert.rejects(() => driver.uploadFile("input[type=file]", "/tmp/a.mp4"), /browserSetFileInputFiles|转人工/);
  });

  it("提供 browserSetFileInputFiles → 调用 CDP 上传", async () => {
    const withUpload = {
      ...computerDriver,
      async browserSetFileInputFiles(sel, path) { calls.push(["upload", sel, path]); return { ok: true }; },
    };
    const driver = createToolkitPublishDriver(withUpload);
    await driver.uploadFile("input[type=file]", "/tmp/a.mp4");
    assert.ok(calls.some((c) => c[0] === "upload" && c[2] === "/tmp/a.mp4"));
  });
});
