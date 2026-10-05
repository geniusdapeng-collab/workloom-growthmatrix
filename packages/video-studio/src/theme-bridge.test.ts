import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it, vi } from "vitest";
import { installVendorThemeBridge } from "./theme-bridge.js";
const metadata = { pipelineRoute: { kind: "marketing" }, brief: { durationSec: 30, audience: "酒店经营者", emotionalTone: "轻快明朗",
  visualStyle: "现代酒店前台自然窗光，写实摄影", dialogueRequirement: "出镜人物亲自介绍，仅用本次G1支持规格" } };
it("原真实生成器保留明确Brief，主题仍由原模型提炼，不随机回落Her/泛化受众", () => {
  const code = `import {createRequire} from 'node:module'; import {installVendorThemeBridge} from './packages/video-studio/src/theme-bridge.ts';
    const require=createRequire(import.meta.url); const {CreativeThemeGenerator}=require('./vendor/supermickey/hyperreality-system/skills/creative-theme-generator/index.js');
    let calls=0; const llm={generate:async()=>{calls++;return {content:JSON.stringify({theme:'模型生成主题',type:'商业广告'})}}};
    const system={creativeThemeGenerator:new CreativeThemeGenerator({llmEngine:llm})}; const restore=installVendorThemeBridge(system,${JSON.stringify(metadata)});
    const result=await system.creativeThemeGenerator.generate('完整已审来源、意图及制作限制。'.repeat(60)); restore(); console.log(JSON.stringify({result,calls}));`;
  const out = execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", code], {
    cwd: fileURLToPath(new URL("../../../", import.meta.url)), encoding: "utf8", timeout: 30_000 });
  const value = JSON.parse(out.trim().split("\n").pop()!);
  expect(value.calls).toBe(1); expect(value.result.tasks[0]).toMatchObject({ theme: "模型生成主题", type: "商业广告",
    duration_sec: 30, tone: "轻快明朗", target_audience: "酒店经营者", visual_style: metadata.brief.visualStyle });
  expect(value.result._originalStoryText).toContain("完整已审来源");
});
it("原生成失败/降级不可借桥通过，恢复原函数并拒绝晚到结果", async () => {
  let release!: (value: unknown) => void;
  const original = vi.fn().mockResolvedValueOnce({ tasks: [{ _degraded: "llm_extract_failed" }] })
    .mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
  const system = { creativeThemeGenerator: { generate: original } }, restore = installVendorThemeBridge(system, metadata);
  await expect(system.creativeThemeGenerator.generate("源全文")).rejects.toThrow("UNVERIFIED");
  const pending = system.creativeThemeGenerator.generate("源全文"); restore(); release({ tasks: [{}] });
  await expect(pending).rejects.toThrow("CLOSED"); expect(system.creativeThemeGenerator.generate).toBe(original);
});
