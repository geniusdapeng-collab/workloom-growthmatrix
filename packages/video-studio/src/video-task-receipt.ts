/** 付费视频任务的持久回执。单项目单镜只POST一次；故障恢复只查询已登记taskId。 */
import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { filmCanonicalJson } from "./film-worker-channel.js";

export interface VideoTaskResult { taskId: string; url: string; lastFrame: string | null }
interface Receipt {
  schemaVersion: "workloom.video-task-receipt/v1";
  projectId: string; shotId: string; requestSha256: string;
  state: "submitting" | "submitted" | "succeeded" | "rejected";
  createdAt: string; updatedAt: string; taskId?: string; result?: VideoTaskResult; error?: string;
}
export interface VideoTaskTransport {
  submit(body: Record<string, unknown>): Promise<{ ok: boolean; status: number; text: string }>;
  poll(taskId: string): Promise<{ ok: boolean; status: number; text: string }>;
}
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
export function videoTaskReceiptPath(root: string, projectId: string, shotId: string): string {
  if (!projectId.trim() || !shotId.trim()) throw new Error("VIDEO_TASK_SCOPE_INVALID");
  return path.join(root, `${hash(filmCanonicalJson({ projectId, shotId }))}.json`);
}
async function save(file: string, value: Receipt): Promise<void> {
  const temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  await rename(temporary, file);
}
function parseReceipt(text: string, projectId: string, shotId: string, requestSha256: string): Receipt {
  const value = JSON.parse(text) as Receipt;
  if (value.schemaVersion !== "workloom.video-task-receipt/v1" || value.projectId !== projectId || value.shotId !== shotId
    || value.requestSha256 !== requestSha256 || !["submitting", "submitted", "succeeded", "rejected"].includes(value.state)) {
    throw new Error("VIDEO_TASK_RECEIPT_CHANGED：同一镜已有不同请求或回执损坏，禁止另付费提交");
  }
  if (["submitted", "succeeded"].includes(value.state) && !value.taskId) throw new Error("VIDEO_TASK_RECEIPT_INVALID：缺既有taskId");
  if (value.state === "succeeded" && (!value.result?.url || value.result.taskId !== value.taskId)) throw new Error("VIDEO_TASK_RECEIPT_INVALID：完成回包未绑定taskId");
  return value;
}

/** 后期只读入口：核对原请求和成功任务；没有submit/poll回调，不能产生第二笔提交。 */
export async function verifyExistingSuccessfulVideoTask(input: {
  root: string; projectId: string; shotId: string; body: Record<string, unknown>;
}): Promise<{ taskId: string; requestSha256: string }> {
  const requestSha256 = hash(filmCanonicalJson(input.body));
  const value = parseReceipt(await readFile(videoTaskReceiptPath(input.root, input.projectId, input.shotId), "utf8"), input.projectId, input.shotId, requestSha256);
  if (value.state !== "succeeded" || !value.taskId) throw new Error("VIDEO_TASK_SUCCESS_REQUIRED：后期只接受已有成功任务，不提交或猜测恢复");
  return { taskId: value.taskId, requestSha256 };
}

export async function resumeOrSubmitVideoTask(input: {
  root: string; projectId: string; shotId: string; body: Record<string, unknown>; transport: VideoTaskTransport;
  pollIntervalMs?: number; timeoutMs?: number; wait?: (milliseconds: number) => Promise<void>;
}): Promise<VideoTaskResult> {
  const file = videoTaskReceiptPath(input.root, input.projectId, input.shotId);
  await mkdir(input.root, { recursive: true });
  const requestSha256 = hash(filmCanonicalJson(input.body));
  let receipt: Receipt | undefined;
  try { receipt = parseReceipt(await readFile(file, "utf8"), input.projectId, input.shotId, requestSha256); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const lockFile = `${file}.lock`;
  let lock;
  try { lock = await open(lockFile, "wx", 0o600); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error("VIDEO_TASK_LOCKED：该镜有运行中或中断提交；禁止并发/猜测重复提交");
    throw error;
  }
  try {
    // 取得锁后重新读取，避免另一个进程在第一次读取后已经写入完成回执。
    try { receipt = parseReceipt(await readFile(file, "utf8"), input.projectId, input.shotId, requestSha256); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (receipt?.state === "succeeded") return receipt.result!;
    if (receipt?.state === "submitting") throw new Error("VIDEO_TASK_SUBMISSION_UNKNOWN：上一提交未保存taskId；必须查平台回执，禁止再次POST");
    if (receipt?.state === "rejected") throw new Error(`VIDEO_TASK_REJECTED：上一提交已拒绝，禁止自动重交（${receipt.error ?? "未知原因"}）`);
    if (!receipt) {
      const at = new Date().toISOString();
      receipt = { schemaVersion: "workloom.video-task-receipt/v1", projectId: input.projectId, shotId: input.shotId,
        requestSha256, state: "submitting", createdAt: at, updatedAt: at };
      // POST之前持久化。网络异常/未知ACK不删记录，不能把“没收到”当成“未提交”。
      await save(file, receipt);
      const response = await input.transport.submit(input.body);
      if (!response.ok) {
        receipt.state = "rejected"; receipt.error = `HTTP ${response.status}：${response.text.slice(0, 300)}`;
        receipt.updatedAt = new Date().toISOString(); await save(file, receipt);
        throw new Error(`视频提交失败 ${receipt.error}`);
      }
      const submitted = JSON.parse(response.text) as { id?: string; data?: { id?: string } };
      const taskId = submitted.id ?? submitted.data?.id;
      if (typeof taskId !== "string" || !taskId.trim()) throw new Error("VIDEO_TASK_SUBMISSION_UNKNOWN：ACK没有taskId，禁止重复提交");
      receipt.taskId = taskId; receipt.state = "submitted"; receipt.updatedAt = new Date().toISOString();
      await save(file, receipt); // taskId必须先落盘，再做任何轮询和下载。
    }
    const taskId = receipt.taskId!;
    const deadline = Date.now() + (input.timeoutMs ?? 20 * 60_000);
    const wait = input.wait ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
    let lastError = "未收到任务状态";
    while (Date.now() < deadline) {
      await wait(input.pollIntervalMs ?? 10_000);
      let response;
      try { response = await input.transport.poll(taskId); }
      catch (error) { lastError = message(error); continue; } // 只重试GET，永不重新POST。
      if (!response.ok) { lastError = `查询HTTP ${response.status}：${response.text.slice(0, 200)}`; continue; }
      let status: Record<string, unknown>;
      try { status = JSON.parse(response.text) as Record<string, unknown>; }
      catch { lastError = "查询返回非法JSON"; continue; }
      const state = String(status.status ?? "");
      if (state === "succeeded" || state === "success") {
        const content = status.content as Record<string, unknown> | undefined;
        const url = typeof content?.video_url === "string" ? content.video_url : "";
        if (!url) throw new Error(`VIDEO_TASK_RESULT_INVALID：${taskId}成功但缺video_url，保留任务禁止重交`);
        const result = { taskId, url, lastFrame: typeof content?.last_frame_url === "string" ? content.last_frame_url : null };
        receipt.result = result; receipt.state = "succeeded"; receipt.updatedAt = new Date().toISOString();
        await save(file, receipt); return result;
      }
      if (["failed", "cancelled", "canceled"].includes(state)) {
        receipt.state = "rejected"; receipt.error = `任务${state}：${response.text.slice(0, 300)}`;
        receipt.updatedAt = new Date().toISOString(); await save(file, receipt);
        throw new Error(`渲染任务 ${receipt.error}`);
      }
      lastError = `任务${taskId}状态${state || "缺失"}`;
    }
    throw new Error(`视频轮询超时（taskId=${taskId}，恢复只查此任务）：${lastError}`);
  } finally {
    await lock.close(); await unlink(lockFile);
  }
}
