/** Stable paid-generation storage and conservative adoption of historical CLI evidence. */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export interface FilmGenerationReceiptRoots {
  root: string; imageRoot: string; videoRoot: string; legacyVideoRoots: string[]; evidenceWorkDirs: string[];
}
export function filmGenerationReceiptRoots(input: {
  repoRoot: string; workDir: string; artifactRoot?: string; receiptRoot?: string; legacyVideoRoots?: string[];
}): FilmGenerationReceiptRoots {
  if (![input.repoRoot, input.workDir].every(value => typeof value === "string" && value.trim())) throw new Error("GENERATION_ROOT_INVALID");
  const root = resolve(input.receiptRoot || join(input.artifactRoot || input.repoRoot, "output", "generation-receipts"));
  const legacyVideoRoots = [...new Set([join(resolve(input.workDir), "render-task-receipts"),
    join(resolve(input.repoRoot), ".vm-work", "render-task-receipts"), ...(input.legacyVideoRoots ?? []).map(value => {
      if (typeof value !== "string" || !value.trim() || /[\0\r\n]/u.test(value)) throw new Error("LEGACY_GENERATION_ROOT_INVALID");
      return resolve(value);
    })])];
  return { root, imageRoot: join(root, "images"), videoRoot: join(root, "videos"), legacyVideoRoots,
    evidenceWorkDirs: [...new Set([resolve(input.workDir), ...legacyVideoRoots.map(dirname)])] };
}
/** An artifact or dispatch record without a known provider acceptance cannot authorize another paid POST. */
export function hasPriorFilmGeneration(input: {
  projectId: string; shotId: string; kind: "image" | "video"; workDirs: string[]; targets?: string[];
}): boolean {
  for (const value of [input.projectId, input.shotId]) if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value) || value.includes("..")) throw new Error("GENERATION_SCOPE_INVALID");
  if ((input.targets ?? []).some(file => existsSync(file))) return true;
  for (const root of input.workDirs) {
    const directory = join(root, input.kind === "image" ? "plates" : "clips", input.projectId);
    if (existsSync(directory) && readdirSync(directory).some(name => name.startsWith(`${input.shotId}.`) || name.startsWith(`${input.shotId}-`))) return true;
    const history = join(root, "logs", input.projectId, "stages.jsonl");
    if (!existsSync(history)) continue;
    for (const line of readFileSync(history, "utf8").split("\n").filter(line => line.trim())) {
      let row: unknown;
      try { row = JSON.parse(line); }
      catch { throw new Error("GENERATION_HISTORY_UNREADABLE: reconcile dispatch evidence before any paid POST"); }
      if (!row || typeof row !== "object" || Array.isArray(row)) throw new Error("GENERATION_HISTORY_UNREADABLE");
      const record = row as Record<string, unknown>;
      const stages = input.kind === "image" ? ["keyframe"] : ["shot", "material-gen"];
      if (record.shotId === input.shotId && stages.includes(String(record.stage)) && record.invoked === true) return true;
    }
  }
  return false;
}
