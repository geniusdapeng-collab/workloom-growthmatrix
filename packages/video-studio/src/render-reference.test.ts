import { expect, it } from "vitest";
import { buildRenderReferences } from "./render-reference.js";
import type { RealPersonAsset } from "./real-person-asset.js";
const asset = (): RealPersonAsset => ({ schemaVersion: "workloom.real-person-asset/v1", assetId: "asset-person", displayName: "出镜人物",
  certified: { gender: "female", ageBand: "三十岁上下", source: "客户授权登记" }, authorization: { status: "real-authorized", evidence: "登记凭证" },
  anchorPhoto: "anchor.jpg", referenceAssets: ["asset-other"] });
const shot = () => ({ shotId: "S1", character: "出镜人物，三十岁上下", assetRef: "asset://asset-person", prompt: "正式审核镜头正文".repeat(200) });
const productImage = "data:image/jpeg;base64,YWJj";
it("真人平台引用与完整商品图片同时传入，索引对应且原正式提示词不丢失", () => {
  const s = shot(), request = buildRenderReferences({ shot: s, productImage, asset: asset() });
  expect(request.refs).toEqual(["asset://asset-person", productImage]);
  expect(request.prompt.startsWith(s.prompt)).toBe(true); expect(request.prompt).toContain("图片1是唯一出镜真人");
  expect(request.prompt).toContain("图片2是完整商品原图"); expect(request.refs.join()).not.toContain("anchor.jpg");
});
it.each(["missing", "wrong", "revoked", "gender", "short"])("%s属性或授权错误在付费前拒绝", kind => {
  const s = shot(), person = asset();
  if (kind === "wrong") person.assetId = "another";
  if (kind === "revoked") person.authorization.status = "revoked";
  if (kind === "gender") s.character = "男士，三十岁上下";
  if (kind === "short") s.prompt = "不足完整提示词";
  expect(() => buildRenderReferences({ shot: s, productImage, asset: kind === "missing" ? undefined : person })).toThrow(/RENDER_/);
});
it("不带人物的素材仍只送商品原图；禁止以本人文件路径替代商品引用", () => {
  expect(buildRenderReferences({ shot: {}, productImage }).refs).toEqual([productImage]);
  expect(() => buildRenderReferences({ shot: {}, productImage: "/private/person.jpg" })).toThrow("PRODUCT_REFERENCE_INVALID");
});
