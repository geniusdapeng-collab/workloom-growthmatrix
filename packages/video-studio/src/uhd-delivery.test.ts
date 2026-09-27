import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { publishUhdDelivery } from "./uhd-delivery.js";

const temporary: string[] = [];
afterEach(() => { for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const sha = (value: string) => createHash("sha256").update(value).digest("hex");

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "uhd-publish-")); temporary.push(dir);
  const stagingDir = join(dir, ".uhd-staging", "source-a");
  const officialRoot = join(dir, "uhd"), publicDir = join(officialRoot, "versions", "release-a");
  const latestFile = join(officialRoot, "latest.json");
  mkdirSync(stagingDir, { recursive: true }); mkdirSync(officialRoot);
  writeFileSync(join(officialRoot, "old-master.mp4"), "last approved release");
  writeFileSync(join(officialRoot, "cover.png"), "old approved cover");
  writeFileSync(join(officialRoot, "softsub.mp4"), "old approved soft subtitles");
  writeFileSync(latestFile, '{"publicDir":"old-generation"}\n');
  writeFileSync(join(stagingDir, "master.mp4"), "new reviewed master");
  writeFileSync(join(stagingDir, "variant.mp4"), "new measured variant");
  writeFileSync(join(stagingDir, "cover.png"), "new reviewed cover");
  writeFileSync(join(stagingDir, "softsub.mp4"), "new verified soft subtitles");
  const manifestName = "delivery-manifest.json";
  writeFileSync(join(stagingDir, manifestName), JSON.stringify({
    deliverable: { path: join(publicDir, "master.mp4"), sha256: sha("new reviewed master") },
    variants: [{ path: join(publicDir, "variant.mp4"), sha256: sha("new measured variant") }],
    assetSha256: [
      { path: join(publicDir, "master.mp4"), sha256: sha("new reviewed master") },
      { path: join(publicDir, "variant.mp4"), sha256: sha("new measured variant") },
      { path: join(publicDir, "cover.png"), sha256: sha("new reviewed cover") },
      { path: join(publicDir, "softsub.mp4"), sha256: sha("new verified soft subtitles") },
    ],
  }));
  return { stagingDir, officialRoot, publicDir, latestFile, manifestName,
    assets: ["master.mp4", "variant.mp4", "cover.png", "softsub.mp4", manifestName] };
}

describe("UHD package publication", () => {
  it("闸门未通过时不能将任何候选文件放进正式目录", async () => {
    const input = fixture();
    await expect(publishUhdDelivery({ ...input, approved: false })).rejects.toThrow("GATE_NOT_APPROVED");
    expect(readFileSync(join(input.officialRoot, "old-master.mp4"), "utf8")).toBe("last approved release");
    expect(readFileSync(join(input.officialRoot, "cover.png"), "utf8")).toBe("old approved cover");
    expect(readFileSync(join(input.officialRoot, "softsub.mp4"), "utf8")).toBe("old approved soft subtitles");
    expect(readFileSync(input.latestFile, "utf8")).toBe('{"publicDir":"old-generation"}\n');
    expect(existsSync(input.publicDir)).toBe(false);
  });

  it("全闸通过后以一代目录发布母版、变体和清单", async () => {
    const input = fixture();
    const result = await publishUhdDelivery({ ...input, approved: true });
    expect(result.files).toBe(5);
    expect(readFileSync(join(input.publicDir, "master.mp4"), "utf8")).toBe("new reviewed master");
    expect(readFileSync(join(input.publicDir, "variant.mp4"), "utf8")).toBe("new measured variant");
    expect(readFileSync(join(input.publicDir, "cover.png"), "utf8")).toBe("new reviewed cover");
    expect(readFileSync(join(input.publicDir, "softsub.mp4"), "utf8")).toBe("new verified soft subtitles");
    expect(readFileSync(join(input.officialRoot, "old-master.mp4"), "utf8")).toBe("last approved release");
    expect(existsSync(join(input.stagingDir, "master.mp4"))).toBe(true);
    expect(JSON.parse(readFileSync(input.latestFile, "utf8")).publicDir).toBe(input.publicDir);
  });

  it("清单摘要伪绿时保持上一代目录完整", async () => {
    const input = fixture();
    const manifest = JSON.parse(readFileSync(join(input.stagingDir, input.manifestName), "utf8"));
    manifest.variants[0].sha256 = sha("another variant");
    writeFileSync(join(input.stagingDir, input.manifestName), JSON.stringify(manifest));
    await expect(publishUhdDelivery({ ...input, approved: true })).rejects.toThrow("MANIFEST_DIGEST_MISMATCH");
    expect(readFileSync(join(input.officialRoot, "old-master.mp4"), "utf8")).toBe("last approved release");
    expect(readFileSync(join(input.officialRoot, "cover.png"), "utf8")).toBe("old approved cover");
    expect(readFileSync(join(input.officialRoot, "softsub.mp4"), "utf8")).toBe("old approved soft subtitles");
    expect(readFileSync(input.latestFile, "utf8")).toBe('{"publicDir":"old-generation"}\n');
    expect(existsSync(input.publicDir)).toBe(false);
  });

  it("候选封面或软字幕摘要不符时保留旧正式文件", async () => {
    const input = fixture();
    writeFileSync(join(input.stagingDir, "cover.png"), "cover changed after review");
    await expect(publishUhdDelivery({ ...input, approved: true })).rejects.toThrow("MANIFEST_DIGEST_MISMATCH");
    expect(readFileSync(join(input.officialRoot, "cover.png"), "utf8")).toBe("old approved cover");
    expect(readFileSync(join(input.officialRoot, "softsub.mp4"), "utf8")).toBe("old approved soft subtitles");
    expect(readFileSync(input.latestFile, "utf8")).toBe('{"publicDir":"old-generation"}\n');
  });

  it("latest 指针替换失败时不宣称发布，旧指针与旧素材均不变", async () => {
    const input = fixture();
    await expect(publishUhdDelivery({ ...input, approved: true }, (from, to) => {
      if (to === input.latestFile) throw new Error("pointer write failure");
      renameSync(from, to);
    })).rejects.toThrow("pointer write failure");
    expect(readFileSync(input.latestFile, "utf8")).toBe('{"publicDir":"old-generation"}\n');
    expect(readFileSync(join(input.officialRoot, "cover.png"), "utf8")).toBe("old approved cover");
    expect(readFileSync(join(input.officialRoot, "softsub.mp4"), "utf8")).toBe("old approved soft subtitles");
    expect(existsSync(input.publicDir)).toBe(false);
  });

  it("相对路径越界在复制前拒绝", async () => {
    const input = fixture();
    await expect(publishUhdDelivery({ ...input, assets: [...input.assets, "../escape"], approved: true })).rejects.toThrow("UNSAFE_PATH");
    expect(existsSync(join(input.officialRoot, "old-master.mp4"))).toBe(true);
  });
});
