import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it, vi } from "vitest";
import { WorkloomLLMEngine } from "./llm-adapter.js";
it("显式端点推理配置送入HTTP，单次选项优先；缺省不新增扩展，非法值拒绝", async () => {
  const bodies: any[] = [];
  vi.stubGlobal("fetch", vi.fn(async (_url: unknown, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body))); return new Response(JSON.stringify({ choices: [{ message: { content: "{}" } }] }));
  }));
  try {
    const env = { LLM_BASE_URL: "https://test.invalid", LLM_API_KEY: "test-only", LLM_MODEL: "test" };
    await WorkloomLLMEngine.fromEnv(env)!.reason("json");
    const configured = WorkloomLLMEngine.fromEnv({ ...env, LLM_THINKING_TYPE: "disabled" })!;
    await configured.reason("json"); await configured.reason("json", { thinking: { type: "enabled" } });
    expect(bodies[0]).not.toHaveProperty("thinking"); expect(bodies[1].thinking).toEqual({ type: "disabled" });
    expect(bodies[2].thinking).toEqual({ type: "enabled" });
    expect(() => WorkloomLLMEngine.fromEnv({ ...env, LLM_THINKING_TYPE: "typo" })).toThrow("LLM_THINKING_TYPE_INVALID");
  } finally { vi.unstubAllGlobals(); }
});
it("非法JSON失败保存完整原始响应和计量，不修造事实或自动重试", async () => {
  const content = '{"claims":["unterminated"';
  const request = vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content } }], usage: { prompt_tokens: 12, completion_tokens: 3 } })));
  vi.stubGlobal("fetch", request);
  try {
    const result = await new WorkloomLLMEngine({ baseUrl: "https://test.invalid", apiKey: "test-only", model: "test" }).reason("json", { forceJson: true });
    expect(result).toMatchObject({ success: false, content, usage: { promptTokens: 12, completionTokens: 3 } });
    expect(result.error).toContain("JSON"); expect(request).toHaveBeenCalledTimes(1);
  } finally { vi.unstubAllGlobals(); }
});
it("真实vendor三参reasonStructured把第三参模型配置送入实际HTTP体，schema不冒充options", () => {
  const code = `import{createRequire}from'node:module';
    import{WorkloomLLMEngine,installVendorEngineBridge}from'./packages/video-studio/src/llm-adapter.ts';
    const require=createRequire(import.meta.url);const{LLMEngine}=require('./vendor/supermickey/systems/llm-reasoning-engine.js');
    let body;globalThis.fetch=async(_url,init)=>{body=JSON.parse(init.body);return new Response(JSON.stringify({choices:[{message:{content:'{"real":true}'}}]}));};
    const engine=new WorkloomLLMEngine({baseUrl:'https://test.invalid',apiKey:'test-only',model:'actual-model'});
    const original=LLMEngine.prototype.reasonStructured;const restore=installVendorEngineBridge(engine);
    const result=await new LLMEngine().reasonStructured('真实三参调用',{required:['real']},{maxTokens:512,temperature:.1,thinking:{type:'disabled'}});
    restore();console.log(JSON.stringify({body,result,restored:original===LLMEngine.prototype.reasonStructured}));`;
  const out = execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", code], {
    cwd: fileURLToPath(new URL("../../../", import.meta.url)), encoding: "utf8", timeout: 30_000,
  });
  const result = JSON.parse(out.trim().split("\n").at(-1)!);
  expect(result.body).toMatchObject({ model: "actual-model", max_tokens: 512, temperature: .1, thinking: { type: "disabled" }, response_format: { type: "json_object" } });
  expect(result.body.messages[1].content).toContain('"real"');
  expect(result.result).toMatchObject({ success: true, data: { real: true } }); expect(result.restored).toBe(true);
});
it("真实镜头ID与嵌套字段模板送入HTTP，模型返回值保持原样且无补造", async () => {
  const data = { shots: [{ shotId: "S1", fields: { scene: "真实模型场景", dialogue: "真实模型台词" } }] };
  let body: Record<string, any> = {};
  vi.stubGlobal("fetch", vi.fn(async (_url: unknown, init: RequestInit) => {
    body = JSON.parse(String(init.body));
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(data) } }] }));
  }));
  try {
    const result = await new WorkloomLLMEngine({ baseUrl: "https://test.invalid", apiKey: "test-only", model: "test" }).reasonStructured(
      '旧系统示例 {"shots":[{"shotId":"SC01","fields":{}}]}',
      { required: ["shots"], requiredArrays: ["shots"], rejectEmptyArray: true, shots: [{ shotId: "S1", fields: { scene: "", dialogue: "" } }] },
    );
    expect(body.messages[1].content).toContain('"shotId": "S1"');
    expect(body.messages[1].content).toContain('"dialogue": ""');
    expect(body.temperature).toBe(.6);
    expect(result).toMatchObject({ success: true, data });
  } finally { vi.unstubAllGlobals(); }
});
it.each([{}, { shots: [] }, { shots: "S1" }])("结构错误保留真实响应和计量并拒绝成功，不自动重试 %j", async (data) => {
  const content = JSON.stringify(data);
  const request = vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content } }], usage: { prompt_tokens: 5, completion_tokens: 2 } })));
  vi.stubGlobal("fetch", request);
  try {
    const result = await new WorkloomLLMEngine({ baseUrl: "https://test.invalid", apiKey: "test-only", model: "test" }).reasonStructured(
      "输出 json", { required: ["shots"], requiredArrays: ["shots"], rejectEmptyArray: true },
    );
    expect(result).toMatchObject({ success: false, content, data, usage: { promptTokens: 5, completionTokens: 2 } });
    expect(result.error).toContain("shots"); expect(request).toHaveBeenCalledTimes(1);
  } finally { vi.unstubAllGlobals(); }
});
it.each([{ shots: [{ shotId: "SC01", fields: { scene: "有内容但编号是旧示例" } }] },
  { shots: [{ shotId: "S1", fields: {} }] }])("单镜编号漂移/字段全空不能交给消费者当成功 %j", async data => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(data) } }] }))));
  try {
    const result = await new WorkloomLLMEngine({ baseUrl: "https://test.invalid", apiKey: "test-only", model: "test" }).reasonStructured(
      "输出json", { required: ["shots"], shots: [{ shotId: "S1", fields: { scene: "" } }] },
    );
    expect(result.success).toBe(false); expect(result.data).toEqual(data); expect(result.error).toContain("shots[]");
  } finally { vi.unstubAllGlobals(); }
});
