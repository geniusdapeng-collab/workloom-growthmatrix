import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { qaReportAllowsDelivery, runMachineGates } from "./qa-gates.js";
import { QaReportSchema } from "./types.js";

let root: string;
const ffmpeg = process.env.FFMPEG_PATH?.trim() || "ffmpeg";
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "wl-explainer-policy-"));
  mkdirSync(join(root, "out"));
  execFileSync(ffmpeg, ["-v", "error", "-y", "-f", "lavfi", "-i", "color=c=black:s=32x32:r=30:d=0.3",
    "-an", "-c:v", "libx264", "-pix_fmt", "yuv420p", join(root, "out", "v1.mp4")]);
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("explainer rendered acceptance policy", () => {
  it("default accepts an actual readable movie without installing or running any quality script", async () => {
    const before = readFileSync(join(root, "out", "v1.mp4"));
    const result = await runMachineGates({ jobDir: root, cards: ["actual-card"], cueCount: 3,
      engineDir: join(root, "nonexistent-engine"), env: process.env });
    expect(result.report).toMatchObject({ pass: false, accepted: true, reviewPolicy: "off", qualityReviewed: false });
    expect(result.report.gates).toHaveLength(6);
    expect(result.report.gates.every(g => g.status === "skip" && g.command === "")).toBe(true);
    expect(qaReportAllowsDelivery(result.report)).toBe(true);
    expect(existsSync(result.qaFramesDir)).toBe(false);
    expect(readFileSync(join(root, "out", "v1.mp4"))).toEqual(before);
    expect(QaReportSchema.parse(JSON.parse(readFileSync(join(root, "out", "qa-report.json"), "utf8")))).toEqual(result.report);
  });

  it.each(["advisory", "blocking"] as const)("%s preserves an unavailable check without changing the produced movie", async reviewPolicy => {
    const before = readFileSync(join(root, "out", "v1.mp4"));
    const result = await runMachineGates({ jobDir: root, cards: [], cueCount: 0,
      engineDir: join(root, "nonexistent-engine"), env: { ...process.env, TALKCRAFT_PYTHON: join(root, "missing-checker") }, reviewPolicy });
    expect(result.report).toMatchObject({ pass: false, accepted: reviewPolicy === "advisory", reviewPolicy, qualityReviewed: false });
    expect(result.report.gates[0]).toMatchObject({ gate: "review_execution", status: "fail" });
    expect(result.report.gates[0]!.summary).toContain("ENOENT");
    expect(readFileSync(join(root, "out", "v1.mp4"))).toEqual(before);
  });

  it.each(["advisory", "blocking"] as const)("%s retains measured failures and only blocking refuses admission", async reviewPolicy => {
    const runner = join(root, "checker");
    writeFileSync(runner, `#!${process.execPath}\nconst fs=require('node:fs');const path=require('node:path');
const args=process.argv.slice(2), name=path.basename(args[0]);
if(name==='motion_check.py'){process.stdout.write('FAIL static segment\\n');process.exit(1);}
if(name==='qa_extract.py') {fs.mkdirSync(args[3],{recursive:true});fs.writeFileSync(path.join(args[3],'frame.png'),'fixture');}
if(name==='contact_sheet.py') {fs.mkdirSync(args[2],{recursive:true});fs.writeFileSync(path.join(args[2],'sheet.png'),'fixture');}
process.stdout.write('PASS fixture check\\n');\n`, { mode: 0o700 });
    const result = await runMachineGates({ jobDir: root, cards: [], cueCount: 0, reviewPolicy,
      env: { ...process.env, TALKCRAFT_PYTHON: runner }, engineDir: join(root, "fixture-engine") });
    expect(result.report).toMatchObject({ pass: false, accepted: reviewPolicy === "advisory", qualityReviewed: true });
    expect(result.report.gates.find(g => g.gate === "motion_check")).toMatchObject({ status: "fail", summary: "FAIL static segment" });
    expect(qaReportAllowsDelivery(result.report)).toBe(reviewPolicy === "advisory");
  });

  it.each(["missing", "empty", "unreadable"])("%s actual output is an execution failure even with review off", async state => {
    const job = join(root, state); mkdirSync(join(job, "out"), { recursive: true });
    if (state !== "missing") writeFileSync(join(job, "out", "v1.mp4"), state === "empty" ? "" : "not a video");
    await expect(runMachineGates({ jobDir: job, cards: [], cueCount: 0 })).rejects.toThrow();
  });

  it("invalid policy refuses before external checks; legacy reports keep their real pass state", async () => {
    await expect(runMachineGates({ jobDir: root, cards: [], cueCount: 0, reviewPolicy: "unknown" as "off" })).rejects.toThrow("POLICY_INVALID");
    expect(qaReportAllowsDelivery({ jobId: root, totalFrames: null, gates: [], pass: false })).toBe(false);
    expect(qaReportAllowsDelivery({ jobId: root, totalFrames: null, gates: [], pass: true })).toBe(true);
  });
});
