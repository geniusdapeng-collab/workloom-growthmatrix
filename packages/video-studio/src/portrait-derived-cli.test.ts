import { execFile, execFileSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vitest";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const execute = promisify(execFile), roots: string[] = [], servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise<void>((done, fail) => server.close(error => error ? fail(error) : done()));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
async function fixture(options: { failDownload?: boolean; lostAck?: boolean; reject?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), "derived-cli-")); roots.push(root);
  const library = join(root, "library"), character = join(library, "registered"), image = join(root, "actual.png");
  mkdirSync(character, { recursive: true });
  writeFileSync(join(character, "profile.json"), JSON.stringify({ schemaVersion: "workloom.character-profile/v1", id: "registered", name: "Registered", kind: "authorized-real", portraitSets: [] }));
  execFileSync(process.env.WL_FFMPEG ?? "ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "testsrc2=s=256x320", "-frames:v", "1", image]);
  const png = readFileSync(image), counts = { images: 0, videos: 0, downloads: 0 }, bodies: unknown[] = [];
  let base = "";
  const server = createServer(async (request, response) => {
    if (request.url === "/images/generations") {
      counts.images++; const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      bodies.push(JSON.parse(Buffer.concat(chunks).toString()));
      if (options.lostAck) { request.socket.destroy(); return; }
      if (options.reject) { response.writeHead(500); response.end("temporarily unavailable"); return; }
      response.setHeader("content-type", "application/json"); response.end(JSON.stringify({ data: [{ url: `${base}/image` }] })); return;
    }
    if (request.url?.startsWith("/contents/generations/tasks")) { counts.videos++; response.writeHead(500); response.end("unexpected paid fallback"); return; }
    if (request.url === "/image") {
      counts.downloads++;
      if (options.failDownload && counts.downloads === 1) { response.writeHead(503); response.end("download unavailable"); return; }
      response.setHeader("content-type", "image/png"); response.end(png); return;
    }
    response.writeHead(404); response.end();
  });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done)); servers.push(server);
  const address = server.address(); if (!address || typeof address === "string") throw new Error("Fixture endpoint unavailable");
  base = `http://127.0.0.1:${address.port}`;
  async function run(out = "out", extra: string[] = [], engine = "image", angles = "front") {
    const env = { ...process.env, ARK_BASE_URL: base, VOLCENGINE_ARK_API_KEY: "fixture-only", SEEDREAM_MODEL: "fixture-image", SEEDANCE_MODEL: "fixture-video" };
    return execute(process.execPath, ["--import", "tsx", "scripts/tools/portrait-set-from-asset.mts", "--asset", "asset://fixture", "--character", "registered",
      "--library", library, "--out-dir", join(root, out), "--receipt-root", join(root, "private-receipts"), "--keys-file", join(root, "absent.env"),
      "--angles", angles, "--engine", engine, ...extra], { cwd: repo, env, timeout: 30_000 });
  }
  return { root, run, counts, bodies, png, image, library };
}
it("actual CLI saves image ACK before failed GET, resumes in another output directory with one paid POST", async () => {
  const f = await fixture({ failDownload: true });
  await expect(f.run("first")).rejects.toThrow();
  await f.run("second");
  expect(f.counts).toEqual({ images: 1, videos: 0, downloads: 2 });
  expect(readFileSync(join(f.root, "second/registered-front.png"))).toEqual(f.png);
  const plan = JSON.parse(readFileSync(join(f.root, "second/derived-plan.json"), "utf8"));
  expect(plan.perAngle[0].likeness).toMatchObject({ reviewed: false, same: null, score: null });
});
it.each([{ lostAck: true }, { reject: true }])("actual auto CLI never falls back or pays again after uncertain image acceptance (%j)", async failure => {
  const f = await fixture(failure);
  const runAuto = async (out: string) => f.run(out, ["--anchor-image", f.image], "auto");
  await expect(runAuto("first")).rejects.toThrow();
  await expect(runAuto("second")).rejects.toThrow();
  expect(f.counts.images).toBe(1); expect(f.counts.videos).toBe(0); expect(f.counts.downloads).toBe(0);
});
it("actual independent CLI processes sharing a journal produce one paid image and restore all outputs", async () => {
  const f = await fixture(); await Promise.all([f.run("one"), f.run("two"), f.run("three")]);
  expect(f.counts.images).toBe(1); expect(f.counts.downloads).toBe(3); expect(f.counts.videos).toBe(0);
});
it("legacy output without a receipt refuses new paid generation", async () => {
  const f = await fixture(); mkdirSync(join(f.root, "out")); writeFileSync(join(f.root, "out/registered-front.png"), f.png);
  await expect(f.run()).rejects.toThrow(); expect(f.counts.images).toBe(0); expect(f.counts.videos).toBe(0);
});
it("generated equal-pixel angles can be installed without likeness or duplicate quality rerenders", async () => {
  const f = await fixture(); await f.run("all", ["--install", "--activate"], "image", "front,threeQuarter,closeup,side");
  const profile = JSON.parse(readFileSync(join(f.library, "registered/profile.json"), "utf8"));
  expect(profile.portraitSets[0]).toMatchObject({ version: 1, active: true, angles: ["front", "threeQuarter", "closeup", "side"] });
  expect(f.counts.images).toBe(4); expect(f.counts.videos).toBe(0);
});
