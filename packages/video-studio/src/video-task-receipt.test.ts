import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { resumeOrSubmitVideoTask, videoTaskReceiptPath } from "./video-task-receipt.js";
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
