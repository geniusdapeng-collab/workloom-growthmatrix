/**
 * degrade-bridge · 降级出图执行器（B-81）
 *
 * 无工位/无桥时，为 `poster.degrade.render` 提供真实本地实现：
 * 把 HTML/CSS 海报写入工作目录（默认 .vm-work/degraded），产物标注「降级产出」；
 * 回执 synced=true 仅表示「文件已生成」，`manual_publish_required=true` 明示发布未发生。
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { planDegradedContent, type DegradeReason, type PosterSpec } from "@workloom/base/publish-rpa";

const connectorRequired = (name: string) => ({
  result: { state: "connector-required", tool: name },
  receipt: { synced: false },
});

export function createToolExecutorForScope() {
  return async (name: string, params: Record<string, unknown>) => {
    if (name !== "poster.degrade.render") return connectorRequired(name);
    const reason = (typeof params.reason === "string" ? params.reason : "no-bridge") as DegradeReason;
    const specs = Array.isArray(params.specs) ? params.specs as PosterSpec[] : [];
    let plan;
    try {
      plan = planDegradedContent({ reason, specs });
    } catch (error) {
      return {
        result: { state: "invalid-input", issues: [error instanceof Error ? error.message : String(error)] },
        receipt: { synced: false },
      };
    }
    const dir = (process.env.WORKLOOM_DEGRADE_DIR ?? join(process.cwd(), ".vm-work", "degraded")).trim();
    mkdirSync(dir, { recursive: true });
    const files = plan.assets.map((asset) => {
      const file = join(dir, `${asset.id}.html`);
      writeFileSync(file, asset.html, "utf8");
      return file;
    });
    return {
      result: {
        state: "degraded",
        mode: "degraded",
        reason,
        params: { files },
        labels: plan.labels,
        publish: plan.publish,
        manual_publish_required: true,
      },
      receipt: { synced: true, snapshot_uri: `file://${files[0] ?? dir}`, verified_at: new Date().toISOString() },
    };
  };
}
