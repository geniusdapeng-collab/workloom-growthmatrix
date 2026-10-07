import { expect, it } from "vitest";
import { assertPreservedSourceTiming, editorialShotIds, endCardSeconds, parseBgmTargetLufs, parseClipTailHolds, shouldBurnOpeningTitle } from "./film-post-options.js";

it("keeps source timing intact and rejects frozen-tail compensation", () => {
  expect(parseClipTailHolds("", 5)).toEqual([0, 0, 0, 0, 0]);
  expect(() => parseClipTailHolds("0,0,0,1,1", 5)).toThrow("SOURCE_TIMING_PROTECTED");
  expect(() => parseClipTailHolds("0.5,30", 2)).toThrow("SOURCE_TIMING_PROTECTED");
});
it.each(["1", "0,,0", "0,-1,0", "0,Infinity,0", "0,NaN,0", "0,31,0"])(
  "rejects malformed or unbounded tail holds %s", (value) => {
    expect(() => parseClipTailHolds(value, 3)).toThrow("CLIP_TAIL_HOLDS_INVALID");
  },
);
it("rejects an absent input clip registry", () => {
  expect(() => parseClipTailHolds("", 0)).toThrow("CLIP_COUNT_INVALID");
});
it("a separate cover carries the title even when it is not prepended to the video", () => {
  expect(shouldBurnOpeningTitle({ coverAvailable: true, noTitleCard: false, explicitOpeningTitle: false })).toBe(false);
  expect(shouldBurnOpeningTitle({ coverAvailable: false, noTitleCard: false, explicitOpeningTitle: false })).toBe(true);
  expect(shouldBurnOpeningTitle({ coverAvailable: true, noTitleCard: false, explicitOpeningTitle: true })).toBe(true);
  expect(shouldBurnOpeningTitle({ coverAvailable: true, noTitleCard: true, explicitOpeningTitle: true })).toBe(false);
});
it("honours an explicitly selected BGM target without imposing a different delivery loudness", () => {
  expect(parseBgmTargetLufs("-18")).toBe(-18);
  expect(parseBgmTargetLufs("-14")).toBe(-14);
  for (const value of ["", "NaN", "Infinity", "0", "-61"]) {
    expect(() => parseBgmTargetLufs(value)).toThrow("BGM_LUFS_INVALID");
  }
});
it("deletes only declared shots in post-production, preserving order and the original registry", () => {
  const ids = ["S1", "S2", "S3", "S4", "S5", "S6"];
  expect(editorialShotIds({ shotIds: ids, exclude: "S5", postOnly: true, reason: "客户删除突兀短镜，保留其他镜头" })).toEqual(["S1", "S2", "S3", "S4", "S6"]);
  expect(ids).toHaveLength(6);
  for (const exclude of ["S7", "S5,S5", ids.join(",")]) expect(() => editorialShotIds({ shotIds: ids, exclude, postOnly: true, reason: "客户删除突兀短镜，保留其他镜头" })).toThrow();
  expect(() => editorialShotIds({ shotIds: ids, exclude: "S5", postOnly: false, reason: "客户删除突兀短镜，保留其他镜头" })).toThrow("POST_ONLY");
});
it("permits a separately rendered end card instead of changing a source performance", () => {
  expect(endCardSeconds("", "")).toBe(0);
  expect(endCardSeconds("card.png", "2")).toBe(2);
  expect(() => endCardSeconds("", "2")).toThrow("IMAGE_REQUIRED");
  for (const value of ["0", "-1", "Infinity", "16"]) expect(() => endCardSeconds("card.png", value)).toThrow("DURATION_INVALID");
  expect(() => assertPreservedSourceTiming({ retimeTo: 30, transition: "", transitionDuration: 0 })).toThrow("SOURCE_TIMING_PROTECTED");
  expect(() => assertPreservedSourceTiming({ retimeTo: 0, transition: "fade", transitionDuration: 0.2 })).toThrow("SOURCE_TIMING_PROTECTED");
  expect(() => assertPreservedSourceTiming({ retimeTo: 0, transition: "", transitionDuration: 0 })).not.toThrow();
  for (const transitionDuration of [NaN, Infinity, -0.1]) {
    expect(() => assertPreservedSourceTiming({ retimeTo: 0, transition: "fade", transitionDuration })).toThrow("SOURCE_TIMING_PROTECTED");
  }
});
