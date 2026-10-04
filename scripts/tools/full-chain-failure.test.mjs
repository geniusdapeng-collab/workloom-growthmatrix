/** Execute the current production stage/loops with controlled provider failures.
 * The compiler only removes TypeScript syntax; the loops, catch blocks, and
 * manifest/record assignments come verbatim from full-chain-film.mts.
 * Files, media tools, and providers are fixture adapters: no paid request runs.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { it } from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript-governance";

const filmPath = new URL("./full-chain-film.mts", import.meta.url);
const source = ts.createSourceFile(filmPath.pathname, readFileSync(filmPath, "utf8"), ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
const compilerOptions = { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS };
const transpile = (code) => ts.transpileModule(code, { compilerOptions, reportDiagnostics: true }).outputText;
const declaration = (name) => {
  const statements = source.statements.filter((node) => ts.isVariableStatement(node)
    && node.declarationList.declarations.some((item) => ts.isIdentifier(item.name) && item.name.text === name));
  assert.equal(statements.length, 1, `production declaration ${name} must be unique`);
  return statements[0].getText(source);
};
const stage = (name) => {
  const containsStage = (node) => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
      && node.expression.expression.getText(source) === "STAGES"
      && node.expression.name.text === "has" && node.arguments[0]?.text === name) return true;
    return Boolean(ts.forEachChild(node, containsStage));
  };
  const statements = source.statements.filter((node) => ts.isIfStatement(node) && containsStage(node.expression));
  assert.equal(statements.length, 1, `production stage ${name} must be unique`);
  return statements[0];
};
const materialPolicy = { exports: {} };
runInNewContext(transpile(readFileSync(new URL("../../packages/video-studio/src/material-policy.ts", import.meta.url), "utf8")),
  materialPolicy, { timeout: 1000, filename: "production-material-policy.js" });
const predicates = ["isMaterialShot", "ASSET_REF_PATTERN", "isAssetRefLocal", "assetRefOf", "isAssetShot", "isProductMaterialShot", "materialShots", "localReviewRefsEarly"]
  .map(declaration).join("\n");
const materialCode = stage("material-gen").getText(source);
const videoStage = stage("videos");
assert.ok(ts.isBlock(videoStage.thenStatement));
const videoLoops = videoStage.thenStatement.statements.filter((node) => ts.isForOfStatement(node)
  && node.expression.getText(source) === "FIRST_PASS_ORDER");
assert.equal(videoLoops.length, 1, "production sequential video loop must be unique");
const refsDeclaration = videoStage.thenStatement.statements.find((node) => ts.isVariableStatement(node)
  && node.declarationList.declarations.some((item) => item.name.getText(source) === "refsForShot"));
assert.ok(refsDeclaration, "production video reference resolver must exist");
const videoCode = refsDeclaration.getText(source) + "\n" + videoLoops[0].getText(source);
const submitGuard = source.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === "preflightSubmitGuard");
assert.ok(submitGuard);
const renderSeconds = source.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === "renderSecondsFor");
assert.ok(renderSeconds);
const renderSecondsCode = [declaration("RENDER_SECONDS_MIN"), declaration("RENDER_SECONDS_MAX"), renderSeconds.getText(source)].join("\n");

function shot(kind, id) {
  return {
    shotId: id, duration: 5, scene: "空白背景上的主角", camera_movement: "固定机位，自然动作",
    ...(kind.includes("material") ? { photo: `/fixture/${id}.jpg`, materialUsage: "generation-reference" } : {}),
    ...(kind === "product-material" ? { productRef: { id: "fixture-product" } } : {}),
    ...(kind.startsWith("asset") ? { assetRef: "asset://fixture-person" } : {}),
  };
}
async function renderSequence(kind, attempts = 1, options = {}) {
  const rows = [], submissions = [], gates = [];
  const shots = [shot(kind, "S-01"), shot(kind, "S-02")];
  const context = {
    ...materialPolicy.exports, Error, join, basename, createHash,
    shots, FIRST_PASS_ORDER: shots, STAGES: new Set(["material-gen"]),
    SOURCE_SIZE: { width: 720, height: 1280 }, ASPECT: "9:16", SOURCE_RESOLUTION: "720p",
    CLIP_DIR: "/fixture/clips", PLATE_DIR: "/fixture/plates", PROMPT_DIR: "/fixture/prompts",
    shotlist: { title: "controlled fault fixture" }, ENV: {}, MAX_ATTEMPTS: attempts,
    MATERIAL_POST_ONLY: false, RESUME: false, DRY_RUN: false, MATERIAL_SPEED_RAMP: false,
    MATERIAL_POST_CAMERA_MOVE: false, MATERIAL_PHOTO_TAIL_TRIM: false,
    WORK_DIR: "/fixture/work", PROJECT: "fixture-film", scenePolicy: null,
    REFERENCE_INDEPENDENCE_POLICY: {}, ALLOW_FALLBACK_APPROVE: false,
    productLibrary: { byId: new Map() }, identityAnchors: new Map(),
    FFMPEG: "fixture-ffmpeg", refs: [], ceoIdentityAnchorFrame: null,
    realPersonLibrary: { byAssetId: new Map() }, assetIdOf: () => "fixture-person", REVISION_CONTEXT: "", FPS: 30,
    ACCEPT_REJECTED: [], VIDEO_MODEL: "fixture-provider",
    abs: (value) => value, existsSync: (value) => !options.missingMaterial || !value.endsWith(".jpg"), statSync: () => ({ size: 100001 }),
    run: () => {}, writeFileSync: () => {}, rememberInputs: () => {}, log: () => {},
    sha256FileSync: (file) => (file.endsWith(".mp4") ? "b" : "a").repeat(64), flag: () => false, retryInstruction: () => "change from failure feedback",
    readFileSync: () => "【约束】9:16 " + "自然摄影".repeat(400),
    loadHostedUrl: () => null, dataUrl: () => "fixture-reference",
    record: (row) => { rows.push(row); return row; },
    recordGate: (gate) => { gates.push(gate); return { approved: !options.blockedGate, reason: "fixture prerequisites" }; },
    download: async () => {}, execFileSync: () => {}, mkdirSync: () => {},
    normalizeClipDuration: (_in, _out, duration) => ({ from: duration, to: duration, factor: 1 }),
    probe: () => ({ duration: 5, width: 720, height: 1280, hasAudio: true, acodec: "aac" }),
    measureMotionRichness: () => ({ meanEnergy: 10, maxEnergy: 20, rampRatio: 2, frames: 40, peakAtSec: 2 }),
    measureMotionEnergy: () => ({ energy: 10, peakAt: 2 }),
    measureMaterialReuse: () => ({ samples: [2, 4].map((atSec) => ({ atSec, bestPsnrDb: 15, bestSsim: 0.3 })), candidates: 2 }),
    measureReferenceIndependence: () => ({ candidates: 2 }),
    assessReferenceIndependence: () => ({ independent: true, detail: "controlled media measurement" }),
    rememberIdentityAnchor: () => {}, dialogueText: () => "", localReviewRefs: () => [],
    reviewStage: async () => ({ approved: options.reviewApproved !== false, degraded: Boolean(options.judgeUnavailable),
      via: options.judgeUnavailable ? "fallback" : "fixture-review", hardFailures: [], reason: "controlled reviewer result", ms: 1 }),
    arkVideo: async (request) => {
      submissions.push(request.shotId);
      if (options.providerFails !== false) throw new Error(`INJECTED_PROVIDER_FAILURE:${request.shotId}`);
      return { taskId: `fixture-task-${request.shotId}`, url: "fixture-media" };
    },
  };
  const code = kind.includes("material") ? materialCode : videoCode;
  let failure = null;
  try {
    await runInNewContext(transpile(`(async () => { ${predicates}\n${submitGuard.getText(source)}\n${renderSecondsCode}\n${code} })()`),
      context, { timeout: 1000, filename: "production-film-failure-fixture.js" });
  } catch (error) {
    failure = error;
  }
  return { rows, submissions, gates, failure };
}

for (const [kind, attempts] of [["product-material", 2], ["asset-material", 1], ["asset-video", 1]]) {
  it(`canary ${kind} failure stops the next provider submission and retains the failure record`, { timeout: 5000 }, async () => {
    const result = await renderSequence(kind, attempts);
    assert.ok(result.rows.some((row) => String(row.evidence.error).startsWith("INJECTED_PROVIDER_FAILURE:S-01")),
      "the actual production loop must record the injected failure before aborting");
    assert.match(result.failure?.message ?? "", /^CANARY_ABORT:/, "fatal canary must escape the sequential loop");
    assert.deepEqual(result.submissions, Array(attempts).fill("S-01"), "no S-02 request may follow a failed canary");
  });
}
for (const kind of ["ordinary-material", "ordinary-video"]) {
  it(`ordinary ${kind} failure is recorded and the existing next-shot behavior is preserved`, { timeout: 5000 }, async () => {
    const result = await renderSequence(kind);
    assert.equal(result.failure, null, JSON.stringify(result.rows));
    assert.deepEqual(result.submissions, ["S-01", "S-02"]);
    assert.equal(result.rows.filter((row) => String(row.evidence.error).startsWith("INJECTED_PROVIDER_FAILURE:")).length, 2);
  });
}
for (const kind of ["product-material", "asset-material", "asset-video"]) {
  it(`canary ${kind} approved first shot proceeds to the next shot`, { timeout: 5000 }, async () => {
    const result = await renderSequence(kind, 2, { providerFails: false });
    assert.equal(result.failure, null);
    assert.deepEqual(result.submissions, ["S-01", "S-02"]);
    assert.equal(result.rows.filter((row) => row.ok && row.invoked).length, 2);
  });
  it(`canary ${kind} review rejection retains the artifact and stops subsequent submissions`, { timeout: 5000 }, async () => {
    const result = await renderSequence(kind, 1, { providerFails: false, reviewApproved: false });
    assert.match(result.failure?.message ?? "", /^CANARY_ABORT:/);
    assert.deepEqual(result.submissions, ["S-01"]);
    assert.ok(result.rows.some((row) => !row.ok && row.artifact));
  });
  it(`canary ${kind} blocked submit gate stops before any provider request`, { timeout: 5000 }, async () => {
    const result = await renderSequence(kind, 1, { blockedGate: true });
    assert.match(result.failure?.message ?? "", /^CANARY_ABORT:/);
    assert.deepEqual(result.submissions, []);
    assert.ok(result.rows.some((row) => row.evidence.gateBlocked));
  });
}
it("canary asset-video unavailable reviewer retains the clip and avoids rerendering or later shots", { timeout: 5000 }, async () => {
  const result = await renderSequence("asset-video", 2, { providerFails: false, reviewApproved: false, judgeUnavailable: true });
  assert.match(result.failure?.message ?? "", /^CANARY_ABORT:/);
  assert.deepEqual(result.submissions, ["S-01"]);
  assert.ok(result.rows.some((row) => row.artifact && row.evidence.judgeUnavailable));
});
for (const kind of ["product-material", "asset-material"]) {
  it(`canary ${kind} missing source material stops before the next shot`, { timeout: 5000 }, async () => {
    const result = await renderSequence(kind, 1, { missingMaterial: true });
    assert.match(result.failure?.message ?? "", /^CANARY_ABORT:/);
    assert.deepEqual(result.submissions, []);
    assert.ok(result.rows.some((row) => row.evidence.missing));
  });
}

async function bgmStage({ signing = false, declared = false, output = true, noBgm = false }) {
  const rows = [], reviews = [];
  const out = "/fixture/post/master-scored.mp4";
  const context = {
    Error, join, basename, STAGES: new Set(["bgm"]), danmakuOut: "/fixture/source.mp4", scored: "/fixture/source.mp4",
    POST_DIR: "/fixture/post", PROJECT: "fixture-film", REVIEW_POLICY: "off", ENV: {}, ALLOW_FALLBACK_APPROVE: false, BGM_CLI: "fixture-bgm",
    BRIEF_FILE: "", CUT_GRID: [5], shots: [], shotlist: { title: "fixture film" }, bgmManifestInfo: null,
    process: { env: { WORKLOOM_AUDIO_STEM_SIGNING_SECRET: signing ? "unit-fixture-signing-present" : "" } },
    flag: (name) => declared && name === "--bgm-declared-program-mix",
    arg: (_name, fallback = "") => fallback,
    existsSync: (file) => file !== out || output, rememberInputs: () => {}, log: () => {},
    runCli: () => ({ ok: output || noBgm, out: noBgm ? "no_bgm_needed" : output ? "mix succeeded" : "fixture provider unavailable" }),
    pickGridCompatibleBed: async () => null,
    probe: () => ({ duration: 10, hasAudio: true, acodec: "aac" }),
    measureLoudness: () => ({ lufs: -14, peakDb: -1.5, detail: "fixture loudness" }),
    reviewStage: async (review) => { reviews.push(review); return { approved: true, degraded: false }; },
    record: (row) => { rows.push(row); return row; },
  };
  await runInNewContext(transpile(`(async () => { ${declaration("BGM_DECLARED_PROGRAM_MIX")}\n${stage("bgm").getText(source)} })()`),
    context, { timeout: 1000, filename: "production-bgm-stage-fixture.js" });
  assert.equal(rows.length, 1, "actual BGM stage must produce one source receipt");
  return { manifest: context.bgmManifestInfo, record: rows[0], reviews };
}
for (const [name, fixture, authority, verified, layer] of [
  ["automatic declaration without signing", {}, "declared-unverified", false, "on"],
  ["explicit declaration even with signing", { signing: true, declared: true }, "declared-unverified", false, "on"],
  ["signed produced stems", { signing: true }, "signed-stems", true, "on"],
  ["no music required with signing", { signing: true, output: false, noBgm: true }, "declared-unverified", false, "off"],
  ["missing output in signed mode", { signing: true, output: false }, "declared-unverified", false, "on"],
]) {
  it(`BGM ${name}: delivery manifest and source receipt state the same authority`, { timeout: 5000 }, async () => {
    const result = await bgmStage(fixture);
    assert.equal(result.manifest.sourceAuthority, authority);
    assert.equal(result.manifest.stemsVerified, verified);
    assert.equal(result.manifest.layer, layer);
    assert.equal(result.record.evidence.sourceAuthority, authority);
    assert.equal(result.record.evidence.stemsVerified, verified);
    assert.equal(result.manifest.output !== null, fixture.output !== false);
  });
}
