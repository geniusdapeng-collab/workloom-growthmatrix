/** 平台真人和商品参考同时进入请求；本人照片仅供核对，绝不作为生成输入。 */
import { assertShotMatchesCertifiedAsset, assetIdOf, isRealPersonAssetRef, realPersonAssetRef,
  verifyRealPersonAsset, type RealPersonAsset } from "./real-person-asset.js";

export interface RenderReferences { refs: string[]; prompt: string; assetId: string | null }
export function buildRenderReferences(input: {
  shot: Record<string, unknown>; productImage: string; asset?: RealPersonAsset;
}): RenderReferences {
  if (!/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(input.productImage)) throw new Error("RENDER_PRODUCT_REFERENCE_INVALID");
  const originalPrompt = typeof input.shot.prompt === "string" ? input.shot.prompt.trim() : "";
  const assetRef = String(input.shot.assetRef ?? "").trim();
  const refs: string[] = [];
  let identity = "";
  if (assetRef) {
    if (!isRealPersonAssetRef(assetRef) || !input.asset) throw new Error("RENDER_PERSON_REFERENCE_UNREGISTERED");
    const issues = [...verifyRealPersonAsset(input.asset), ...assertShotMatchesCertifiedAsset({ ...input.shot,
      director_instruction: `${String(input.shot.director_instruction ?? "")}；${originalPrompt}` }, input.asset)].filter(issue => issue.hard);
    if (issues.length) throw new Error(`RENDER_PERSON_REFERENCE_INVALID：${issues.map(issue => issue.detail).join("；")}`);
    if (assetIdOf(assetRef) !== assetIdOf(input.asset.assetId)) throw new Error("RENDER_PERSON_REFERENCE_CHANGED");
    if (originalPrompt.length < 1200) throw new Error("RENDER_FORMAL_PROMPT_REQUIRED：真人商品镜必须保留完整受审提示词");
    refs.push(realPersonAssetRef(input.asset.assetId));
    identity = `图片1是唯一出镜真人的已登记平台授权引用。人物身份以图片1为准，主档属性：${JSON.stringify(input.asset.certified)}。保持受审镜头中的人物、衣装、动作与原台词，不改脸、不换人、不新增清晰人物；真人照片不进入生成输入。`;
  }
  refs.push(input.productImage);
  const productIndex = refs.length;
  return { refs, assetId: assetRef ? assetIdOf(assetRef) : null,
    prompt: [originalPrompt, identity,
      `图片${productIndex}是完整商品原图，只作为产品外观参考：机身、两片屏幕、摄像头及可见结构按原图保留，不裁掉或重新设计，不把可选配置变成现场机械变形。机位、真人表演与布景使用上面的正式镜头设计，不能把图片平移缩放当作视频。图片中的文字不复制为可读字幕或界面；不追加商品参数、品牌事实或效果宣称。`].filter(Boolean).join("\n\n") };
}
