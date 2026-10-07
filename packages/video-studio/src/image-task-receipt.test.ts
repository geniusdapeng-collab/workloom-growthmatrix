import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import { GenerationFileStore } from "./generation-file-store.js";
import { imageTaskReceiptPath, readAcceptedImageTask, resumeOrSubmitImageTask } from "./image-task-receipt.js";
const roots: string[] = [];
const root = () => { const path = mkdtempSync(join(tmpdir(), "image-paid-receipt-")); roots.push(path); return path; };
afterEach(() => { for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true }); });
function input() {
  return { root: root(), projectId: "项目/中文", slotId: "portrait:演员:front", provider: "ark", endpoint: "https://ark.example.invalid/images/generations",
    body: { model: "image-model", prompt: "明确的原提示词", image: ["data:image/png;base64,YQ=="] },
    submit: vi.fn(async (_body: Record<string, unknown>) => ({ url: "https://image.invalid/paid-original.png", size: "2K" })) };
}
it("受理在回调返回前持久保存；重启/下载失败都复用同一URL，凭据不进journal", async () => {
  const value = input(), file = imageTaskReceiptPath(value.root, value);
  value.submit.mockImplementation(async body => {
    const submitting = JSON.parse(readFileSync(file, "utf8"));
    expect(submitting).toMatchObject({ state: "submitting", identity: { body } });
    return { url: "https://image.invalid/paid-original.png", size: "2K" };
  });
  const result = await resumeOrSubmitImageTask(value);
  expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({ state: "accepted", result });
  expect(statSync(file).mode & 0o777).toBe(0o600);
  const replay = vi.fn(value.submit.getMockImplementation());
  expect(await resumeOrSubmitImageTask({ ...value, submit: replay })).toEqual(result);
  expect(readAcceptedImageTask(value)).toEqual(result);
  expect(value.submit).toHaveBeenCalledTimes(1); expect(replay).not.toHaveBeenCalled();
  expect(readFileSync(file, "utf8")).not.toMatch(/authorization|apiKey/);
});
it.each(["timeout", "network", "429", "500", "invalid-json"])("%s失去受理响应，保存未知状态且跨重启不再次POST", async failure => {
  const value = input(); value.submit.mockRejectedValueOnce(new Error(failure));
  await expect(resumeOrSubmitImageTask(value)).rejects.toThrow(failure);
  await expect(resumeOrSubmitImageTask(value)).rejects.toThrow("SUBMISSION_UNKNOWN");
  expect(value.submit).toHaveBeenCalledTimes(1);
  expect(JSON.parse(readFileSync(imageTaskReceiptPath(value.root, value), "utf8")).state).toBe("unknown");
});
it("成功HTTP缺URL也保存未知，不把空响应当成未收费", async () => {
  const value = input(); value.submit.mockResolvedValue({ url: "", size: "2K" });
  await expect(resumeOrSubmitImageTask(value)).rejects.toThrow("SUBMISSION_UNKNOWN");
  await expect(resumeOrSubmitImageTask(value)).rejects.toThrow("SUBMISSION_UNKNOWN"); expect(value.submit).toHaveBeenCalledTimes(1);
});
it("20个并发调用共享一个付费POST，重排正文键不生成新请求", async () => {
  const value = input();
  const result = await Promise.all(Array.from({ length: 20 }, () => resumeOrSubmitImageTask(value)));
  expect(new Set(result.map(v => v.url)).size).toBe(1); expect(value.submit).toHaveBeenCalledTimes(1);
  await resumeOrSubmitImageTask({ ...value, body: { image: value.body.image, prompt: value.body.prompt, model: value.body.model } });
  expect(value.submit).toHaveBeenCalledTimes(1);
});
it("真正改变项目/槽/提供商/端点/模型/正文才创建独立受理；调用方元数据不参与付费正文", async () => {
  const value = input(); await resumeOrSubmitImageTask(value);
  for (const change of [{ projectId: "另项目" }, { slotId: "portrait:演员:side" }, { provider: "other" }, { endpoint: "https://other.invalid/images" },
    { body: { ...value.body, model: "new-model" } }, { body: { ...value.body, prompt: "明确修改后的创意" } }]) await resumeOrSubmitImageTask({ ...value, ...change });
  expect(value.submit).toHaveBeenCalledTimes(7);
});
it("回执正文/hash/URL被篡改或文件损坏时拒绝；不丢弃回执重交", async () => {
  for (const mutate of [(v: any) => { v.identity.body.prompt = "篡改"; }, (v: any) => { v.requestSha256 = "0".repeat(64); }, (v: any) => { v.result.url = "file:///unsafe"; }]) {
    const value = input(); await resumeOrSubmitImageTask(value); const file = imageTaskReceiptPath(value.root, value);
    const receipt = JSON.parse(readFileSync(file, "utf8")); mutate(receipt); writeFileSync(file, JSON.stringify(receipt));
    await expect(resumeOrSubmitImageTask(value)).rejects.toThrow(/RECEIPT_CHANGED|RECEIPT_INVALID/); expect(value.submit).toHaveBeenCalledTimes(1);
    writeFileSync(file, "invalid"); await expect(resumeOrSubmitImageTask(value)).rejects.toThrow("JOURNAL_CORRUPT"); expect(value.submit).toHaveBeenCalledTimes(1);
  }
});
it("已证明有旧生成但缺受理journal时禁止再次POST", async () => {
  const value = input(); await expect(resumeOrSubmitImageTask({ ...value, requireExisting: true })).rejects.toThrow("LEGACY_RECEIPT_REQUIRED");
  expect(value.submit).not.toHaveBeenCalled();
});
it("非法身份/秘密字段/符号链接在POST前拒绝，外部文件保持原字节", async () => {
  const value = input();
  for (const change of [{ projectId: "" }, { endpoint: "https://user:pw@example.invalid/images" }, { body: { ...value.body, apiKey: "test-only-forbidden-field" } }])
    await expect(resumeOrSubmitImageTask({ ...value, ...change })).rejects.toThrow();
  expect(value.submit).not.toHaveBeenCalled();
  const file = imageTaskReceiptPath(value.root, value), target = join(value.root, "outside.txt"); writeFileSync(target, "original"); symlinkSync(target, file);
  await expect(resumeOrSubmitImageTask(value)).rejects.toThrow(); expect(readFileSync(target, "utf8")).toBe("original"); expect(value.submit).not.toHaveBeenCalled();
});
it("提交回调消费不可变的完整正文，不能付费前悄悄改变请求", async () => {
  const value = input(); value.submit.mockImplementation(async body => { body.prompt = "tampered"; return { url: "https://image.invalid/x", size: "2K" }; });
  await expect(resumeOrSubmitImageTask(value)).rejects.toThrow();
  await expect(resumeOrSubmitImageTask(value)).rejects.toThrow("SUBMISSION_UNKNOWN"); expect(value.submit).toHaveBeenCalledTimes(1);
});
it("真实独立进程并发共享完整受理journal，只发生一次注入的付费提交", async () => {
  const value = input(), count = join(value.root, "count.txt"), module = fileURLToPath(new URL("./image-task-receipt.ts", import.meta.url));
  const serialized = JSON.stringify({ root: value.root, projectId: value.projectId, slotId: value.slotId, provider: value.provider, endpoint: value.endpoint, body: value.body });
  const code = `import {resumeOrSubmitImageTask} from ${JSON.stringify(module)}; import {appendFileSync} from 'node:fs'; const value=${serialized}; console.log((await resumeOrSubmitImageTask({...value,submit:async()=>{appendFileSync(${JSON.stringify(count)},'1'); await new Promise(r=>setTimeout(r,80)); return {url:'https://image.invalid/one'};}})).url);`;
  const execute = promisify(execFile);
  const results = await Promise.all(Array.from({ length: 3 }, () => execute(process.execPath, ["--import", "tsx", "--input-type=module", "-e", code], { timeout: 30_000 })));
  expect(new Set(results.map(v => v.stdout.trim())).size).toBe(1); expect(readFileSync(count, "utf8")).toBe("1");
});
it("文件锁只在死owner且已知受理时恢复；未知/活owner/恢复围栏保持原锁", async () => {
  const folder = root(), store = new GenerationFileStore(folder), key = "a".repeat(64), lock = `${store.path(key)}.lock`;
  const alive = JSON.stringify({ pid: process.pid, token: "test-only-live-owner" }); writeFileSync(lock, alive);
  const run = vi.fn(async () => "GET-only");
  await expect(store.locked(key, { timeoutMs: 0, canRecover: () => true }, run)).rejects.toThrow("LOCKED"); expect(readFileSync(lock, "utf8")).toBe(alive); expect(run).not.toHaveBeenCalled();
  const dead = JSON.stringify({ pid: 2147483647, token: "dead" }); writeFileSync(lock, dead);
  await expect(store.locked(key, { timeoutMs: 10, canRecover: () => false }, run)).rejects.toThrow("STALE_UNKNOWN"); expect(readFileSync(lock, "utf8")).toBe(dead);
  expect(await store.locked(key, { timeoutMs: 10, canRecover: () => true }, run)).toBe("GET-only"); expect(run).toHaveBeenCalledTimes(1);
  writeFileSync(lock, "unknown"); await expect(store.locked(key, { timeoutMs: 0, canRecover: () => true }, run)).rejects.toThrow("LOCK_INVALID");
  unlinkSync(lock); writeFileSync(`${lock}.recover`, dead);
  await expect(store.locked(key, { timeoutMs: 0, canRecover: () => true }, run)).rejects.toThrow("RECOVERY_BUSY"); expect(readFileSync(`${lock}.recover`, "utf8")).toBe(dead);
  expect(readdirSync(folder).filter(v => v.endsWith(".tmp"))).toHaveLength(0);
});
