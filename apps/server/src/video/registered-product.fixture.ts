/** Isolated synthetic protocol fixtures; never a customer archive or production source. */
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { deflateSync } from "node:zlib";

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type: string, bytes: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from(type), bytes]);
  const size = Buffer.alloc(4), crc = Buffer.alloc(4);
  size.writeUInt32BE(bytes.length); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([size, body, crc]);
}
function syntheticPng(seed: number): Buffer {
  const width = 320, height = 64, stride = width * 3 + 1;
  const pixels = Buffer.alloc(stride * height);
  let value = seed;
  for (let row = 0; row < height; row++) {
    for (let column = 1; column < stride; column++) {
      value = (Math.imul(value, 1664525) + 1013904223) >>> 0;
      pixels[row * stride + column] = value >>> 24;
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header), chunk("IDAT", deflateSync(pixels)), chunk("IEND", Buffer.alloc(0))]);
}

export async function writeRegisteredProductFixture(libraryRoot: string): Promise<Record<string, any>> {
  const dir = path.join(libraryRoot, "demo-t001");
  await mkdir(path.join(dir, "photos"), { recursive: true });
  const photos = [];
  for (const [index, role] of ["hero", "detail"].entries()) {
    const bytes = syntheticPng(index + 1), file = `photos/${role}.png`;
    await writeFile(path.join(dir, file), bytes);
    photos.push({ id: role, file, role, width: 320, height: 64, bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex") });
  }
  const profile = {
    schemaVersion: "workloom.product-archive/v1", id: "demo-t001", type: "product",
    displayName: "示例品牌 台式双屏自助机", aliases: ["台式双屏自助机", "DEMO-T001"],
    brand: "示例品牌", model: "DEMO-T001",
    source: {
      kind: "user-upload", priority: 10, reviewStatus: "owner-confirmed",
      extraction: { method: "synthetic-test-fixture", verified: false },
      evidence: [1, 2, 4].map(slide => ({
        quote: `测试夹具第${slide}页：示例品牌 台式双屏自助机 DEMO-T001，角度调节摄像头，双屏模式自由切换。`,
        file: "synthetic-fixture.pptx", slide, deckSha256: "a".repeat(64),
        query: "synthetic fixture", url: "https://example.invalid/synthetic-fixture",
      })),
    },
    photos, specs: { features: ["前置2MP双目人脸识别"] },
  };
  await writeFile(path.join(dir, "profile.json"), JSON.stringify(profile));
  return profile;
}
