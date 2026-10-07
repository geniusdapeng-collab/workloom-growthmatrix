import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { filmReviewPolicy, postRenderChecks, renderedAcceptanceReceipt, reviewWithoutModel } from "./rendered-output-policy.js";
import type { ProducerGateOptions } from "./producer-gate.js";
const dirs: string[] = [];
function input(stage: ProducerGateOptions["stage"] = "shot"): ProducerGateOptions {
  const dir = mkdtempSync(join(tmpdir(), "rendered-policy-")); dirs.push(dir);
  const path = join(dir, "clip.mp4"); writeFileSync(path, "provider output bytes");
  return { stage, projectId: "P1", artifacts: [{ path, kind: "video" }], deterministic: [
    { id: "motion-evidence", pass: false, hard: true, detail: "static shot" },
    { id: "duration", pass: false, hard: true, detail: "outside old tolerance" },
  ] };
}
afterEach(() => dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })));
describe("rendered output acceptance", () => {
  it.each(["keyframe", "shot", "compose", "color", "subtitle", "mux", "danmaku", "bgm", "sfx", "cover", "master"] as const)("accepts %s without quality admission", stage => {
    const verdict = reviewWithoutModel(input(stage), "off")!;
    expect(verdict.approved).toBe(true); expect(verdict.score).toBe(0); expect(verdict.via).toBe("deterministic");
    expect(verdict.reason).toContain("未进行模型、身份或质量复审"); expect(verdict.issues).toHaveLength(2);
  });
  it("keeps missing files and operation failures as execution failures", () => {
    const options = input(); rmSync(options.artifacts[0]!.path);
    expect(reviewWithoutModel(options, "off")?.approved).toBe(false);
    const options2 = input(); options2.deterministic.push({ id: "tool-exit", pass: false, hard: true, detail: "ffmpeg failed" });
    expect(reviewWithoutModel(options2, "off")?.hardFailures.join()).toContain("ffmpeg failed");
  });
  it("preserves submission checks and requires explicit opt-in to review", () => {
    expect(reviewWithoutModel(input("prompt"), "off")?.approved).toBe(false);
    expect(reviewWithoutModel(input(), "blocking")).toBeNull(); expect(reviewWithoutModel(input(), "advisory")).toBeNull();
    expect(filmReviewPolicy()).toBe("off"); expect(() => filmReviewPolicy("auto")).toThrow("INVALID");
  });
  it("does not rewrite quality observations or claim speech/identity verification", () => {
    const checks = input().deterministic;
    expect(postRenderChecks(checks, "off")[0]).toEqual({ ...checks[0], hard: false });
    expect(checks[0]!.hard).toBe(true);
    expect(renderedAcceptanceReceipt("off")).toMatchObject({ qualityReviewed: false, identityReviewed: false, speechVerified: false });
  });
});
