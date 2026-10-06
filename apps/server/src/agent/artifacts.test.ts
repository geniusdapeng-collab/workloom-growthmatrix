import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { link, mkdir, mkdtemp, realpath, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FilmJobRow } from "../video/film-ledger.js";
import { agentArtifactData, artifactsFromEvents, filmArtifacts, inspectAgentArtifacts } from "./artifacts.js";

const digest = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
describe("调用登记产物：实际字节、稳定索引与路径边界", () => {
  let root: string;
  beforeAll(async () => { root = await realpath(await mkdtemp(join(tmpdir(), "matrix-agent-artifacts-"))); });
  afterAll(async () => { if (root) await rm(root, { recursive: true, force: true }); });

  it("同一登记路径去重；混合未知格式后的文档保留原始索引并能取件", async () => {
    const path = join(root, "任务说明.md");
    const bytes = "# 沙箱任务回执\n这是实际写入的文档。\n";
    await writeFile(path, bytes);
    const items = artifactsFromEvents([
      { decision: { after: { outputs: [{ path: join(root, "unsupported.bin"), bytes: 3 }, { path, sha256: digest(bytes), bytes: Buffer.byteLength(bytes) }] } } },
      { decision: { after: { result: { outputs: [{ file: path, hash: digest(bytes), bytes: Buffer.byteLength(bytes) }] } } } },
    ]);
    expect(items).toHaveLength(2);
    const views = await inspectAgentArtifacts(items, [root]);
    expect(views[0]).toMatchObject({ index: 0, byteVerified: false, downloadable: false, error: "BAD_REQUEST" });
    expect(views[1]).toMatchObject({ index: 1, mime: "text/markdown", sourceVerified: true, byteVerified: true });
    const file = await agentArtifactData(items, 1, [root]);
    expect(Buffer.from(String(file.base64), "base64").toString()).toBe(bytes);
    expect(file).toMatchObject({ sha256: digest(bytes), businessVerified: false });
    await expect(agentArtifactData(items, 2, [root])).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("无登记摘要只报告已读字节，不冒充来源验证；CSV 是可读文档", async () => {
    const path = join(root, "daily.csv");
    await writeFile(path, "岗位,任务\n运营,说明\n");
    expect(await inspectAgentArtifacts([{ path }], [root])).toMatchObject([
      { mime: "text/csv", byteVerified: true, sourceVerified: false, downloadable: true },
    ]);
  });

  it("缺失、空文件、错误摘要或大小失败且保留失败元数据", async () => {
    const path = join(root, "changed.md");
    await writeFile(path, "real bytes");
    await writeFile(join(root, "empty.md"), "");
    const cases = [
      { path: join(root, "missing.md") }, { path: join(root, "empty.md") },
      { path, expectedSha256: digest("different") }, { path, expectedBytes: 123 },
    ];
    const views = await inspectAgentArtifacts(cases, [root]);
    expect(views.map(item => item.error)).toEqual(["NOT_FOUND", "PRECONDITION_FAILED", "PRECONDITION_FAILED", "PRECONDITION_FAILED"]);
    expect(views.every(item => !item.byteVerified && !item.downloadable)).toBe(true);
  });

  it("文件及父目录符号链接、硬链接均拒绝，即使链接目标仍在允许根内", async () => {
    const folder = join(root, "original");
    await mkdir(folder);
    const path = join(folder, "secret.md");
    await writeFile(path, "file link boundary");
    await symlink(path, join(root, "file-link.md"));
    await symlink(folder, join(root, "dir-link"));
    await link(path, join(root, "hard-link.md"));
    const views = await inspectAgentArtifacts([
      { path: join(root, "file-link.md") }, { path: join(root, "dir-link", "secret.md") }, { path: join(root, "hard-link.md") },
    ], [root]);
    expect(views.every(item => !item.downloadable && item.error === "FORBIDDEN")).toBe(true);
  });

  it("目录边界不是字符串前缀；超过 24 MiB 的真实文件不能取件", async () => {
    const other = root + "-outside";
    await mkdir(other);
    try {
      const path = join(other, "outside.md");
      await writeFile(path, "outside");
      await expect(agentArtifactData([{ path }], 0, [root])).rejects.toMatchObject({ code: "FORBIDDEN" });
      const big = join(root, "large.mp4");
      await writeFile(big, "a");
      await truncate(big, 24 * 1024 * 1024 + 1);
      await expect(agentArtifactData([{ path: big }], 0, [root])).rejects.toMatchObject({ code: "PAYLOAD_TOO_LARGE" });
    } finally { await rm(other, { recursive: true, force: true }); }
  });

  it("影片终态核对真实结果文件、调用身份与每个登记产物", async () => {
    const env = { HR_WORK_DIR: root };
    const job = { id: "FJ-test", workspace_id: "ws-own", project_id: "P-own", status: "finished", attempt: 1,
      run_id: "run-own", input_sha256: digest("input"), result_ref: "stages/film/attempt-1/film-result.json" } as FilmJobRow;
    const folder = join(root, "archive", job.workspace_id, job.project_id, "stages/film/attempt-1");
    await mkdir(folder, { recursive: true });
    const document = "# film stage output\n";
    await writeFile(join(folder, "review.md"), document);
    const result = { schemaVersion: "workloom.film-result/v1", jobId: job.id, projectId: job.project_id,
      runId: job.run_id, attempt: 1, inputSha256: job.input_sha256, complete: true,
      artifacts: [{ ref: "review.md", bytes: Buffer.byteLength(document), sha256: digest(document) }] };
    const bytes = JSON.stringify(result);
    await writeFile(join(folder, "film-result.json"), bytes);
    job.result_sha256 = digest(bytes);
    const files = await filmArtifacts(job, env);
    expect(await inspectAgentArtifacts(files.items, files.roots)).toMatchObject([{ byteVerified: true, sourceVerified: true }]);
    await expect(filmArtifacts({ ...job, id: "FJ-other" }, env)).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    await expect(filmArtifacts({ ...job, result_sha256: digest("tampered") }, env)).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    await expect(filmArtifacts({ ...job, result_ref: "../film-result.json" }, env)).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    await expect(filmArtifacts({ ...job, workspace_id: "../../outside" }, env)).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
  });
});
