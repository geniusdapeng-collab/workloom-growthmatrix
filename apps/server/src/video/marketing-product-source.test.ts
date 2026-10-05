import { cp, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { assertProductSourceQuery, loadRegisteredProductSource, loadProductVisualReferences, verifyArchivedProductSource } from "./marketing-product-source.js";
import { canonicalRenderJson } from "./gen/compiled-request.js";

const builtin = fileURLToPath(new URL("../../../../bundles/ai-video/library/products/demo-t001/", import.meta.url));
let root: string, profile: Record<string, any>;
beforeEach(async () => {
  root = await realpath(await mkdtemp(path.join(tmpdir(), "registered-marketing-source-")));
  await cp(builtin, path.join(root, "demo-t001"), { recursive: true });
  profile = JSON.parse(await readFile(path.join(root, "demo-t001/profile.json"), "utf8"));
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
const load = (selector: unknown = { id: "demo-t001" }) => loadRegisteredProductSource(selector, { libraryRoot: root });
async function save() { await writeFile(path.join(root, "demo-t001/profile.json"), JSON.stringify(profile)); }

describe("登记客户商品摘录来源", () => {
  it("登记图像从受控库复读，与归档来源和实际图像字节绑定；不能插入任意路径", async () => {
    const source = (await load())!;
    const refs = await loadProductVisualReferences([source.snapshot], { libraryRoot: root });
    expect(refs).toHaveLength(profile.photos.length);
    expect(refs[0]).toMatchObject({ sourceId: source.snapshot.sourceId, archiveSha256: source.snapshot.rawSha256,
      path: path.join(root, "demo-t001", profile.photos[0].file), sha256: profile.photos[0].sha256 });
    profile.displayName += "变更"; await save();
    await expect(loadProductVisualReferences([source.snapshot], { libraryRoot: root })).rejects.toThrow("MARKETING_VISUAL_SOURCE_CHANGED");
  });
  it("登记图像实际字节变化不能复用视觉证明", async () => {
    const source = (await load())!;
    await writeFile(path.join(root, "demo-t001", profile.photos[0].file), "changed-image");
    await expect(loadProductVisualReferences([source.snapshot], { libraryRoot: root })).rejects.toThrow("MARKETING_ARCHIVE_INVALID");
  });
  it("读取真实登记字节/商品图片，仅摘录入正文，保留原件未重开与机器映射未核实", async () => {
    const source = (await load())!;
    expect(source.rawBytes.equals(await readFile(path.join(root, "demo-t001/profile.json")))).toBe(true);
    expect(source.snapshot.text).toContain("角度调节摄像头，双屏模式自由切换");
    expect(source.snapshot.text).not.toContain("前置2MP双目人脸识别"); // specs中的未引证映射不能变成正文
    expect(source.snapshot.archive).toMatchObject({ originalReopened: false, extractionVerified: false,
      evidence: expect.arrayContaining([expect.objectContaining({ page: 4, originalSha256: profile.source.evidence[2].deckSha256 })]) });
    expect(source.snapshot.assetUrls).toEqual([]);
    expect(() => verifyArchivedProductSource(source.snapshot, source.rawBytes)).not.toThrow();
    expect(() => assertProductSourceQuery(source, { name: profile.displayName, brand: "示例品牌", model: "DEMO-T001" })).not.toThrow();
  });
  it("完整请求档案必须等于正式库；登记顺序或JSON排版不改变语义", async () => {
    expect((await load(profile))!.snapshot.rawSha256).toBe((await load())!.snapshot.rawSha256);
    await expect(load({ ...profile, specs: { features: ["零秒入住"] } })).rejects.toThrow("MARKETING_ARCHIVE_CHANGED");
  });
  it.each(["../demo-t001", "/etc/passwd", "demo-t001/../../secret", "demo-t001\\secret", "", 42, [], { id: "demo-t001", path: "/etc/passwd" }])("拒绝任意路径/自造请求 %j", async selector => {
    await expect(load(selector)).rejects.toThrow(/MARKETING_ARCHIVE_(SELECTOR_INVALID|CHANGED)/);
  });
  it("未选档案返回null，未登记id明确拒绝", async () => {
    expect(await loadRegisteredProductSource(undefined)).toBeNull();
    await expect(load("not-registered")).rejects.toThrow("MARKETING_ARCHIVE_NOT_FOUND");
  });
  it.each(["directory", "profile", "photo", "root"])("%s符号链接不能逃离正式库", async target => {
    if (target === "directory") await symlink(path.join(root, "demo-t001"), path.join(root, "alias"));
    if (target === "profile") {
      await writeFile(path.join(root, "external.json"), JSON.stringify(profile));
      await rm(path.join(root, "demo-t001/profile.json")); await symlink(path.join(root, "external.json"), path.join(root, "demo-t001/profile.json"));
    }
    if (target === "photo") {
      const photo = path.join(root, "demo-t001", profile.photos[0].file);
      await cp(photo, path.join(root, "external.jpg")); await rm(photo); await symlink(path.join(root, "external.jpg"), photo);
    }
    if (target === "root") {
      await symlink(root, `${root}-alias`);
      try { await expect(loadRegisteredProductSource("demo-t001", { libraryRoot: `${root}-alias` })).rejects.toThrow("MARKETING_ARCHIVE_PATH_INVALID"); }
      finally { await rm(`${root}-alias`); }
      return;
    }
    await expect(load(target === "directory" ? "alias" : "demo-t001")).rejects.toThrow("MARKETING_ARCHIVE_PATH_INVALID");
  });
  it.each(["source", "pending", "quote", "page", "digest", "photo-hash", "identity"])("%s不合法不能获得登记来源", async target => {
    if (target === "source") profile.source.kind = "system-generated";
    if (target === "pending") profile.source.reviewStatus = "pending-owner-review";
    if (target === "quote") delete profile.source.evidence[0].quote;
    if (target === "page") profile.source.evidence[0].slide = 0;
    if (target === "digest") profile.source.evidence[0].deckSha256 = "not-a-digest";
    if (target === "photo-hash") profile.photos[0].sha256 = "0".repeat(64);
    if (target === "identity") profile.id = "wrong";
    await save(); await expect(load()).rejects.toThrow(/MARKETING_ARCHIVE_(INVALID|ID_MISMATCH)/);
  });
  it.each([{ name: "其他商品" }, { name: "DEMO-T001", model: "DEMO-02" }, { name: "DEMO-T001", brand: "其他品牌" }])("拒绝跨商品查询%j", async query => {
    const source = (await load())!;
    expect(() => assertProductSourceQuery(source, query)).toThrow("MARKETING_ARCHIVE_PRODUCT_MISMATCH");
  });
  it.each(["raw", "text", "origin", "digest", "page", "address", "assets"])("复读拒绝%s变化，不能自报原件已核实", async target => {
    const source = (await load())!, snapshot = structuredClone(source.snapshot);
    let raw = source.rawBytes;
    if (target === "raw") raw = Buffer.from(canonicalRenderJson({ ...profile, displayName: "被替换" }));
    if (target === "text") snapshot.text += "\n新增卖点";
    if (target === "origin") (snapshot.archive as any).originalReopened = true;
    if (target === "digest") snapshot.archive.archiveSha256 = "0".repeat(64);
    if (target === "page") snapshot.archive.evidence[0]!.page++;
    if (target === "address") snapshot.requestedUrl = "file:///etc/passwd";
    if (target === "assets") snapshot.assetUrls.push("file:///etc/passwd");
    expect(() => verifyArchivedProductSource(snapshot, raw)).toThrow("MARKETING_ARCHIVE_CHANGED");
  });
});
