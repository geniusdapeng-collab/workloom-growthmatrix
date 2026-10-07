import { afterEach, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freezeFilmJobPostAssets, readFilmJobPostAssets } from "./film-job-assets.js";
const roots: string[] = [];
const hash = (value: Buffer | string): string => createHash("sha256").update(value).digest("hex");
const ids = ["cool-tech", "warm-film", "punchy-social"];
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "film-job-post-"))); roots.push(root);
  mkdirSync(join(root, "assets"));
  const variants = ids.map((id, index) => {
    const asset = (kind: string) => {
      const path = `assets/${id}.${kind}`, bytes = `${id}:${kind}`; writeFileSync(join(root, path), bytes);
      return { path, sha256: hash(bytes) };
    };
    return { id, title: `Title ${index}`, fontName: `Font ${index}`, font: asset("ttf"), cover: asset("png"),
      endCard: asset("jpg"), bgm: { ...asset("mp3"), id: `track-${index}`, title: `Music ${index}` } };
  });
  const value = { schemaVersion: "workloom.film-presentation/v1", main: variants[0]!, variants };
  const options: Record<string, string | boolean> = {};
  const save = () => { const text = JSON.stringify(value); writeFileSync(join(root, "plan.json"), text);
    options["presentation-plan-ref"] = "plan.json"; options["presentation-plan-sha256"] = hash(text); };
  save(); return { root, value, options, save };
}
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));
it("freezes every real asset and the rewritten plan before a later upload can change the job", () => {
  const { root, options } = fixture();
  const before = { ...options }, frozen = freezeFilmJobPostAssets(root, options);
  expect(options).toEqual(before); expect(frozen["presentation-plan-ref"]).toMatch(/^stages\/film\/post-assets\/[a-f0-9]{64}\.json$/);
  const plan = readFilmJobPostAssets(root, frozen).presentation!;
  writeFileSync(join(root, "plan.json"), "corrupt later upload");
  writeFileSync(join(root, "assets/cool-tech.mp3"), "corrupt later asset");
  expect(readFileSync(plan.file, "utf8")).toContain("assets/");
  expect(readFilmJobPostAssets(root, frozen).presentation!.assets.size).toBe(12);
  expect(freezeFilmJobPostAssets(root, frozen)).toEqual(frozen);
});
it("freezes an independently supplied end card and verifies the frozen bytes", () => {
  const { root } = fixture(); const ref = "assets/cool-tech.jpg", bytes = readFileSync(join(root, ref));
  const frozen = freezeFilmJobPostAssets(root, { "end-card-ref": ref, "end-card-sha256": hash(bytes) });
  expect(frozen["end-card-ref"]).toMatch(/^stages\/film\/post-assets\/assets\//);
  expect(readFilmJobPostAssets(root, frozen).endCard!.bytes).toEqual(bytes);
  writeFileSync(join(root, String(frozen["end-card-ref"])), "changed");
  expect(() => readFilmJobPostAssets(root, frozen)).toThrow("摘要不符");
});
it.each(["../private.png", "/private.png", "a\\b.png", "a/../private.png", "https://private.png"])("rejects archive escapes %s", ref => {
  const { root } = fixture(); expect(() => readFilmJobPostAssets(root, { "end-card-ref": ref, "end-card-sha256": "a".repeat(64) })).toThrow();
});
it("rejects a nested asset with a missing digest, changed bytes, escape or symlink", () => {
  const { root, value, options, save } = fixture();
  value.variants[1]!.font.sha256 = ""; save();
  expect(() => freezeFilmJobPostAssets(root, options)).toThrow("sha256");
  value.variants[1]!.font.sha256 = hash("warm-film:ttf"); save();
  writeFileSync(join(root, value.variants[1]!.font.path), "changed");
  expect(() => freezeFilmJobPostAssets(root, options)).toThrow("摘要不符");
  const external = realpathSync(mkdtempSync(join(tmpdir(), "film-job-external-"))); roots.push(external);
  writeFileSync(join(external, "private.png"), "external"); symlinkSync(join(external, "private.png"), join(root, "escape.png"));
  expect(() => freezeFilmJobPostAssets(root, { "end-card-ref": "escape.png", "end-card-sha256": hash("external") })).toThrow("越出");
});
it("refuses conflicting content-addressed archive bytes instead of overwriting them", () => {
  const { root, options } = fixture(), frozen = freezeFilmJobPostAssets(root, options);
  writeFileSync(join(root, String(frozen["presentation-plan-ref"])), "conflict");
  expect(() => freezeFilmJobPostAssets(root, options)).toThrow("摘要不符");
});
