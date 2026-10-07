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
assert.equal(source.parseDiagnostics.length, 0, "production film source must parse without errors");
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
  const person = { asset: { assetId: "fixture-person" } };
  const context = {
    ...materialPolicy.exports, Error, join, basename, createHash,
    cachedProviderSources: new Map(), acceptExistingRenderedClip: () => false, reusableProviderClip: () => null,
    recordProviderSource: () => {}, requiresGeneration: () => true,
    inspectPostInput: ({ file }) => ({ path: file, durationSec: 5, width: 720, height: 1280, hasAudio: true, sha256: "b".repeat(64), qualityReviewed: false }),
    postAcceptanceVerdict: () => ({ approved: true, degraded: false, status: "passed", score: null, hardFailures: [], rerun: false }),
    POST_RENDER_ACCEPTANCE_POLICY: "workloom.provider-success-direct-post/v1",
    shots, FIRST_PASS_ORDER: shots, STAGES: new Set(["material-gen"]),
    SOURCE_SIZE: { width: 720, height: 1280 }, ASPECT: "9:16", SOURCE_RESOLUTION: "720p",
    CLIP_DIR: "/fixture/clips", PLATE_DIR: "/fixture/plates", PROMPT_DIR: "/fixture/prompts",
    shotlist: { title: "controlled fault fixture" }, ENV: {}, MAX_ATTEMPTS: attempts,
    MATERIAL_POST_ONLY: false, RESUME: false, DRY_RUN: false, MATERIAL_SPEED_RAMP: false,
    MATERIAL_POST_CAMERA_MOVE: false, MATERIAL_PHOTO_TAIL_TRIM: false,
    WORK_DIR: "/fixture/work", PROJECT: "fixture-film", scenePolicy: null,
    REFERENCE_INDEPENDENCE_POLICY: {}, ALLOW_FALLBACK_APPROVE: false,
    productLibrary: { byId: new Map() }, identityAnchors: new Map(),
    realPersons: new Map(kind === "asset-material" ? shots.map(item => [item.shotId, person]) : []),
    realPersonAnchors: new Map(shots.map(item => [item.shotId, { path: "/fixture/identity.jpg" }])),
    productionClipFile: (id) => join("/fixture/clips", `${id}.mp4`),
    stageApproved: (name, ids) => rows.some(row => row.stage === name && ids.includes(row.shotId) && row.ok),
    FFPROBE: "fixture-ffprobe", FFMPEG: "fixture-ffmpeg", refs: [], ceoIdentityAnchorFrame: null,
    realPersonLibrary: { byAssetId: new Map() }, assetIdOf: () => "fixture-person", REVISION_CONTEXT: "", FPS: 30,
    ACCEPT_REJECTED: [], VIDEO_MODEL: "fixture-provider",
    abs: (value) => value, existsSync: (value) => !options.missingMaterial || !value.endsWith(".jpg"), statSync: () => ({ size: 100001 }),
    run: () => {}, copyFileSync: () => {}, writeFileSync: () => {}, rememberInputs: () => {}, log: () => {},
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
    buildRenderReferences: ({ asset }) => ({ refs: asset ? ["asset://fixture-person", "fixture-reference"] : ["fixture-reference"],
      prompt: "保持完整商品原图及登记身份；" + "摄影场景正文".repeat(250) }),
    filmContractSource: {}, identityReviewContext: () => ({ displayName: "controlled identity" }),
    reviewFilmStage: async () => { throw new Error("POST_IDENTITY_REVIEW_MUST_NOT_RUN"); },
    reviewStage: async () => { throw new Error("POST_QUALITY_REVIEW_MUST_NOT_RUN"); },
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

for (const kind of ["ordinary-material", "product-material", "asset-material", "ordinary-video", "asset-video"]) {
  it(`${kind}: genuine provider failure is recorded and stops further paid submissions`, { timeout: 5000 }, async () => {
    const result = await renderSequence(kind, 3);
    assert.match(result.failure?.message ?? "", /^INJECTED_PROVIDER_FAILURE:S-01/);
    assert.deepEqual(result.submissions, ["S-01"]);
    assert.ok(result.rows.some(row => String(row.evidence.error).startsWith("INJECTED_PROVIDER_FAILURE:S-01")));
  });
  for (const opinion of [{ identityApproved: false }, { reviewApproved: false }, { judgeUnavailable: true }]) {
    it(`${kind}: success enters post and never invokes ${Object.keys(opinion)[0]} quality review or rerender`, async () => {
      const result = await renderSequence(kind, 3, { ...opinion, providerFails: false });
      assert.equal(result.failure, null, result.failure?.stack);
      assert.deepEqual(result.submissions, ["S-01", "S-02"]);
      assert.equal(result.rows.filter(row => row.stage === "identity-fact").length, 0);
      const completed = result.rows.filter(row => row.stage === (kind.includes("material") ? "material-gen" : "shot") && row.ok);
      assert.equal(completed.length, 2);
      assert.ok(completed.every(row => row.evidence.qualityReviewed === false && row.verdict.score === null));
    });
  }
  it(`${kind}: rejected submit authorization stops before provider`, async () => {
    const result = await renderSequence(kind, 2, { blockedGate: true });
    assert.match(result.failure?.message ?? "", kind.includes("material") ? /^MATERIAL_SUBMIT_BLOCKED/ : /^RENDER_SUBMIT_BLOCKED/);
    assert.deepEqual(result.submissions, []);
  });
}
for (const kind of ["ordinary-material", "product-material", "asset-material"]) {
  it(`${kind}: missing new-generation reference stops before paid submission`, async () => {
    const result = await renderSequence(kind, 2, { missingMaterial: true });
    assert.match(result.failure?.message ?? "", /^MATERIAL_REFERENCE_MISSING/);
    assert.deepEqual(result.submissions, []);
  });
}

it("worker video submission retains the parent stage, shot and artifact context without calling the direct provider", async () => {
  const ark = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === "arkVideo");
  assert.ok(ark);
  const calls = [], input = { stage: "material-gen", shotId: "S-02", target: "/fixture/clips/S-02.raw.mp4",
    prompt: "controlled production prompt", refs: ["asset://fixture-person"], seconds: 5, generateAudio: true };
  const context = {
    WORKER_RUNTIME: { video: async options => { calls.push(options); return { taskId: "worker-parent-task", url: "parent-artifact", lastFrame: null }; } },
    resumeOrSubmitVideoTask: () => { throw new Error("DIRECT_PROVIDER_MUST_NOT_RUN_IN_WORKER"); },
  };
  const invoke = runInNewContext(transpile(`${ark.getText(source)}\narkVideo;`), context);
  const result = await invoke(input);
  assert.equal(calls.length, 1);
  assert.equal(calls[0], input);
  assert.equal(result.taskId, "worker-parent-task");
});

it("direct video submission passes the exact request into persistent task recovery", async () => {
  const ark = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === "arkVideo");
  const bodyBuilder = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === "arkVideoBody");
  assert.ok(ark && bodyBuilder);
  const calls = [];
  const context = { WORKER_RUNTIME: null, join, WORK_DIR: "/fixture/work", PROJECT: "fixture-film",
    ARK_KEY: "", VIDEO_MODEL: "fixture-provider", ASPECT: "9:16", SOURCE_RESOLUTION: "720p",
    resumeOrSubmitVideoTask: async options => { calls.push(options); return { taskId: "saved-provider-task", url: "fixture-result", lastFrame: null }; },
  };
  const invoke = runInNewContext(transpile(`${bodyBuilder.getText(source)}\n${ark.getText(source)}\narkVideo;`), context);
  const result = await invoke({ stage: "videos", shotId: "S-01", target: "/fixture/clips/S-01.mp4",
    prompt: "complete controlled prompt", refs: ["asset://fixture-person", "data:image/png;base64,YQ=="], seconds: 5, generateAudio: true });
  assert.equal(result.taskId, "saved-provider-task");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].root, "/fixture/work/render-task-receipts");
  assert.equal(calls[0].projectId, "fixture-film");
  assert.equal(calls[0].shotId, "S-01");
  assert.equal(calls[0].body.content[1].image_url.url, "asset://fixture-person");
  assert.equal(calls[0].body.content[2].image_url.url, "data:image/png;base64,YQ==");
  assert.equal(typeof calls[0].transport.submit, "function");
  assert.equal(typeof calls[0].transport.poll, "function");
});

async function bgmStage({ signing = false, declared = false, output = true, toolOk = true, noMusic = false, chosen = false }) {
  const rows = [], reviews = [], calls = [];
  const out = "/fixture/post/master-scored.mp4";
  const context = {
    Error, join, basename, STAGES: new Set(["bgm"]), danmakuOut: "/fixture/source.mp4", scored: "/fixture/source.mp4",
    POST_DIR: "/fixture/post", PROJECT: "fixture-film", ENV: {}, BGM_CLI: "fixture-bgm", DRY_RUN: false,
    CUT_GRID: [5], bgmManifestInfo: null,
    process: { env: { WORKLOOM_AUDIO_STEM_SIGNING_SECRET: signing ? "unit-fixture-signing-present" : "" } },
    flag: name => name === "--no-music" ? noMusic : name === "--bgm-declared-program-mix" && declared,
    arg: (name, fallback = "") => name === "--bgm-track" && chosen ? "/fixture/music.wav" : fallback,
    existsSync: file => file !== out || output, rememberInputs: () => {}, log: () => {},
    runCli: (_cli, args) => { calls.push(args); return { ok: toolOk, out: toolOk ? "mix succeeded" : "fixture tool failure" }; },
    probe: () => ({ duration: 10, hasAudio: true, acodec: "aac" }),
    measureLoudness: () => { throw new Error("ACOUSTIC_REVIEW_MUST_NOT_RUN"); },
    reviewStage: async review => { reviews.push(review); return { approved: review.artifacts.length > 0, degraded: false, reason: "actual output" }; },
    record: row => { rows.push(row); return row; },
  };
  let failure = null;
  try { await runInNewContext(transpile(`(async () => { ${stage("bgm").getText(source)} })()`),
    context, { timeout: 1000, filename: "production-bgm-stage-fixture.js" }); }
  catch (error) { failure = error; }
  assert.equal(rows.length, 1, "actual BGM stage must produce one source receipt");
  return { manifest: context.bgmManifestInfo, record: rows[0], reviews, calls, failure };
}
for (const [name, fixture] of [
  ["without signing or declaration", {}], ["legacy explicit declaration", { declared: true }],
  ["signing configured without supplied stems", { signing: true }], ["requested track", { chosen: true }],
]) {
  it(`BGM ${name}: transforms once with truthful original program authority and no acoustic review`, async () => {
    const result = await bgmStage(fixture);
    assert.equal(result.failure, null, result.failure?.stack);
    assert.equal(result.calls.length, 1); assert.equal(result.calls[0][0], fixture.chosen ? "mix" : "best");
    assert.equal(result.manifest.sourceAuthority, "original-program-bytes");
    assert.equal(result.manifest.stemsVerified, false); assert.equal(result.record.evidence.qualityReviewed, false);
    assert.equal(result.manifest.layer, "on"); assert.equal(result.record.ok, true);
    assert.ok(result.reviews.every(review => !review.deterministic.some(check => /loudness|peak|scored/.test(check.id))));
  });
}
it("BGM explicit no-music preserves the source and records an inapplicable requested layer", async () => {
  const result = await bgmStage({ noMusic: true });
  assert.equal(result.failure, null); assert.equal(result.calls.length, 0); assert.equal(result.manifest.layer, "off");
  assert.equal(result.record.invoked, false); assert.equal(result.record.artifact, "/fixture/source.mp4");
});
for (const fixture of [{ output: false }, { toolOk: false }]) {
  it(`BGM ${JSON.stringify(fixture)}: actual missing output or tool failure stops the pipeline`, async () => {
    const result = await bgmStage(fixture);
    assert.match(result.failure?.message ?? "", /^BGM_POST_FAILED:/); assert.equal(result.record.ok, false);
    assert.equal(result.calls.length, 1);
  });
}

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync, execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const mediaFfmpeg = process.env.WL_FFMPEG || process.env.FFMPEG_PATH || "ffmpeg";
const mediaFfprobe = process.env.WL_FFPROBE || process.env.FFPROBE_PATH || "ffprobe";
const actualMediaAvailable = (() => { try {
  execFileSync(mediaFfmpeg, ["-version"], { stdio: "ignore" }); execFileSync(mediaFfprobe, ["-version"], { stdio: "ignore" }); return true;
} catch { return false; } })();

function makeActualCliFixture(root, scenario) {
  const project = `provider-direct-post-${scenario}`;
  const work = join(root, "work"), out = join(root, "out"), source = join(root, "source.json"), keys = join(root, "empty.env");
  const raw = join(work, "clips", project, "S1.raw.mp4");
  fs.mkdirSync(path.dirname(raw), { recursive: true }); fs.writeFileSync(keys, "");
  const document = { title: "成功原片的正式后期", aspect: "16:9", resolution: "720p", durationSeconds: 10,
    eraProfile: { storyDate: "2026-10-07", devicePolicy: "story-compatible" },
    shots: [{ shotId: "S1", duration: 10, scene: "成功供应商静黑素材", dialogue: [{ text: "本地后期默认素材" }] }] };
  fs.writeFileSync(source, JSON.stringify(document, null, 2) + "\n");
  execFileSync(mediaFfmpeg, ["-v", "error", "-y", "-f", "lavfi", "-i", "color=c=black:s=162x90:r=23",
    "-t", "10.04", "-an", "-c:v", "libx264", "-pix_fmt", "yuv420p", raw], { timeout: 30000 });
  const music = join(root, "music.wav"), danmaku = join(root, "danmaku.json");
  execFileSync(mediaFfmpeg, ["-v", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=220:duration=0.25", "-c:a", "pcm_s16le", music], { timeout: 30000 });
  fs.writeFileSync(danmaku, JSON.stringify([{ at: 0.1, text: "完整正式后期" }]));
  const setup = `import fs from 'node:fs';import path from 'node:path';
import {productionHash,createLineageReceipt} from ${JSON.stringify(pathToFileURL(join(repositoryRoot, "packages/video-studio/src/production-lineage.ts")).href)};
import {loadOrCreateFilmAuthorContext} from ${JSON.stringify(pathToFileURL(join(repositoryRoot, "packages/video-studio/src/film-contracts.ts")).href)};
import {videoTaskReceiptPath} from ${JSON.stringify(pathToFileURL(join(repositoryRoot, "packages/video-studio/src/video-task-receipt.ts")).href)};
const source=${JSON.stringify(source)}, raw=${JSON.stringify(raw)}, work=${JSON.stringify(work)}, project=${JSON.stringify(project)};
const doc=JSON.parse(fs.readFileSync(source,'utf8')),logDir=path.join(work,'logs',project), contextFile=path.join(logDir,'project-context.json');
const context=loadOrCreateFilmAuthorContext({path:contextFile,projectId:project,eraProfile:doc.eraProfile});
const {shots,durationSeconds,...common}=doc;const sourceHash=productionHash({source:{...common,shot:shots[0]},brief:null,sceneBible:null,eraProfile:context.eraProfile,aspect:'16:9',resolution:'720p',fps:30});
const lineage=createLineageReceipt({projectId:project,sourceHash,runId:'old-successful-render',stage:'shot',shotId:'S1',recipe:{component:'obsolete-quality-version'},status:'failed',inputs:[source,contextFile],outputs:[raw]});
const row={at:'2026-10-06T00:00:00.000Z',stage:'shot',shotId:'S1',invoked:true,ok:false,cached:false,degraded:false,attempt:1,ms:100,artifact:raw,evidence:{taskId:'provider-success-task',providerStatus:'succeeded',qualityScore:0},verdict:{approved:false,score:0,reason:'legacy visual quality failed'},lineage};
fs.writeFileSync(path.join(logDir,'stages.jsonl'),JSON.stringify(row)+'\\n');
const receiptPath=videoTaskReceiptPath(path.join(work,'render-task-receipts'),project,'S1');fs.mkdirSync(path.dirname(receiptPath),{recursive:true});fs.writeFileSync(receiptPath,JSON.stringify({schemaVersion:'workloom.video-task-receipt/v1',projectId:project,shotId:'S1',requestSha256:'a'.repeat(64),state:'succeeded',taskId:'provider-success-task',result:{taskId:'provider-success-task',url:'https://provider.invalid/synthetic.mp4',lastFrame:null}}));
console.log(JSON.stringify({receiptPath,logDir}));`;
  const prepared = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", setup], { cwd: repositoryRoot, encoding: "utf8", timeout: 30000 });
  assert.equal(prepared.status, 0, prepared.stderr); const locations = JSON.parse(prepared.stdout.trim());
  const oldRow = fs.readFileSync(join(locations.logDir, "stages.jsonl"), "utf8"); const original = fs.readFileSync(raw);
  if (scenario === "missing") fs.unlinkSync(raw);
  if (scenario === "tampered") fs.appendFileSync(raw, "external-byte-tamper");
  if (scenario === "corrupt") { fs.writeFileSync(raw, "not-a-video"); const doc = JSON.parse(oldRow); const data = fs.readFileSync(raw), sha256 = createHash("sha256").update(data).digest("hex");
    doc.lineage.outputs[0].sha256 = sha256; doc.lineage.outputs[0].bytes = data.length; fs.writeFileSync(join(locations.logDir, "stages.jsonl"), JSON.stringify(doc) + "\n"); }
  if (scenario === "provider-rejected") { const receipt = JSON.parse(fs.readFileSync(locations.receiptPath, "utf8")); receipt.state = "rejected"; fs.writeFileSync(locations.receiptPath, JSON.stringify(receipt)); }
  return { project, work, out, source, keys, raw, music, danmaku, original, oldRow, ...locations };
}
function runActualCli(root, fixture, { exportFailure = false } = {}) {
  const trace = join(root, "actual-trace.jsonl"), preload = join(root, "no-provider-preload.mjs");
  fs.writeFileSync(preload, `import fs from 'node:fs';import cp from 'node:child_process';import http from 'node:http';import https from 'node:https';import net from 'node:net';import {syncBuiltinESMExports} from 'node:module';
const record=(x)=>fs.appendFileSync(${JSON.stringify(trace)},JSON.stringify({...x,pid:process.pid,at:new Date().toISOString()})+'\\n');
const reject=()=>{record({kind:'network'});throw new Error('NETWORK_OR_PROVIDER_MUST_NOT_RUN')};globalThis.fetch=reject;for(const mod of [http,https]){mod.request=reject;mod.get=reject;}for(const [owner,name] of [[net,'connect'],[net,'createConnection'],[net.Socket.prototype,'connect']]){const original=owner[name];owner[name]=function(...args){const flat=args.flat();const socketPath=flat.find(x=>x&&typeof x==='object'&&typeof x.path==='string')?.path??flat.find(x=>typeof x==='string'&&x.startsWith('/'));if(typeof socketPath==='string'&&socketPath.startsWith('/')){record({kind:'local-ipc',socketPath});return original.apply(this,args);}return reject();};}
for(const name of ['spawn','spawnSync','execFileSync']){const original=cp[name];cp[name]=function(command,args,...rest){const argv=Array.isArray(args)?args:[];record({kind:'process',command:String(command),argv});if(argv.some(x=>/signalstats|edgedetect|bbox|cropdetect|psnr|ssim|blackdetect|silencedetect/.test(String(x))))throw new Error('SOURCE_QUALITY_PROBE_MUST_NOT_RUN');if(argv.some(x=>String(x).includes('/voice-bridge/cli.mjs'))&&argv.some(x=>['verify','dub','speak','asr'].includes(String(x))))throw new Error('DEFAULT_TTS_ASR_MUST_NOT_RUN');${exportFailure ? "if(argv.includes('-filter_complex')&&argv.some(x=>String(x).includes('concat=')))throw new Error('INJECTED_ACTUAL_EXPORT_FAILURE');" : ""}return original.call(this,command,args,...rest);};}syncBuiltinESMExports();`);
  const argv = ["--import", "tsx", filmPath.pathname, "--shots", fixture.source, "--project", fixture.project,
    "--work-dir", fixture.work, "--out", fixture.out, "--keys-file", fixture.keys, "--aspect", "16:9", "--resolution", "720p", "--fps", "30",
    "--platform", "youtube", "--cover-platform", "youtube", "--bgm-track", fixture.music, "--danmaku", fixture.danmaku, "--variants", "cool-tech"];
  const began = Date.now();
  const result = spawnSync(process.execPath, argv, { cwd: repositoryRoot, encoding: "utf8", timeout: 120000, maxBuffer: 32 << 20,
    env: { ...process.env, NODE_OPTIONS: `--import=${pathToFileURL(preload).href}`, WL_FFMPEG: mediaFfmpeg, WL_FFPROBE: mediaFfprobe,
      WORKLOOM_COLOR_FFMPEG_PATH: mediaFfmpeg, WORKLOOM_COLOR_FFPROBE_PATH: mediaFfprobe,
      WORKLOOM_POST_FFMPEG_PATH: mediaFfmpeg, WORKLOOM_POST_FFPROBE_PATH: mediaFfprobe,
      WORKLOOM_BGM_FFMPEG_PATH: mediaFfmpeg, WORKLOOM_BGM_FFPROBE_PATH: mediaFfprobe,
      WORKLOOM_SUBTITLE_FFMPEG_PATH: mediaFfmpeg, WORKLOOM_SUBTITLE_FFPROBE_PATH: mediaFfprobe,
      WORKLOOM_BGM_DISCOVER: "0", WORKLOOM_BGM_LIBRARY_DIR: join(root, "empty-library"), WORKLOOM_BGM_HOME: join(root, "empty-bgm-home"),
      WORKLOOM_AUDIO_STEM_SIGNING_SECRET: "", ARK_API_KEY: "", VOLCENGINE_ARK_API_KEY: "" } });
  const operations = fs.existsSync(trace) ? fs.readFileSync(trace, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line)) : [];
  const evidence = { argv, startedAt: new Date(began).toISOString(), elapsedMs: Date.now() - began, status: result.status,
    error: result.error?.message ?? null, networkCalls: 0, trace: operations, stdout: result.stdout, stderr: result.stderr };
  fs.writeFileSync(join(root, "actual-result.json"), JSON.stringify(evidence, null, 2));
  assert.equal(operations.filter(row => row.kind === "network").length, 0, "existing supplier-success source must cause zero network calls");
  return { ...result, operations, evidence };
}

it("whole actual CLI: old quality-failed black/162x90/23fps/10.04s/no-audio provider success traverses default official post with zero provider/model/ASR/TTS calls", { skip: !actualMediaAvailable, timeout: 150000 }, () => {
  const root = fs.realpathSync(fs.mkdtempSync(join(os.tmpdir(), "matrix-actual-post-")));
  try {
    const fixture = makeActualCliFixture(root, "success"), result = runActualCli(root, fixture);
    assert.equal(result.status, 0, `${result.error?.message ?? ""}\n${result.stdout}\n${result.stderr}`);
    assert.deepEqual(fs.readFileSync(fixture.raw), fixture.original);
    assert.ok(fs.readFileSync(join(fixture.logDir, "stages.jsonl"), "utf8").startsWith(fixture.oldRow), "legacy failed quality history remains byte-for-byte");
    const summary = JSON.parse(fs.readFileSync(join(fixture.logDir, "stage-summary.json"), "utf8"));
    for (const stageName of ["shot", "voice", "compose", "color", "subtitle", "danmaku", "bgm", "cover", "cover-intro", "mux", "master", "deliver"]) {
      assert.ok(summary.records.some(row => row.stage === stageName && row.ok), `official ${stageName} must actually complete`);
    }
    assert.ok(summary.records.filter(row => ["cine-kb", "continuity", "micromotion", "prompt-review", "keyframe"].includes(row.stage)).every(row => row.invoked === false));
    assert.ok(summary.records.filter(row => row.verdict).every(row => row.verdict.score === null), "no scored source acceptance verdict");
    const final = fs.readdirSync(fixture.out).find(name => /-10s-final\.mp4$/.test(name)); assert.ok(final, "final export uses actual duration naming");
    const info = JSON.parse(execFileSync(mediaFfprobe, ["-v", "error", "-show_streams", "-show_format", "-of", "json", join(fixture.out, final)], { encoding: "utf8" }));
    assert.ok(info.streams.some(stream => stream.codec_type === "video" && stream.width === 1280 && stream.height === 720));
    assert.ok(Math.abs(Number(info.format.duration) - 10) < 0.2);
    assert.ok(fs.existsSync(join(fixture.out, `${fixture.project}-softsub.mp4`))); assert.ok(fs.existsSync(join(fixture.out, `${fixture.project}-with-cover.mp4`)));
    const processes = result.operations.filter(row => row.kind === "process");
    assert.equal(processes.filter(row => row.argv.some(value => String(value).includes('/voice-bridge/cli.mjs'))).length, 0);
    const variantGrade = processes.find(row => row.argv.some(value => String(value).includes('/color-bridge/cli.mjs'))
      && row.argv.some(value => String(value).endsWith('-cool-tech.mp4')));
    assert.ok(variantGrade, "requested variant color transformation actually ran");
    assert.equal(variantGrade.argv[variantGrade.argv.indexOf("--in") + 1], join(fixture.work, "post", fixture.project, "master-danmaku.mp4"),
      "variant starts from the real program before BGM; it must not mix music onto the already scored master");
    const frameExtracts = processes.filter(row => row.argv.includes("-frames:v") && row.argv[row.argv.indexOf("-i") + 1]?.endsWith(".mp4"));
    assert.equal(frameExtracts.length, 2, "one master cover and one requested variant cover");
    assert.ok(frameExtracts.every(row => row.argv.at(-1)?.endsWith("-frame.png")), "single requested cover extraction is the only source frame read");
    assert.ok(fs.readdirSync(fixture.out).some(name => name.endsWith("delivery-manifest.json")));
    console.info("ACTUAL_POST_CLI_EVIDENCE", JSON.stringify({ root, argv: result.evidence.argv, elapsedMs: result.evidence.elapsedMs, networkCalls: 0,
      stages: Object.keys(summary.stages), sourceSha256: createHash("sha256").update(fixture.original).digest("hex"), final, frameExtracts: frameExtracts.length }));
  } finally { if (process.env.WORKLOOM_KEEP_ACTUAL_POST_FIXTURE !== "1") fs.rmSync(root, { recursive: true, force: true }); }
});
for (const scenario of ["missing", "tampered", "corrupt", "provider-rejected", "export-failure"]) {
  it(`whole actual CLI: ${scenario} fails truthfully with no provider or quality retries`, { skip: !actualMediaAvailable, timeout: 150000 }, () => {
    const root = fs.realpathSync(fs.mkdtempSync(join(os.tmpdir(), `matrix-post-${scenario}-`)));
    try { const fixture = makeActualCliFixture(root, scenario === "export-failure" ? "success" : scenario), result = runActualCli(root, fixture, { exportFailure: scenario === "export-failure" });
      assert.notEqual(result.status, 0); assert.equal(result.error?.code, undefined, "failure must come from actual process, not a fixture timeout");
      assert.ok(!fs.existsSync(fixture.out) || !fs.readdirSync(fixture.out).some(name => /-final\.mp4$/.test(name)), "failed processing cannot produce a completed master");
      console.info("ACTUAL_POST_CLI_NEGATIVE", JSON.stringify({ scenario, root, status: result.status, elapsedMs: result.evidence.elapsedMs, networkCalls: 0 }));
    } finally { if (process.env.WORKLOOM_KEEP_ACTUAL_POST_FIXTURE !== "1") fs.rmSync(root, { recursive: true, force: true }); }
  });
}

it("real fence DSL: requested single variant and old visual/acoustic review switches do not block successful-source official post", { timeout: 30000 }, () => {
  const defaults = { input_path: "source.mp4", output_path: "new.mp4", verify: false, skip_verify: true,
    license_reviewed: true, lut_approved: true, commercial_use: true, font_license: "ofl-1.1", track_license: "royalty-free",
    source_quality_score: 0, variants_distinct: false, identical_variants: true, variant_count: 1,
    uhd_requested: true, resolution_exact: true, enhancement_verified: false,
    allow_flood: true, ignore_density: true, skip_safe_area: true, ignore_safe_area: true, allow_ui_overlap: true,
    consent_declared: true, consent_scope: "internal", consent_reviewed: true,
    material_usage: "generation-reference", reference_only: true, render_task_id: "successful-provider-task",
    model: "successful-provider", source_material_sha256: "a".repeat(64), output_sha256: "b".repeat(64),
    fidelity_reviewed: false, landmark_altered: true, text_identifier_changed: true };
  const quota = { tenant_daily_grades: 0, tenant_daily_bgm: 0, tenant_daily_subtitle: 0, tenant_daily_voice_seconds: 0 };
  const cases = [
    ...["colorwrite.grade", "colorwrite.match"].map(action => ({ pack: "color", action })),
    ...["bgmwrite.mix", "bgmwrite.best"].map(action => ({ pack: "bgm", action })),
    ...["subtitlewrite.plan", "subtitlewrite.burn", "subtitlewrite.title", "subtitlewrite.danmaku", "subtitlewrite.sticker",
      "subtitlewrite.karaoke", "subtitlewrite.best", "subtitlewrite.sidecar", "subtitlewrite.softmux"].map(action => ({ pack: "subtitle", action })),
    ...["postwrite.package", "postwrite.reedit", "subtitlewrite.softmux"].map(action => ({ pack: "delivery", action })),
  ].map(item => ({ ...item, objectType: "final_video", params: defaults, context: quota, expected: "auto" }));
  // Normal package actions use output_dir, not input_path/output_path. Missing aliases must not compare as source overwrite.
  cases.push({ pack: "delivery", action: "postwrite.package", objectType: "delivery_package",
    params: { output_dir: "new-package", shots: ["source.mp4"], variant_count: 1 }, context: quota, expected: "auto" });
  cases.push(...[
    { pack: "voice", action: "voicewrite.register", objectType: "voice_profile" },
    ...["voicewrite.speak", "voicewrite.dub"].map(action => ({ pack: "voice", action, objectType: "voice_track" })),
    { pack: "voice", action: "voicewrite.verify", objectType: "voice_report" },
    ...["material.write", "material.generate", "render.write"].map(action => ({ pack: "material", action, objectType: "video_asset" })),
  ].map(item => ({ ...item, params: defaults, context: quota, expected: "auto" })));
  cases.push(...[
    { pack: "color", action: "colorwrite.grade", change: { source_bytes_changed: true }, expectedRule: "G-COL3" },
    { pack: "color", action: "colorwrite.grade", change: { output_missing: true }, expectedRule: "G-COL3" },
    { pack: "color", action: "colorwrite.grade", change: { output_path: "source.mp4" }, expectedRule: "G-COL2" },
    { pack: "bgm", action: "bgmwrite.mix", change: { output_path: "source.mp4" }, expectedRule: "G-BGM2" },
    { pack: "bgm", action: "bgmwrite.mix", change: { policy: "music-only", allow_discard_original: false }, expectedRule: "G-BGM3" },
    { pack: "bgm", action: "bgmwrite.mix", change: { track_license: "unlicensed" }, objectType: "bgm_report", expectedRule: "G-BGM5" },
    { pack: "subtitle", action: "subtitlewrite.burn", change: { font_license: "unlicensed" }, objectType: "subtitle_report", expectedRule: "G-SUB5" },
    { pack: "subtitle", action: "subtitlewrite.danmaku", change: { invalid_event_timing: true }, expectedRule: "G-SUB6" },
    { pack: "subtitle", action: "subtitlewrite.burn", change: { font_unreadable: true }, expectedRule: "G-SUB3" },
    { pack: "subtitle", action: "subtitlewrite.burn", change: { ass_invalid: true }, expectedRule: "G-SUB3" },
    { pack: "subtitle", action: "subtitlewrite.burn", change: { timeline_invalid: true }, expectedRule: "G-SUB3" },
    { pack: "subtitle", action: "subtitlewrite.burn", change: { output_path: "source.mp4" }, expectedRule: "G-SUB2" },
    { pack: "delivery", action: "postwrite.package", change: { requested_variants_missing: true }, expectedRule: "G-DLV1" },
    { pack: "delivery", action: "postwrite.package", change: { variant_count: 0 }, expectedRule: "G-DLV1" },
    { pack: "delivery", action: "subtitlewrite.softmux", change: { reencode_video: true }, expectedRule: "G-DLV3" },
    { pack: "delivery", action: "postwrite.package", change: { reuse_without_evidence: true }, expectedRule: "G-DLV7" },
    { pack: "delivery", action: "postwrite.package", change: { requires_shot_regeneration: true }, objectType: "delivery_package", expectedRule: "G-DLV5", expected: "review" },
    { pack: "delivery", action: "postwrite.reedit", change: { requires_shot_regeneration: true }, expectedRule: "G-DLV5", expected: "review" },
    { pack: "delivery", action: "postwrite.package", change: { resolution_exact: false }, expectedRule: "G-DLV8" },
    { pack: "delivery", action: "postwrite.package", change: { enhancement_requested: true, enhancement_output_missing: true }, expectedRule: "G-DLV9" },
    { pack: "voice", action: "voicewrite.speak", objectType: "voice_track", change: { output_missing: true }, expectedRule: "G-VOICE3" },
    { pack: "voice", action: "voicewrite.dub", objectType: "voice_track", change: { source_bytes_changed: true }, expectedRule: "G-VOICE3" },
    { pack: "voice", action: "voicewrite.dub", objectType: "final_video", change: { output_path: "source.mp4" }, expectedRule: "G-VOICE2" },
    { pack: "voice", action: "voicewrite.register", objectType: "voice_profile", change: { consent_declared: false }, expectedRule: "G-VOICE1", expected: "review" },
    { pack: "voice", action: "voicewrite.register", objectType: "voice_profile", change: { upload_voiceprint: true }, expectedRule: "G-VOICE5" },
    { pack: "voice", action: "voicewrite.speak", objectType: "voice_track", change: { publish_external: true }, expectedRule: "G-VOICE6", expected: "review" },
    { pack: "material", action: "render.write", objectType: "video_asset", change: { material_usage: "static-display" }, expectedRule: "G-MAT1" },
    { pack: "material", action: "material.generate", objectType: "video_asset", change: { static_display: true }, expectedRule: "G-MAT1" },
    { pack: "material", action: "material.generate", objectType: "video_asset", change: { render_task_id: null }, expectedRule: "G-MAT2", expected: "review" },
    { pack: "material", action: "material.generate", objectType: "video_asset", change: { reference_only: false }, expectedRule: "G-MAT4" },
  ].map(item => ({ ...item, objectType: item.objectType ?? "final_video", params: { ...defaults, ...item.change }, context: quota, expected: item.expected ?? "block" })));
  for (const field of ["render_task_id", "model", "source_material_sha256", "output_sha256"]) {
    for (const empty of [undefined, null, "", false]) cases.push({ pack: "material", action: "material.generate", objectType: "video_asset",
      params: { ...defaults, [field]: empty }, context: quota, expected: "review", expectedRule: "G-MAT2" });
  }
  for (const [pack, action, contextKey, limit, expectedRule] of [
    ["color", "colorwrite.grade", "tenant_daily_grades", 30, "G-COL4"],
    ["bgm", "bgmwrite.mix", "tenant_daily_bgm", 40, "G-BGM4"],
    ["subtitle", "subtitlewrite.burn", "tenant_daily_subtitle", 60, "G-SUB4"],
    ["voice", "voicewrite.dub", "tenant_daily_voice_seconds", 3600, "G-VOICE4"],
  ]) cases.push({ pack, action, objectType: "final_video", params: defaults, context: { ...quota, [contextKey]: limit }, expected: "block", expectedRule });
  const program = `import fs from 'node:fs';import path from 'node:path';import YAML from 'yaml';
import {judge} from ${JSON.stringify(pathToFileURL(join(repositoryRoot, "packages/base/fence-engine/judge.ts")).href)};
const cases=JSON.parse(process.argv[1]),root=process.argv[2];
const results=cases.map((item,index)=>{const doc=YAML.parse(fs.readFileSync(path.join(root,'bundles/ai-video/fences/ai-video-'+item.pack+'.yml'),'utf8'));
const rules=doc.rules.map(rule=>({rule_id:rule.rule_id,version:doc.version,name:rule.name,level:rule.level,is_baseline:rule.is_baseline,objectTypes:rule.match.object_types,actions:rule.match.actions,when:rule.when}));
const input={object:{type:item.objectType},action:item.action,effect:'write',params:item.params,context:item.context};const actual=judge(input,rules,doc.default_level);
return {id:'fence-'+(index+1),preconditions:{pack:'ai-video-'+item.pack,successfulProviderSource:true,legacyQualityScore:0,tenantQuota:item.context},steps:[{action:item.action,params:item.params}],expected:{level:item.expected,rule:item.expectedRule??null},actual};});
console.log(JSON.stringify(results));`;
  const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", program, JSON.stringify(cases), repositoryRoot],
    { cwd: repositoryRoot, encoding: "utf8", timeout: 30000 });
  assert.equal(result.status, 0, result.stderr); assert.equal(result.error, undefined);
  const results = JSON.parse(result.stdout);
  for (const row of results) {
    assert.equal(row.actual.level, row.expected.level, JSON.stringify(row));
    assert.deepEqual(row.actual.evalErrors, [], JSON.stringify(row));
    if (row.expected.rule) assert.ok(row.actual.impacts.some(impact => impact.rule_id === row.expected.rule), JSON.stringify(row));
  }
  if (process.env.WORKLOOM_POST_FENCE_EVIDENCE) fs.writeFileSync(process.env.WORKLOOM_POST_FENCE_EVIDENCE, JSON.stringify(results, null, 2));
  console.info("FENCE_REAL_EVIDENCE", JSON.stringify({ cases: results.length, passed: results.length, interpreter: "production fence-engine/judge.ts + expr.ts", sourceQualityReviewed: false }));
});


it("mixed cached/new asset generation: current authorization evidence excludes a successful source whose old profile is absent", () => {
  const checks = source.statements.find(node => ts.isForOfStatement(node)
    && node.expression.getText(source) === "assetShots().filter(requiresGeneration)");
  const gate = source.statements.find(node => ts.isIfStatement(node)
    && node.expression.getText(source) === "realPersonChecks.length > 0");
  assert.ok(checks && gate, "execute the actual production authorization loop and its receipt");
  const cached = { shotId: "old-success", assetRef: "asset://deleted-old-profile" }, fresh = { shotId: "new-submit", assetRef: "asset://new-profile" };
  const asset = { displayName: "current authorized person", certified: { gender: "female", ageBand: "adult" } };
  const receipts = [], gates = [], inspected = [];
  runInNewContext(transpile(`${declaration("realPersonChecks")}\n${declaration("realPersonByShot")}\n${checks.getText(source)}\n${gate.getText(source)}`), {
    assetShots: () => [cached, fresh], requiresGeneration: shot => shot === fresh,
    assetRefOf: shot => shot.assetRef, assetIdOf: ref => ref.replace("asset://", ""),
    realPersonLibrary: { byAssetId: new Map([["new-profile", { asset, issues: [] }]]) },
    assertShotMatchesCertifiedAsset: shot => { inspected.push(shot.shotId); return []; },
    identityReviewContext: () => ({ discipline: "current pre-submit authorization" }),
    realPersonUsageReceipt: input => { receipts.push(input); return { person: input.asset.displayName, shots: input.shots }; },
    recordGate: input => { gates.push(input); return { approved: true }; },
    REAL_PERSON_LIBRARY: "/fixture/current-profile-library", REAL_PERSON_POLICY_VERSION: "fixture-current-policy", PROJECT: "mixed-source-project", log: () => {},
  }, { timeout: 1000 });
  assert.deepEqual(inspected, ["new-submit"]); assert.equal(receipts.length, 1);
  assert.equal(receipts[0].asset, asset); assert.equal(gates.length, 1);
  assert.deepEqual(Array.from(gates[0].shotIds), ["new-submit"]);
  assert.deepEqual(Array.from(gates[0].evidence.usage[0].shots), ["new-submit"]);
});

it("mixed cached/new prompt generation: the actual review declaration consumes only pending prompt carriers", () => {
  let node;
  const visit = entry => { if (ts.isVariableStatement(entry)
    && entry.declarationList.declarations.some(item => item.name.getText(source) === "promptReviewOptions")) node = entry;
    ts.forEachChild(entry, visit); };
  visit(source); assert.ok(node);
  const old = { shotId: "old-success" }, fresh = { shotId: "new-submit" };
  const options = runInNewContext(transpile(`${node.getText(source)}\npromptReviewOptions;`), {
    scenePolicy: null, PROJECT: "mixed-source-project", join, PROMPT_DIR: "/fixture/prompts", promptShots: () => [old, fresh],
    requiresGeneration: shot => shot === fresh, materialShots: () => [], checks: [], shotlist: { title: "fixture" },
    rateFail: 0, scenePolicyReport: null, motionBudgetNotes: [], ENV: {}, ALLOW_FALLBACK_APPROVE: false, log: () => {},
  });
  assert.deepEqual(Array.from(options.artifacts, item => item.path), ["/fixture/prompts/spec-report.json", "/fixture/prompts/new-submit.txt"]);
});

it("actual film subtitle builder preserves every requested dialogue segment beyond two wrapped lines", () => {
  const builder = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === "buildSrt");
  const clock = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === "srtTime");
  assert.ok(builder && clock);
  const lines = ["第一段完整字幕必须保留后期", "第二段完整字幕必须保留后期", "第三段完整字幕必须保留后期", "第四段完整字幕必须保留后期"];
  const srt = runInNewContext(transpile(`${clock.getText(source)}\n${builder.getText(source)}\nbuildSrt();`), {
    shots: [{ shotId: "source-success", duration: 20 }], dialogueText: () => lines.join("，"), OPENING_CAPTION: null,
    CUT_GRID: [], expectedMasterSeconds: 20,
  });
  for (const line of lines) assert.ok(srt.includes(line), `complete requested text ${line}`);
});

for (const [name, mode] of [["subtitle", "sidecar"], ["subtitle", "burn"], ["danmaku", "sidecar"], ["mux", "sidecar"], ["compose", "sidecar"]]) {
  it(`actual ${name}/${mode}: processing exit failure with an existing stale output stops before final publication`, async () => {
    const rows = [], context = {
      STAGES: new Set([name]), DRY_RUN: false, Error, join, basename, Date,
      POST_DIR: "/fixture/post", OUT_DIR: "/fixture/out", PROJECT: "technical-failure", master: "/fixture/post/master-raw.mp4",
      colored: "/fixture/post/master-graded.mp4", subtitled: "/fixture/post/master-graded.mp4", scored: "/fixture/post/master-scored.mp4",
      SUBTITLE_MODE: mode, BRIEF_FILE: null, DANMAKU_ENABLED: true, DANMAKU_FILE: "/fixture/danmaku.json", DANMAKU_CLI: "fixture-subtitle", SUBTITLE_CLI: "fixture-subtitle",
      subtitleSidecar: name === "mux" ? { dir: "/fixture/sidecar", srt: "/fixture/sidecar/technical-failure.zh.srt", ass: "/fixture/sidecar/technical-failure.zh.ass" } : null,
      softsubFile: null, shotlist: { title: "fixture" }, shots: [{ shotId: "source-success", duration: 10 }],
      acceptExistingRenderedClip: () => true, clipFor: () => "/fixture/source.mp4", rememberInputs: () => {},
      existsSync: () => true, mkdirSync: () => {}, writeFileSync: () => {}, readFileSync: () => "[]", readdirSync: () => ["technical-failure.zh.srt"],
      execFileSync: () => {}, buildSrt: () => "1\n00:00:00,000 --> 00:00:01,000\nfixture\n", abs: value => value,
      arg: (_name, fallback = "") => fallback, flag: () => false, log: () => {}, ENV: {}, ALLOW_FALLBACK_APPROVE: false,
      record: row => { rows.push(row); return row; }, runCli: () => ({ ok: false, out: "INJECTED_REAL_PROCESS_FAILURE" }),
      probe: () => ({ duration: 10, width: 1280, height: 720 }),
      reviewStage: async () => ({ approved: true, degraded: false, reason: "fixture stale file exists", ms: 0 }),
      COMPOSE_ORDER: "", ORDER_POLICY: "storyboard", REUSE_PLAN: null, POST_ONLY_ASSEMBLY: false, QUALITY: "standard", SOURCE_RESOLUTION: "720p", OUTPUT_RESOLUTION: "720p",
      checkShotOrder: ids => ({ ok: true, expected: ids, actual: ids }), ENHANCE_ENGINE_DIR: "", OUTPUT_SIZE: { width: 1280, height: 720 }, REPO_ROOT: "/fixture/repo",
      FPS: 30, XFADE: 0, EFFECTIVE_CUT_TRANSITION: "", EFFECTIVE_CUT_TRANSITION_AT: "", CUT_TRANSITION_DURATION: 0, expectedMasterSeconds: 10,
    };
    const block = name === "compose" ? source.statements.find(node => ts.isIfStatement(node)
      && node.expression.getText(source) === 'STAGES.has("compose") && !DRY_RUN') : stage(name);
    assert.ok(block);
    const prefix = `${name === "subtitle" ? "SUBTITLE" : name.toUpperCase()}_POST_FAILED:`;
    await assert.rejects(runInNewContext(transpile(`(async () => { ${block.getText(source)} })()`), context, { timeout: 1000 }),
      error => typeof error?.message === "string" && error.message.startsWith(prefix));
    assert.ok(rows.some(row => row.stage === name && row.ok === false), "failed operation is recorded before throwing");
  });
}
