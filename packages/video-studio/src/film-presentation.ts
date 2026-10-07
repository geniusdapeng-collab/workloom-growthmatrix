/** Authored post-production assets. No generation or model approval takes place here. */
import { createHash } from "node:crypto";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";

export interface PresentationAsset { path: string; sha256: string }
export interface FilmVariantPresentation {
  id: string; title: string; fontName: string; font: PresentationAsset;
  cover: PresentationAsset; endCard: PresentationAsset;
  bgm: PresentationAsset & { id: string; title: string };
}
export interface FilmPresentation {
  schemaVersion: "workloom.film-presentation/v1";
  main: FilmVariantPresentation;
  variants: FilmVariantPresentation[];
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("PRESENTATION_SCHEMA_INVALID");
  return value as Record<string, unknown>;
}
function text(value: unknown, max = 120): string {
  if (typeof value !== "string" || !value.trim() || value.length > max || /[\r\n\u0000]/u.test(value)) throw new Error("PRESENTATION_TEXT_INVALID");
  return value.trim();
}
function asset(value: unknown, root: string): PresentationAsset {
  const row = record(value);
  const path = realpathSync(resolve(root, text(row.path, 4096)));
  if (!statSync(path).isFile()) throw new Error("PRESENTATION_ASSET_INVALID");
  const bytes = readFileSync(path);
  if (!bytes.length) throw new Error("PRESENTATION_ASSET_EMPTY");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (row.sha256 !== undefined && row.sha256 !== sha256) throw new Error("PRESENTATION_ASSET_CHANGED");
  return { path, sha256 };
}
function variant(value: unknown, root: string): FilmVariantPresentation {
  const row = record(value);
  const id = text(row.id);
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/u.test(id)) throw new Error("PRESENTATION_ID_INVALID");
  const fontName = text(row.fontName);
  if (/[,{}'\\]/u.test(fontName)) throw new Error("PRESENTATION_FONT_NAME_INVALID");
  const music = record(row.bgm);
  return { id, title: text(row.title, 60), fontName, font: asset(row.font, root), cover: asset(row.cover, root),
    endCard: asset(row.endCard, root), bgm: { ...asset(music, root), id: text(music.id), title: text(music.title) } };
}
/** Check the actual assets before any work; aliases of one file cannot masquerade as different styles. */
export function readFilmPresentation(file: string, expectedIds: readonly string[]): FilmPresentation {
  const doc = record(JSON.parse(readFileSync(file, "utf8")));
  if (doc.schemaVersion !== "workloom.film-presentation/v1" || !Array.isArray(doc.variants)) throw new Error("PRESENTATION_SCHEMA_INVALID");
  const root = dirname(resolve(file));
  const variants = doc.variants.map((value) => variant(value, root));
  const actualIds = variants.map((row) => row.id);
  if (variants.length !== expectedIds.length || new Set(actualIds).size !== expectedIds.length
    || expectedIds.some((id) => !actualIds.includes(id))) throw new Error("PRESENTATION_VARIANTS_INCOMPLETE");
  const distinct = (values: string[], name: string): void => {
    if (new Set(values).size !== variants.length) throw new Error(`PRESENTATION_DUPLICATE_${name}`);
  };
  distinct(variants.map((row) => row.title), "TITLE");
  distinct(variants.map((row) => row.font.sha256), "FONT");
  distinct(variants.map((row) => row.cover.sha256), "COVER");
  distinct(variants.map((row) => row.endCard.sha256), "END_CARD");
  distinct(variants.map((row) => row.bgm.sha256), "BGM");
  return { schemaVersion: "workloom.film-presentation/v1", main: variant(doc.main, root), variants };
}

export function verifyPresentationAsset(entry: PresentationAsset): void {
  if (createHash("sha256").update(readFileSync(entry.path)).digest("hex") !== entry.sha256) throw new Error("PRESENTATION_ASSET_CHANGED");
}
