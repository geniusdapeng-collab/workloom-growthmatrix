import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { installVendorRequirementBridge, type RequirementBridgeTarget } from "./requirement-bridge.js";

const discovery = () => ({
  audienceProfile: { primaryAudience: { interestTags: ["酒店"] } },
  sceneStructure: { sceneCount: 1, totalDuration: 30,
    opening: { duration: 5, purpose: "CEO看向镜头介绍台式设备", keyElements: ["酒店柜台", "双屏自助机"], props: ["酒店柜台", "双屏自助机"], actions: ["CEO看向镜头"] },
    scenes: [{ duration: 20, purpose: "CEO指向摄像头展示调节位置", keyElements: ["摄像头"], props: ["摄像头"], actions: ["CEO指向摄像头"] }],
    ending: { duration: 5, purpose: "CEO点头致意并收束介绍", keyElements: ["双屏自助机"], props: ["双屏自助机"], actions: ["CEO点头致意"] } },
  riskAssessment: { businessConstraints: ["不编造节省时间效果"] }, referenceCases: {},
});
const metadata = (name = "出镜人物") => ({ characterArchive: { id: "demo-character", name,
  identity: { gender: "female" }, wardrobe: [{ detail: "黑色套装" }], authorization: { evidence: "asset://registered" } },
  brief: { product: "真实商品", aspectRatio: "9:16", platform: "douyin" } });

function target(convert: RequirementBridgeTarget["_convertDiscoveryToRequirementList"] = vi.fn(async () => ({ characters: [], targetDuration: 30, contentConstraints: ["不编造节省时间效果"] }))) {
  return {
    requirementDiscoveryEngine: { discover: vi.fn(async () => discovery()) },
    _convertDiscoveryToRequirementList: convert,
    _renderRequirementContract: vi.fn(() => "old heuristic fragments"),
  } as RequirementBridgeTarget;
}

describe("真实异步需求转换接缝", () => {
  it("discover直到原始转换完成才返回，同步消费者得到完整对象并继承明确档案", async () => {
    let release!: () => void;
    const pending = new Promise<void>((r) => { release = r; });
    const source = metadata();
    const system = target(vi.fn(async () => { await pending; return { characters: [], targetDuration: 30, contentConstraints: ["约束"] }; }));
    const original = structuredClone(source);
    const restore = installVendorRequirementBridge(system, source);
    let done = false;
    const running = system.requirementDiscoveryEngine.discover({}).then((value) => { done = true; return value; });
    await Promise.resolve(); expect(done).toBe(false);
    release(); const data = await running;
    const list = system._convertDiscoveryToRequirementList(data, {});
    expect(list).not.toBeInstanceOf(Promise);
    expect(list).toMatchObject({ characters: [{ name: "出镜人物", id: "demo-character", assetRef: "asset://registered" }] });
    expect(data.sceneStructure).toMatchObject({ sceneCount: 3, totalDuration: 30 });
    expect(source).toEqual(original);
    const sheet = system._renderRequirementContract("实际光和后期和三种风格", source, list as Record<string, unknown>, data);
    expect(sheet).toContain("出镜人物");
    expect(sheet).toContain("CEO指向摄像头展示调节位置");
    expect(sheet).not.toContain("期和三种风"); expect(sheet).not.toContain("无真人角色");
    expect(sheet).toContain("结构化生成物");
    restore(); restore();
  });

  it("不同实例交错转换不会串角色或缓存", async () => {
    const a = target(); const b = target();
    const restoreA = installVendorRequirementBridge(a, metadata("A"));
    const restoreB = installVendorRequirementBridge(b, metadata("B"));
    const [da, db] = await Promise.all([a.requirementDiscoveryEngine.discover({}), b.requirementDiscoveryEngine.discover({})]);
    expect(a._convertDiscoveryToRequirementList(da, {})).toMatchObject({ characters: [{ name: "A" }] });
    expect(b._convertDiscoveryToRequirementList(db, {})).toMatchObject({ characters: [{ name: "B" }] });
    expect(() => a._convertDiscoveryToRequirementList(db, {})).toThrow("NOT_READY");
    restoreA(); expect(b._convertDiscoveryToRequirementList(db, {})).toMatchObject({ characters: [{ name: "B" }] }); restoreB();
  });

  it("真实vendor的异步画像解析器只调用一次，字段继续来自原转换", async () => {
    // Real Node avoids Vitest transforming the vendor's CommonJS dependency graph as ESM.
    const code = `import {createRequire} from 'node:module';
      import {installVendorRequirementBridge} from './packages/video-studio/src/requirement-bridge.ts';
      const require=createRequire(import.meta.url);
      const {HyperrealitySystem}=require('./vendor/supermickey/hyperreality-system/index.js');
      const system=Object.create(HyperrealitySystem.prototype); let calls=0;
      system._profileResolver={resolve:async()=>{calls++;return {genre:'商业广告',genreConfidence:0.9,presetRef:'AD',profileSource:'llm',profile:{duration_target:30,aspect_ratio:'9:16',special_constraints:['source-bound']}}}};
      system.requirementDiscoveryEngine={discover:async()=>(${JSON.stringify(discovery())})};
      const metadata=${JSON.stringify(metadata())};
      const restore=installVendorRequirementBridge(system,metadata);
      const upstream={duration_sec:30,theme:'真实主题',tone:'专业',description:'模型主题正文'};
      const data=await system.requirementDiscoveryEngine.discover(upstream);
      const list=system._convertDiscoveryToRequirementList(data,upstream);
      const sheet=system._renderRequirementContract('',metadata,list,data);
      restore();console.log(JSON.stringify({calls,list,sheet,isPromise:list instanceof Promise}));`;
    const out = execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", code], {
      cwd: fileURLToPath(new URL("../../../", import.meta.url)), encoding: "utf8", timeout: 30_000,
    });
    const result = JSON.parse(out.trim().split("\n").pop()!);
    expect(result.calls).toBe(1); expect(result.isPromise).toBe(false);
    expect(result.list).toMatchObject({ title: "真实主题", genre: "商业广告", tone: "专业", targetDuration: 30, contentConstraints: ["不编造节省时间效果"] });
    expect(result.sheet).toContain("不编造节省时间效果");
  });

  it("转换失败不能留下缓存或制造批准", async () => {
    const system = target(vi.fn(async () => { throw new Error("actual profile failure"); }));
    const restore = installVendorRequirementBridge(system, metadata());
    await expect(system.requirementDiscoveryEngine.discover({})).rejects.toThrow("actual profile failure");
    expect(() => system._convertDiscoveryToRequirementList(discovery(), {})).toThrow("NOT_READY"); restore();
  });

  it("未知生成物或更换清单不能借用另一个已完成转换", async () => {
    const system = target(); const restore = installVendorRequirementBridge(system, metadata());
    const data = await system.requirementDiscoveryEngine.discover({});
    expect(() => system._renderRequirementContract("", metadata(), {}, data)).toThrow("NOT_READY"); restore();
  });

  it.each([null, [], "bad"])("非法转换输出%s拒绝", async (output) => {
    const system = target(vi.fn(async () => output as never)); const restore = installVendorRequirementBridge(system, metadata());
    await expect(system.requirementDiscoveryEngine.discover({})).rejects.toThrow("REQUIREMENT_BRIDGE_INVALID"); restore();
  });

  it.each([{ characters: "bad" }, { characters: [{}] }, { characterArchive: { id: "missing-name" } }])("非法明确角色拒绝且不动原函数", (input) => {
    const system = target(); const original = system.requirementDiscoveryEngine.discover;
    expect(() => installVendorRequirementBridge(system, input)).toThrow("CHARACTERS_INVALID");
    expect(system.requirementDiscoveryEngine.discover).toBe(original);
  });

  it("无明确角色保留vendor角色，显式空表则保持无人设定", async () => {
    for (const input of [{}, { characters: [] }]) {
      const system = target(vi.fn(async () => ({ characters: [{ name: "模型角色" }], targetDuration: 30 })));
      const restore = installVendorRequirementBridge(system, input);
      const data = await system.requirementDiscoveryEngine.discover({});
      expect(system._convertDiscoveryToRequirementList(data, {})).toMatchObject({ characters: "characters" in input ? [] : [{ name: "模型角色" }] }); restore();
    }
  });

  it("仅场景引擎采用JSON及明确非思考模式，保留实例receiver与失败返回", async () => {
    const system = target();
    const llm = { marker: "original", reason: vi.fn(function(this: { marker: string }, _p: unknown, opts: unknown) { return { success: false, error: this.marker, opts }; }),
      _extractJsonObject: vi.fn(function(this: { marker: string }) { return this.marker; }) };
    const scene = { llmEngine: llm }; system.requirementDiscoveryEngine.agents = { scene };
    const restore = installVendorRequirementBridge(system, metadata());
    const actual = await (scene.llmEngine as typeof llm).reason("actual prompt", { forceJson: false, maxTokens: 4000 });
    expect(actual).toMatchObject({ success: false, error: "original", opts: { forceJson: true, thinking: { type: "disabled" }, maxTokens: 4000 } });
    expect((scene.llmEngine as typeof llm)._extractJsonObject()).toBe("original");
    restore(); expect(scene.llmEngine).toBe(llm);
  });

  it("模板场景向原场景模型反馈错误，实体和动作来自模型新输出而不是purpose拼接", async () => {
    const system = target();
    const copied = discovery().sceneStructure; copied.opening.purpose = "开场目的 —— 观众第一眼看到什么？为什么会被吸引？";
    const llm = { reason: vi.fn().mockResolvedValueOnce({ success: true, content: JSON.stringify(copied) })
      .mockResolvedValueOnce({ success: true, content: JSON.stringify(discovery().sceneStructure) }) };
    const scene = { llmEngine: llm }; system.requirementDiscoveryEngine.agents = { scene };
    const restore = installVendorRequirementBridge(system, metadata());
    await expect((scene.llmEngine as typeof llm).reason("实际输入")).rejects.toThrow("purpose仍是模板问句");
    await expect((scene.llmEngine as typeof llm).reason("实际输入")).resolves.toMatchObject({ success: true });
    expect(llm.reason.mock.calls[1]![0]).toContain("上次实际字段错误");
    expect(llm.reason.mock.calls[1]![0]).toContain("明确角色档案");
    const data = await system.requirementDiscoveryEngine.discover({});
    const list = system._convertDiscoveryToRequirementList(data, {});
    const sheet = system._renderRequirementContract("", metadata(), list as Record<string, unknown>, data);
    const props = sheet.split("\n").find((line) => line.startsWith("- **道具**"))!;
    const actions = sheet.split("\n").find((line) => line.startsWith("- **动作**"))!;
    expect(props).toContain("酒店柜台"); expect(props).not.toContain("CEO指向");
    expect(actions).toContain("CEO指向摄像头"); expect(actions).not.toContain("展示调节位置");
    expect(sheet).toContain("原始意图禁用项不得进入画面或口播"); restore();
  });

  it.each(["props", "actions"])("缺少模型%s不把旧keyElements或purpose充成完整契约", async (field) => {
    const data = discovery(); delete (data.sceneStructure.opening as Record<string, unknown>)[field];
    const system = target(); system.requirementDiscoveryEngine.discover = vi.fn(async () => data);
    const convert = system._convertDiscoveryToRequirementList;
    const restore = installVendorRequirementBridge(system, metadata());
    await expect(system.requirementDiscoveryEngine.discover({})).rejects.toThrow(`.${field}必须`);
    expect(convert).not.toHaveBeenCalled(); restore();
  });

  it("非JSON模型返回与关闭中的模型调用不产生合格场景", async () => {
    const system = target(); let release!: (result: unknown) => void;
    const llm = { reason: vi.fn().mockResolvedValueOnce({ success: true, content: "bad json" })
      .mockImplementationOnce(() => new Promise((resolve) => { release = resolve; })) };
    const scene = { llmEngine: llm }; system.requirementDiscoveryEngine.agents = { scene };
    const restore = installVendorRequirementBridge(system, metadata());
    await expect((scene.llmEngine as typeof llm).reason("输入")).rejects.toThrow("不是JSON");
    const pending = (scene.llmEngine as typeof llm).reason("输入"); restore();
    release({ success: true, content: JSON.stringify(discovery().sceneStructure) });
    await expect(pending).rejects.toThrow("CLOSED");
  });

  it("关闭时仍在执行的转换不得返回已批准式生成物", async () => {
    let release!: () => void; const pending = new Promise<void>((r) => { release = r; });
    const system = target(vi.fn(async () => { await pending; return {}; }));
    const restore = installVendorRequirementBridge(system, metadata()); const run = system.requirementDiscoveryEngine.discover({});
    await Promise.resolve(); restore(); release(); await expect(run).rejects.toThrow("CLOSED");
  });
});
