import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { readFilmPresentation, verifyPresentationAsset } from "./film-presentation.js";

const roots: string[] = [];
const ids = ["cool-tech", "warm-film", "punchy-social"];
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "film-present-")); roots.push(root);
  const variants = ids.map((id, index) => {
    for (const kind of ["font", "cover", "card", "music"]) writeFileSync(join(root, `${id}.${kind}`), `${id}:${kind}`);
    return { id, title: `Title ${index}`, fontName: `Font ${index}`, font: { path: `${id}.font` }, cover: { path: `${id}.cover` },
      endCard: { path: `${id}.card` }, bgm: { path: `${id}.music`, id: `track-${index}`, title: `Music ${index}` } };
  });
  const value = { schemaVersion: "workloom.film-presentation/v1", main: variants[0], variants };
  const file = join(root, "plan.json");
  const save = () => writeFileSync(file, JSON.stringify(value)); save();
  return { root, value, file, save };
}
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));

it("binds complete style assets to their actual bytes", () => {
  const { file } = fixture(); const plan = readFilmPresentation(file, ids);
  expect(plan.variants).toHaveLength(3);
  expect(new Set(plan.variants.map(row => row.bgm.sha256)).size).toBe(3);
  expect(plan.main.font.sha256).toMatch(/^[a-f0-9]{64}$/);
});
it.each(["font", "cover", "endCard", "bgm"] as const)("rejects two styles sharing actual %s bytes", key => {
  const { value, file, save } = fixture();
  value.variants[1]![key].path = value.variants[0]![key].path; save();
  expect(() => readFilmPresentation(file, ids)).toThrow("PRESENTATION_DUPLICATE");
});
it("does not accept changing a label while reusing the same title", () => {
  const { value, file, save } = fixture(); value.variants[1]!.title = value.variants[0]!.title; save();
  expect(() => readFilmPresentation(file, ids)).toThrow("DUPLICATE_TITLE");
});
it("requires all expected style IDs and rejects incomplete or duplicate entries", () => {
  const { value, file, save } = fixture(); value.variants[1]!.id = value.variants[0]!.id; save();
  expect(() => readFilmPresentation(file, ids)).toThrow("VARIANTS_INCOMPLETE");
});
it("rejects missing assets and changed bytes, including a change after preflight", () => {
  const { root, file } = fixture(); const entry = readFilmPresentation(file, ids).variants[0]!.bgm;
  writeFileSync(entry.path, "changed"); expect(() => verifyPresentationAsset(entry)).toThrow("ASSET_CHANGED");
  rmSync(join(root, "warm-film.font")); expect(() => readFilmPresentation(file, ids)).toThrow();
});
it("rejects invalid font syntax before it reaches an ASS or filter command", () => {
  const { value, file, save } = fixture(); value.variants[0]!.fontName = "Font,Injected"; save();
  expect(() => readFilmPresentation(file, ids)).toThrow("FONT_NAME_INVALID");
});
