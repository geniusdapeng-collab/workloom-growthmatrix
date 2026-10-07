/** Local post-production options; source performances retain their original timing. */
export function parseClipTailHolds(value: string, clipCount: number): number[] {
  if (!Number.isInteger(clipCount) || clipCount < 1) throw new Error("CLIP_COUNT_INVALID");
  if (!value.trim()) return Array<number>(clipCount).fill(0);
  const parts = value.split(",");
  if (parts.length !== clipCount) throw new Error("CLIP_TAIL_HOLDS_INVALID: one value is required per input clip");
  const holds = parts.map((part) => {
    const seconds = Number(part);
    if (!part.trim() || !Number.isFinite(seconds) || seconds < 0 || seconds > 30) {
      throw new Error("CLIP_TAIL_HOLDS_INVALID: hold seconds must be finite and between 0 and 30");
    }
    return seconds;
  });
  if (holds.some((seconds) => seconds > 0)) {
    throw new Error("SOURCE_TIMING_PROTECTED: do not freeze or extend rendered shots; append a separate end card or accept a shorter film");
  }
  return holds;
}

export function editorialShotIds(input: {
  shotIds: readonly string[]; exclude: string; postOnly: boolean; reason: string;
}): string[] {
  const removed = input.exclude.split(",").map((value) => value.trim()).filter(Boolean);
  if (!removed.length) return [...input.shotIds];
  if (!input.postOnly || input.reason.trim().length < 8) throw new Error("EDITORIAL_EXCLUSION_POST_ONLY: a declared post-only edit is required");
  if (new Set(removed).size !== removed.length || removed.some((id) => !input.shotIds.includes(id))) {
    throw new Error("EDITORIAL_EXCLUSION_INVALID: unknown or duplicate shot ID");
  }
  const retained = input.shotIds.filter((id) => !removed.includes(id));
  if (!retained.length) throw new Error("EDITORIAL_EXCLUSION_EMPTY: retain at least one shot");
  return retained;
}

export function endCardSeconds(image: string, value: string): number {
  if (!image.trim()) {
    if (value.trim()) throw new Error("END_CARD_IMAGE_REQUIRED");
    return 0;
  }
  const seconds = Number(value || "2");
  if (!Number.isFinite(seconds) || seconds < 1 || seconds > 15) throw new Error("END_CARD_DURATION_INVALID: expected 1–15 seconds");
  return seconds;
}

export function assertPreservedSourceTiming(input: { retimeTo: number; transition: string; transitionDuration: number }): void {
  if (!Number.isFinite(input.retimeTo) || input.retimeTo !== 0) throw new Error("SOURCE_TIMING_PROTECTED: automatic retiming is forbidden");
  if (!Number.isFinite(input.transitionDuration) || input.transitionDuration < 0) throw new Error("SOURCE_TIMING_PROTECTED: transition duration must be finite and nonnegative");
  if (input.transition && input.transitionDuration > 0) throw new Error("SOURCE_TIMING_PROTECTED: overlapping transitions shorten rendered shots; use a hard cut or a separate transition segment");
}

export function shouldBurnOpeningTitle(input: {
  coverAvailable: boolean; noTitleCard: boolean; explicitOpeningTitle: boolean;
}): boolean {
  return !input.noTitleCard && (!input.coverAvailable || input.explicitOpeningTitle);
}

export function parseBgmTargetLufs(value: string): number {
  const target = Number(value);
  if (!value.trim() || !Number.isFinite(target) || target < -60 || target > -1) {
    throw new Error("BGM_LUFS_INVALID: a finite target between -60 and -1 is required");
  }
  return target;
}
