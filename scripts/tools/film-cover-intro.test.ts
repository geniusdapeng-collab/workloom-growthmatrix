import { expect, it } from "vitest";
import { coverIntroTiming, shiftSubtitleTimes } from "./film-cover-intro.js";
it("cover duration is a separate frame-aligned segment, never a stretch of the body", () => {
  expect(coverIntroTiming(1.2, 30)).toEqual({ frames: 36, seconds: 1.2 });
  expect(coverIntroTiming(1.21, 30).frames).toBe(36);
  for (const seconds of [0, -1, 6, Infinity]) expect(() => coverIntroTiming(seconds, 30)).toThrow("TIMING_INVALID");
});
it("SRT offsets all cues across minute/hour boundaries and preserves multiline text", () => {
  const source = "1\n00:00:00,600 --> 00:00:04,680\nCEO\n第二行\n\n2\n00:59:59,900 --> 01:00:04,000\n终点\n";
  expect(shiftSubtitleTimes(source, "srt", 1.2)).toBe("1\n00:00:01,800 --> 00:00:05,880\nCEO\n第二行\n\n2\n01:00:01,100 --> 01:00:05,200\n终点\n");
});
it("ASS shifts only dialogue cue boundaries, retaining every styling field and inline animation", () => {
  const source = "Style: Sub,Font,53\nDialogue: 0,0:00:00.60,0:00:04.68,Sub,,0,0,0,,{\\fad(80,60)}Hello\n";
  expect(shiftSubtitleTimes(source, "ass", 1.2)).toBe("Style: Sub,Font,53\nDialogue: 0,0:00:01.80,0:00:05.88,Sub,,0,0,0,,{\\fad(80,60)}Hello\n");
});
it("VTT accepts both cue timestamp forms and keeps cue settings", () => {
  const source = "WEBVTT\n\n00:00.600 --> 00:04.680 align:center\nHello\n";
  expect(shiftSubtitleTimes(source, "vtt", 1.2)).toBe("WEBVTT\n\n00:00:01.800 --> 00:00:05.880 align:center\nHello\n");
});
it("bad cue times and offsets remain actual errors", () => {
  expect(() => shiftSubtitleTimes("1\n00:65:00,000 --> 00:65:01,000\na", "srt", 1.2)).toThrow("TIMESTAMP_INVALID");
  expect(() => shiftSubtitleTimes("", "srt", NaN)).toThrow("OFFSET_INVALID");
});
