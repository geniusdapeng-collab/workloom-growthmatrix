/** A rendered output is accepted by policy, not by a fabricated quality review. */
import { existsSync, statSync } from "node:fs";
import type { DeterministicCheck, ProducerGateOptions, ProducerStage, ProducerVerdict } from "./producer-gate.js";

export type FilmReviewPolicy = "off" | "advisory" | "blocking";
export const RENDERED_ACCEPTANCE_POLICY = "workloom.rendered-output-acceptance/v1";
const postRenderStages = new Set<ProducerStage>(["keyframe", "shot", "compose", "color", "subtitle", "mux", "danmaku", "bgm", "sfx", "cover", "master"]);
/** These describe an actual operation/file receipt, not quality or resemblance. */
const executionChecks = new Set([
  "exists", "tool-exit", "color-tool-exit", "sidecar-produced", "burned", "rendered", "sfx-produced",
  "softsub-produced", "subtitle-files", "master-untouched", "video-unchanged", "original-present",
  "generation-provenance", "enhancement-lineage", "post-chain-lineage", "variants-produced",
]);

export function filmReviewPolicy(value: unknown = "off"): FilmReviewPolicy {
  if (value === undefined || value === "") return "off";
  if (value !== "off" && value !== "advisory" && value !== "blocking") throw new Error("FILM_REVIEW_POLICY_INVALID: off / advisory / blocking");
  return value;
}

export function renderedAcceptanceReceipt(policy: FilmReviewPolicy) {
  return { policy: RENDERED_ACCEPTANCE_POLICY, reviewPolicy: policy, acceptance: "rendered-output-accepted",
    qualityReviewed: false, identityReviewed: false, speechVerified: false } as const;
}

/** Preserve measured failures as information; only execution failures can block off mode. */
export function postRenderChecks<T extends DeterministicCheck>(checks: readonly T[], policy: FilmReviewPolicy): T[] {
  return checks.map(check => policy === "off" ? { ...check, hard: executionChecks.has(check.id) && check.hard === true } : { ...check });
}

/** Null means the explicitly requested review should run. Off never calls a model or parent review. */
export function reviewWithoutModel(options: Omit<ProducerGateOptions, "contracts">, policy: FilmReviewPolicy): ProducerVerdict | null {
  if (policy !== "off") return null;
  const post = postRenderStages.has(options.stage);
  const checks = post ? postRenderChecks(options.deterministic, policy) : options.deterministic;
  const failures = checks.filter(check => check.hard && (check.status === "failed" || (check.status === undefined && !check.pass)))
    .map(check => `${check.id}: ${check.detail}`);
  // The acceptance policy cannot turn a missing/unreadable artifact into a successful operation.
  for (const artifact of options.artifacts) {
    try {
      if (!existsSync(artifact.path) || !statSync(artifact.path).isFile() || statSync(artifact.path).size === 0) failures.push(`ARTIFACT_MISSING_OR_EMPTY: ${artifact.path}`);
    } catch (error) { failures.push(`ARTIFACT_UNREADABLE: ${artifact.path}: ${error instanceof Error ? error.message : String(error)}`); }
  }
  return { stage: options.stage, approved: failures.length === 0, status: failures.length ? "failed" : "passed",
    score: 0, via: "deterministic", hardFailures: failures,
    issues: options.deterministic.filter(check => !check.pass).map(check => `${check.id}: ${check.detail}`),
    suggestions: [], rerun: failures.length > 0, ms: 0, degraded: false, evidence: [],
    reason: failures.length ? `执行失败：${failures.join("；")}` : post
      ? `${RENDERED_ACCEPTANCE_POLICY}：渲染产物按策略接收，直接进入后期；未进行模型、身份或质量复审，score=0 为未评分`
      : "review-policy off：只核对提交前确定性规则，未调用评审模型，score=0 为未评分" };
}
