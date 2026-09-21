#!/usr/bin/env node
/**
 * connectors:check · 真实连接器就绪检查（G7）
 * 未配置 → 打印 unconfigured（不阻断，提示缺哪些 env）；凭证齐备 → 打印 ready。
 */
import { connectorReadiness } from "@workloom/base/connectors";
import { parseToolExecutorRoutes } from "@workloom/base/publish-rpa";
import { otaReadiness } from "@workloom/base/ota-publisher";
import { existsSync } from "node:fs";

const rows = connectorReadiness();
console.log("真实连接器就绪状态（fail-closed：未配置不回退 mock）：");
for (const r of rows) {
  console.log(`${r.state === "ready" ? "✓" : "○"} ${r.id.padEnd(16)} ${r.name} —— ${r.detail}`);
}
console.log("\n接入步骤见 docs/connectors-mock-exit.md；凭证只放环境变量/秘密存储，不进文件。");

/* B-24：工具执行器路由就绪检查（WORKLOOM_TOOL_EXECUTOR_MODULES；缺路径即 fail-closed 暴露） */
const routes = parseToolExecutorRoutes();
console.log("\n工具执行器路由（B-21：逗号列表 / `前缀=绝对路径`）：");
if (routes.length === 0) {
  console.log("○ 未配置 WORKLOOM_TOOL_EXECUTOR_MODULES——真实连接器不可用（fail-closed，不伪造回执）");
} else {
  for (const route of routes) {
    const ok = existsSync(route.modulePath);
    console.log(`${ok ? "✓" : "✗"} ${(route.prefix ?? "(兜底)").padEnd(12)} → ${route.modulePath}${ok ? "" : "（路径不存在，该路由将按未核实处理）"}`);
  }
}
const bus = (process.env.EVENT_BUS ?? "memory").trim() || "memory";
console.log(`\n事件总线：${bus}${bus === "memory" ? "（内嵌）" : "（外部服务，确认地址可达）"}`);

/* B-19：OTA 素材上传通道就绪（携程/美团/飞猪；未配置不回退 mock） */
console.log("\nOTA 素材上传通道（B-19）：");
for (const row of otaReadiness()) {
  console.log(`${row.state === "ready" ? "✓" : "○"} ${row.channel.padEnd(10)} ${row.label} —— ${row.detail}`);
}

/* B-20/B-22：工位执行器桥就绪（发布/信源/私域；未配置 → connector-required） */
const BRIDGES: Array<[string, string, string]> = [
  ["publish-bridge", "WORKLOOM_PUBLISH_BRIDGE_URL", "WORKLOOM_PUBLISH_BRIDGE_TOKEN"],
  ["source-bridge", "WORKLOOM_SOURCE_BRIDGE_URL", "WORKLOOM_SOURCE_BRIDGE_TOKEN"],
  ["private-domain-bridge", "WORKLOOM_PRIVATE_DOMAIN_BRIDGE_URL", "WORKLOOM_PRIVATE_DOMAIN_BRIDGE_TOKEN"],
];
console.log("\n工位执行器桥（B-20/B-22）：");
for (const [name, urlKey, tokenKey] of BRIDGES) {
  const missing = [urlKey, tokenKey].filter((key) => !process.env[key]?.trim());
  console.log(missing.length === 0
    ? `✓ ${name.padEnd(22)} 已配置（桥侧承载登录态/企微密钥）`
    : `○ ${name.padEnd(22)} 缺少：${missing.join("、")}（fail-closed → connector-required）`);
}
