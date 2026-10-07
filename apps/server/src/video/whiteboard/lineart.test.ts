import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildSceneLineart, type LineartOptions } from "./lineart.js";
import { ArkImageProvider } from "../gen/providers.js";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a6FcAAAAASUVORK5CYII=", "base64");
afterEach(() => vi.unstubAllGlobals());
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "wl-lineart-paid-")), journals = join(root, "journals");
  const posts: Array<Record<string, unknown>> = [], gets: string[] = [];
  let behavior: "ok" | "download-fail" | "bad-image" | "lost-ack" | "provider-fail" = "ok";
  let durableBeforeDownload = false;
  const remote = (async (url, init) => {
    if (String(url) === "https://ark.example.invalid/api/v3/images/generations" && init?.method === "POST") {
      posts.push(JSON.parse(String(init.body)));
      if (behavior === "lost-ack") throw new Error("response lost after acceptance");
      if (behavior === "provider-fail") return new Response("temporary failure", { status: 500 });
      return new Response(JSON.stringify({ data: [{ url: "https://cdn.example.invalid/lineart.png" }] }), { status: 200 });
    }
    if (String(url) !== "https://cdn.example.invalid/lineart.png") throw new Error("unexpected network call");
    gets.push(String(url));
    durableBeforeDownload = readdirSync(journals).some(name => name.endsWith(".json") && JSON.parse(readFileSync(join(journals, name), "utf8")).state === "accepted");
    if (behavior === "download-fail") return new Response("unavailable", { status: 503 });
    return new Response(behavior === "bad-image" ? Buffer.from("not an image") : png, { status: 200 });
  }) as typeof fetch;
  vi.stubGlobal("fetch", remote);
  const opts: LineartOptions & { mode: "seedream" } = {
    mode: "seedream", workspaceId: "w1", projectId: "project-1", sceneNo: 1, jobDir: join(root, "run-a"),
    receiptRoot: journals, coreIdea: "入住接待", elements: ["前台", "客人"], fetchImpl: remote,
    env: { VOLCENGINE_ARK_API_KEY: "unit-test-only", SEEDREAM_ENDPOINT: "https://ark.example.invalid/api/v3", WHITEBOARD_LINEART_RETRY: "9" },
    provider: new ArkImageProvider({ apiKey: "unit-test-only", baseUrl: "https://ark.example.invalid/api/v3" }),
    checkImpl: async () => { throw new Error("default policy must not review style"); },
  };
  return { root, journals, posts, gets, opts, setBehavior: (value: typeof behavior) => { behavior = value; }, durable: () => durableBeforeDownload };
}
describe("whiteboard lineart durable acceptance", () => {
  it("default skips style checks and accepts one original generation despite retry=9", async () => {
    const f = fixture(); const result = await buildSceneLineart(f.opts);
    expect(f.posts).toHaveLength(1); expect(result.attempts).toBe(1); expect(f.durable()).toBe(true);
    expect(result.check).toMatchObject({ ok: false, status: "skipped", reviewPolicy: "off", accepted: true, checks: [] });
    expect(readFileSync(result.absPath)).toEqual(png);
  });
  it("download failure preserves the accepted URL and restores it without a second POST", async () => {
    const f = fixture(); f.setBehavior("download-fail");
    await expect(buildSceneLineart(f.opts)).rejects.toThrow("HTTP 503"); expect(f.durable()).toBe(true);
    f.setBehavior("ok"); const restored = await buildSceneLineart(f.opts);
    expect(restored.attempts).toBe(0); expect(f.posts).toHaveLength(1); expect(f.gets).toHaveLength(2);
  });
  it("unreadable returned bytes restore from the original URL rather than generating a replacement", async () => {
    const f = fixture(); f.setBehavior("bad-image");
    await expect(buildSceneLineart(f.opts)).rejects.toThrow("无法读取图像");
    f.setBehavior("ok"); await buildSceneLineart(f.opts); expect(f.posts).toHaveLength(1);
  });
  it("the same project in a different run directory and a corrupted output share one acceptance", async () => {
    const f = fixture(); const first = await buildSceneLineart(f.opts); writeFileSync(first.absPath, "corrupted");
    await buildSceneLineart(f.opts);
    const second = await buildSceneLineart({ ...f.opts, jobDir: join(f.root, "run-b") });
    expect(second.attempts).toBe(0); expect(f.posts).toHaveLength(1); expect(readFileSync(second.absPath)).toEqual(png);
  });
  it("advisory and blocking failures keep original measurements and never automatically pay again", async () => {
    const f = fixture(); const checkImpl = async () => ({ ok: false, checks: [{ id: "style", pass: false, detail: "dark patch" }], metrics: { dark: 0.5 } });
    const advisory = await buildSceneLineart({ ...f.opts, reviewPolicy: "advisory", checkImpl });
    expect(advisory.check).toMatchObject({ ok: false, accepted: true, status: "measured", metrics: { dark: 0.5 } });
    await expect(buildSceneLineart({ ...f.opts, reviewPolicy: "blocking", checkImpl })).rejects.toThrow("不自动重新出图");
    await buildSceneLineart(f.opts); expect(f.posts).toHaveLength(1);
  });
  it("unavailable advisory review reports its original failure and continues with the produced file", async () => {
    const f = fixture(); const result = await buildSceneLineart({ ...f.opts, reviewPolicy: "advisory", checkImpl: async () => { throw new Error("checker unavailable"); } });
    expect(result.check).toMatchObject({ status: "unverified", accepted: true, ok: false, checks: [{ detail: "checker unavailable" }] });
    expect(f.posts).toHaveLength(1); expect(readFileSync(result.absPath)).toEqual(png);
  });
  it.each(["lost-ack", "provider-fail"] as const)("unknown %s acceptance refuses a second POST across restarts", async behavior => {
    const f = fixture(); f.setBehavior(behavior); await expect(buildSceneLineart(f.opts)).rejects.toThrow();
    f.setBehavior("ok"); await expect(buildSceneLineart({ ...f.opts, jobDir: join(f.root, "run-b") })).rejects.toThrow("SUBMISSION_UNKNOWN");
    expect(f.posts).toHaveLength(1);
  });
  it("legacy output without a provider acceptance and deleted journal both refuse new payment", async () => {
    const f = fixture(); mkdirSync(f.opts.jobDir); writeFileSync(join(f.opts.jobDir, "scene-01.lineart.png"), png);
    await expect(buildSceneLineart(f.opts)).rejects.toThrow("LEGACY_RECEIPT_REQUIRED"); expect(f.posts).toHaveLength(0);
    rmSync(join(f.opts.jobDir, "scene-01.lineart.png")); await buildSceneLineart(f.opts); rmSync(f.journals, { recursive: true });
    await expect(buildSceneLineart(f.opts)).rejects.toThrow("LEGACY_RECEIPT_REQUIRED"); expect(f.posts).toHaveLength(1);
  });
  it("actual changed authored content creates its own distinct request; repeated content reuses it", async () => {
    const f = fixture(); await buildSceneLineart(f.opts);
    const changed = { ...f.opts, elements: ["接待台", "新客人"] };
    await buildSceneLineart(changed); await buildSceneLineart(changed); expect(f.posts).toHaveLength(2);
    expect(f.posts[1]!.prompt).toContain("新客人");
  });
  it("concurrent same-source runs submit once and both recover the same accepted bytes", async () => {
    const f = fixture();
    const results = await Promise.all([buildSceneLineart(f.opts), buildSceneLineart({ ...f.opts, jobDir: join(f.root, "run-b") })]);
    expect(f.posts).toHaveLength(1); expect(results.map(x => readFileSync(x.absPath))).toEqual([png, png]);
  });
  it("invalid scope, review policy and a symlink job directory fail before paid submission", async () => {
    const f = fixture(); await expect(buildSceneLineart({ ...f.opts, sceneNo: 0 })).rejects.toThrow("幕号无效");
    await expect(buildSceneLineart({ ...f.opts, reviewPolicy: "invalid" as "off" })).rejects.toThrow("POLICY_INVALID");
    mkdirSync(join(f.root, "outside")); symlinkSync(join(f.root, "outside"), f.opts.jobDir);
    await expect(buildSceneLineart(f.opts)).rejects.toThrow("符号链接"); expect(f.posts).toHaveLength(0);
  });
});
