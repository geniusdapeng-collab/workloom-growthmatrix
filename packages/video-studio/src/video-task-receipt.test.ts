import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { resumeOrSubmitVideoTask, verifyExistingSuccessfulVideoTask, videoTaskReceiptPath } from "./video-task-receipt.js";
import { filmCanonicalJson } from "./film-worker-channel.js";
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function setup() {
  const root = await mkdtemp(path.join(tmpdir(), "video-receipt-")); roots.push(root);
  const submit = vi.fn(async () => ({ ok: true, status: 200, text: '{"id":"paid-1"}' }));
  const poll = vi.fn(async (_taskId: string) => ({ ok: true, status: 200, text: '{"status":"succeeded","content":{"video_url":"https://video.invalid/1"}}' }));
  return { root, projectId: "项目/特殊", shotId: "镜头1", body: { model: "model", content: [{ text: "original" }] }, transport: { submit, poll }, wait: async () => undefined };
}
it("ACK落盘先于轮询；完成/下载故障恢复只复用同一taskId，无第二次POST", async () => {
  const input = await setup();
  input.transport.poll.mockImplementation(async taskId => {
    const saved = JSON.parse(await readFile(videoTaskReceiptPath(input.root, input.projectId, input.shotId), "utf8"));
    expect(saved).toMatchObject({ taskId, state: "submitted" });
    return { ok: true, status: 200, text: '{"status":"succeeded","content":{"video_url":"https://video.invalid/1"}}' };
  });
  const result = await resumeOrSubmitVideoTask(input);
  expect(await resumeOrSubmitVideoTask(input)).toEqual(result);
  expect(input.transport.submit).toHaveBeenCalledTimes(1); expect(input.transport.poll).toHaveBeenCalledTimes(1);
});
it("POST网络异常留下未知提交，恢复拒绝再POST", async () => {
  const input = await setup(); input.transport.submit.mockRejectedValueOnce(new Error("ACK丢失"));
  await expect(resumeOrSubmitVideoTask(input)).rejects.toThrow("ACK丢失");
  await expect(resumeOrSubmitVideoTask(input)).rejects.toThrow("SUBMISSION_UNKNOWN");
  expect(input.transport.submit).toHaveBeenCalledTimes(1); expect(input.transport.poll).not.toHaveBeenCalled();
});
it("查询超时后恢复只GET已保存taskId", async () => {
  const input = await setup();
  await expect(resumeOrSubmitVideoTask({ ...input, timeoutMs: 0 })).rejects.toThrow("轮询超时");
  expect(await resumeOrSubmitVideoTask(input)).toMatchObject({ taskId: "paid-1" });
  expect(input.transport.submit).toHaveBeenCalledTimes(1);
});
it.each(["submit", "poll"])("%s拒收留证，禁止再POST", async phase => {
  const input = await setup();
  if (phase === "submit") input.transport.submit.mockResolvedValue({ ok: false, status: 403, text: "asset invalid" });
  else input.transport.poll.mockResolvedValue({ ok: true, status: 200, text: '{"status":"failed","error":"asset invalid"}' });
  await expect(resumeOrSubmitVideoTask(input)).rejects.toThrow(/失败|failed/);
  await expect(resumeOrSubmitVideoTask(input)).rejects.toThrow("REJECTED"); expect(input.transport.submit).toHaveBeenCalledTimes(1);
});
it("同镜改提示词不能借源卡漂移再次付费", async () => {
  const input = await setup(); await resumeOrSubmitVideoTask(input);
  await expect(resumeOrSubmitVideoTask({ ...input, body: { ...input.body, changed: true } })).rejects.toThrow("RECEIPT_CHANGED");
  expect(input.transport.submit).toHaveBeenCalledTimes(1);
});
it("并发调用只有持锁者能提交", async () => {
  const input = await setup(); let release!: () => void; let started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  const blocked = new Promise<void>(resolve => { release = resolve; });
  input.transport.submit.mockImplementation(async () => { started(); await blocked; return { ok: true, status: 200, text: '{"id":"paid-1"}' }; });
  const running = resumeOrSubmitVideoTask(input); await ready;
  await expect(resumeOrSubmitVideoTask(input)).rejects.toThrow("LOCKED"); release(); await running;
  expect(input.transport.submit).toHaveBeenCalledTimes(1);
});
it("本地后期只读已成功回执，不泄露URL或再次调用提交/轮询；缺失、不同正文、未成功都拒绝", async () => {
  const input = await setup();
  await expect(verifyExistingSuccessfulVideoTask(input)).rejects.toThrow();
  await expect(resumeOrSubmitVideoTask({ ...input, timeoutMs: 0 })).rejects.toThrow("轮询超时");
  await expect(verifyExistingSuccessfulVideoTask(input)).rejects.toThrow("SUCCESS_REQUIRED");
  await resumeOrSubmitVideoTask(input);
  const value = await verifyExistingSuccessfulVideoTask(input);
  expect(value.taskId).toBe("paid-1"); expect(Object.keys(value).sort()).toEqual(["requestSha256", "taskId"]);
  await expect(verifyExistingSuccessfulVideoTask({ ...input, body: { ...input.body, changed: true } })).rejects.toThrow("RECEIPT_CHANGED");
  expect(input.transport.submit).toHaveBeenCalledTimes(1); expect(input.transport.poll).toHaveBeenCalledTimes(1);
});
const sha = (value: unknown) => createHash("sha256").update(filmCanonicalJson(value)).digest("hex");
async function legacy(input: Awaited<ReturnType<typeof setup>>, extra: Record<string, unknown> = {}, root = input.root) {
  const file = path.join(root, `${sha({ projectId: input.projectId, shotId: input.shotId })}.json`);
  const at = new Date().toISOString();
  const value = { schemaVersion: "workloom.video-task-receipt/v1", projectId: input.projectId, shotId: input.shotId,
    requestSha256: sha(input.body), state: "submitted", taskId: "paid-1", createdAt: at, updatedAt: at, ...extra };
  await writeFile(file, JSON.stringify(value)); return file;
}
it("v1受理记录跨工作目录导入稳定journal，只GET原taskId；旧空锁和记录字节保留", async () => {
  const input = await setup(), old = await setup();
  const file = await legacy(input, {}, old.root), bytes = await readFile(file, "utf8"); await writeFile(`${file}.lock`, "");
  const value = await resumeOrSubmitVideoTask({ ...input, legacyRoots: [old.root] });
  expect(value.taskId).toBe("paid-1"); expect(input.transport.submit).not.toHaveBeenCalled(); expect(input.transport.poll).toHaveBeenCalledTimes(1);
  expect(await readFile(file, "utf8")).toBe(bytes); expect(await readFile(`${file}.lock`, "utf8")).toBe("");
  const receipt = JSON.parse(await readFile(videoTaskReceiptPath(input.root, input.projectId, input.shotId), "utf8"));
  expect(receipt).toMatchObject({ schemaVersion: "workloom.video-task-receipt/v2", origin: "legacy-resume-only", legacy: [{ endpointVerified: false }] });
  expect(await resumeOrSubmitVideoTask(input)).toEqual(value); expect(input.transport.submit).not.toHaveBeenCalled();
});
it("v1已成功也先导入稳定journal，后续不依赖旧workDir仍无新POST", async () => {
  const input = await setup(), old = await setup();
  await legacy(input, { state: "succeeded", result: { taskId: "paid-1", url: "https://video.invalid/old", lastFrame: null } }, old.root);
  const result = await resumeOrSubmitVideoTask({ ...input, legacyRoots: [old.root] });
  await rm(old.root, { recursive: true });
  expect(await resumeOrSubmitVideoTask(input)).toEqual(result); expect(input.transport.submit).not.toHaveBeenCalled(); expect(input.transport.poll).not.toHaveBeenCalled();
});
it("v1未知提交被导入后禁止POST；同原记录晚到ACK只能恢复GET", async () => {
  const input = await setup(), old = await setup();
  await legacy(input, { state: "submitting", taskId: undefined }, old.root);
  await expect(resumeOrSubmitVideoTask({ ...input, legacyRoots: [old.root] })).rejects.toThrow("SUBMISSION_UNKNOWN");
  await expect(resumeOrSubmitVideoTask(input)).rejects.toThrow("SUBMISSION_UNKNOWN"); expect(input.transport.submit).not.toHaveBeenCalled();
  await legacy(input, {}, old.root);
  expect(await resumeOrSubmitVideoTask({ ...input, legacyRoots: [old.root] })).toMatchObject({ taskId: "paid-1" });
  expect(input.transport.submit).not.toHaveBeenCalled(); expect(input.transport.poll).toHaveBeenCalledTimes(1);
});
it("旧记录不同正文或多个原taskId拒绝导入，不能挑选方便的成功记录", async () => {
  const input = await setup(), a = await setup(), b = await setup();
  await legacy(input, {}, a.root); await legacy(input, { taskId: "paid-2" }, b.root);
  await expect(resumeOrSubmitVideoTask({ ...input, legacyRoots: [a.root, b.root] })).rejects.toThrow("CONFLICT"); expect(input.transport.submit).not.toHaveBeenCalled();
  await legacy(input, { requestSha256: sha({ different: true }) }, b.root);
  await expect(resumeOrSubmitVideoTask({ ...input, legacyRoots: [a.root, b.root] })).rejects.toThrow("RECEIPT_CHANGED"); expect(input.transport.submit).not.toHaveBeenCalled();
});
it.each(["provider", "endpoint", "model", "body"])("同项目同镜更改%s不能规避原付费回执再次POST", async field => {
  const input = await setup(); await resumeOrSubmitVideoTask(input);
  const change = field === "provider" ? { provider: "other" } : field === "endpoint" ? { endpoint: "https://other.invalid/tasks" }
    : { body: { ...input.body, ...(field === "model" ? { model: "changed-model" } : { additional: "changed" }) } };
  await expect(resumeOrSubmitVideoTask({ ...input, ...change })).rejects.toThrow("RECEIPT_CHANGED"); expect(input.transport.submit).toHaveBeenCalledTimes(1);
});
it.each(["body", "hash", "task", "result", "invalid-json"])("当前journal%s篡改/损坏拒绝，不删除证据重新收费", async field => {
  const input = await setup(); await resumeOrSubmitVideoTask(input);
  const file = videoTaskReceiptPath(input.root, input.projectId, input.shotId), value = JSON.parse(await readFile(file, "utf8"));
  if (field === "body") value.identity.body.content[0].text = "tampered";
  if (field === "hash") value.identitySha256 = "0".repeat(64);
  if (field === "task") value.taskId = "another-task";
  if (field === "result") value.result.url = "file:///unsafe";
  await writeFile(file, field === "invalid-json" ? "invalid" : JSON.stringify(value));
  await expect(resumeOrSubmitVideoTask(input)).rejects.toThrow(); expect(input.transport.submit).toHaveBeenCalledTimes(1);
});
it("已知ACK死owner锁安全恢复原taskId；未知/活owner锁保持原文件且禁止重发", async () => {
  const input = await setup(); await expect(resumeOrSubmitVideoTask({ ...input, timeoutMs: 0 })).rejects.toThrow("轮询超时");
  const lock = `${videoTaskReceiptPath(input.root, input.projectId, input.shotId)}.lock`;
  await writeFile(lock, JSON.stringify({ pid: 2147483647, token: "test-only-dead-owner" }));
  expect(await resumeOrSubmitVideoTask(input)).toMatchObject({ taskId: "paid-1" }); expect(input.transport.submit).toHaveBeenCalledTimes(1);
  const unknown = await setup(); unknown.transport.submit.mockRejectedValueOnce(new Error("unknown ACK")); await expect(resumeOrSubmitVideoTask(unknown)).rejects.toThrow("unknown ACK");
  const otherLock = `${videoTaskReceiptPath(unknown.root, unknown.projectId, unknown.shotId)}.lock`, dead = JSON.stringify({ pid: 2147483647, token: "test-only-unknown-owner" });
  await writeFile(otherLock, dead); await expect(resumeOrSubmitVideoTask(unknown)).rejects.toThrow("STALE_UNKNOWN"); expect(await readFile(otherLock, "utf8")).toBe(dead); expect(unknown.transport.submit).toHaveBeenCalledTimes(1);
});
it.each(["500", "invalid-json", "missing-id"])("提交%s只有一个POST且跨重启不能盲目重交", async failure => {
  const input = await setup(); input.transport.submit.mockResolvedValue({ ok: failure !== "500", status: failure === "500" ? 500 : 200,
    text: failure === "invalid-json" ? "invalid" : "{}" });
  await expect(resumeOrSubmitVideoTask(input)).rejects.toThrow(); await expect(resumeOrSubmitVideoTask(input)).rejects.toThrow("SUBMISSION_UNKNOWN");
  expect(input.transport.submit).toHaveBeenCalledTimes(1);
});
it("真正不同项目/镜头可独立生成，相同正文不能跨租户式项目身份误复用", async () => {
  const input = await setup(); await resumeOrSubmitVideoTask(input);
  await resumeOrSubmitVideoTask({ ...input, projectId: "another-project" }); await resumeOrSubmitVideoTask({ ...input, shotId: "another-shot" });
  expect(input.transport.submit).toHaveBeenCalledTimes(3);
});
it("旧产物存在但缺回执时拒绝再次付费；导入原受理记录后只恢复GET", async () => {
  const input = await setup(), old = await setup();
  await expect(resumeOrSubmitVideoTask({ ...input, requireExisting: true })).rejects.toThrow("LEGACY_RECEIPT_REQUIRED");
  expect(input.transport.submit).not.toHaveBeenCalled();
  await legacy(input, {}, old.root);
  expect(await resumeOrSubmitVideoTask({ ...input, requireExisting: true, legacyRoots: [old.root] })).toMatchObject({ taskId: "paid-1" });
  expect(input.transport.submit).not.toHaveBeenCalled(); expect(input.transport.poll).toHaveBeenCalledTimes(1);
});
it("独立进程并发通过持久身份和磁盘锁只提交一次；其余进程查询原任务", async () => {
  const input = await setup(), count = path.join(input.root, "paid-count.txt"), module = fileURLToPath(new URL("./video-task-receipt.ts", import.meta.url));
  const settings = JSON.stringify({ root: input.root, projectId: input.projectId, shotId: input.shotId, body: input.body, lockTimeoutMs: 10_000 });
  const code = `import {resumeOrSubmitVideoTask} from ${JSON.stringify(module)}; import {appendFileSync} from 'node:fs'; const value=${settings}; console.log((await resumeOrSubmitVideoTask({...value,wait:async()=>{},transport:{submit:async()=>{appendFileSync(${JSON.stringify(count)},'1');await new Promise(r=>setTimeout(r,80));return {ok:true,status:200,text:'{"id":"paid-1"}'};},poll:async()=>({ok:true,status:200,text:'{"status":"succeeded","content":{"video_url":"https://video.invalid/one"}}'})}})).taskId);`;
  const execute = promisify(execFile), results = await Promise.all(Array.from({ length: 3 }, () => execute(process.execPath, ["--import", "tsx", "--input-type=module", "-e", code], { timeout: 30_000 })));
  expect(new Set(results.map(v => v.stdout.trim())).size).toBe(1); expect(readFileSync(count, "utf8")).toBe("1");
});
