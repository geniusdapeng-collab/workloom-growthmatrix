/**
 * publish-rpa/degrade —— 内容生产降级路径（B-81）
 *
 * 场景：视觉工位/桥不可用（无工位、无桥、渲染失败）时，不静默失败也不伪造出图：
 *  - 用确定性 HTML/CSS 生成海报底稿（浏览器截图即为成图，人工确认后使用）；
 *  - 产物一律标注「降级产出」（HTML 注释 + data 属性 + 可见角标），事件与 UI 同口径；
 *  - 发布一律挂起为人工动作（manual_hold），不得进入自动发布队列。
 */

export type DegradeReason = "no-workstation" | "no-bridge" | "render-failed" | "budget-exceeded";

export interface PosterSpec {
  id: string;
  title: string;
  subtitle?: string;
  brand?: string;
  width: number;
  height: number;
  theme?: "light" | "dark";
  accentColor?: string;
}

export interface DegradedAsset {
  id: string;
  kind: "html_poster";
  /** 完整 HTML（保存为 .html 后由浏览器截图/打印成图） */
  html: string;
  label: "降级产出";
  mode: "degraded";
  manualPublishRequired: true;
}

export interface DegradedPlan {
  mode: "degraded";
  reason: DegradeReason;
  assets: DegradedAsset[];
  publish: { status: "manual_hold"; note: string };
  labels: string[];
}

const esc = (value: string): string => value
  .replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;");

/** 确定性海报 HTML：同输入同输出（可黄金文件比对），内置「降级产出」标注与人工发布提示。 */
export function buildDegradedPoster(spec: PosterSpec): DegradedAsset {
  const theme = spec.theme ?? "light";
  const accent = spec.accentColor ?? (theme === "dark" ? "#f59e0b" : "#0f766e");
  const bg = theme === "dark" ? "#0b1220" : "#f8fafc";
  const fg = theme === "dark" ? "#e2e8f0" : "#0f172a";
  const html = `<!doctype html>
<!-- workloom:mode=degraded manual_publish=required -->
<html lang="zh-CN" data-workloom-mode="degraded" data-manual-publish="required">
<head>
<meta charset="utf-8">
<meta name="generator" content="workloom-degrade-bridge">
<title>${esc(spec.title)} · 降级产出</title>
<style>
  :root { --accent: ${accent}; --bg: ${bg}; --fg: ${fg}; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { width: ${spec.width}px; height: ${spec.height}px; background: var(--bg); color: var(--fg);
         font-family: "PingFang SC", "Microsoft YaHei", system-ui, sans-serif; position: relative; overflow: hidden; }
  .frame { position: absolute; inset: 48px; border: 2px solid color-mix(in srgb, var(--accent) 55%, transparent);
           border-radius: 24px; display: flex; flex-direction: column; justify-content: center; gap: 28px; padding: 64px; }
  .brand { font-size: 26px; letter-spacing: 6px; text-transform: uppercase; color: var(--accent); }
  h1 { font-size: ${Math.round(spec.height / 12)}px; line-height: 1.18; font-weight: 800; }
  .subtitle { font-size: ${Math.round(spec.height / 26)}px; line-height: 1.5; opacity: .82; max-width: 80%; }
  .rule { width: 160px; height: 8px; background: var(--accent); border-radius: 99px; }
  .badge { position: absolute; top: 24px; right: 24px; background: var(--accent); color: #fff;
           padding: 10px 22px; border-radius: 999px; font-size: 20px; font-weight: 700; letter-spacing: 2px; }
  .hold { position: absolute; bottom: 24px; left: 24px; font-size: 18px; opacity: .75; }
</style>
</head>
<body>
  <div class="badge">降级产出 · 待人工确认</div>
  <div class="frame">
    <div class="brand">${esc(spec.brand ?? "WorkLoom")}</div>
    <h1>${esc(spec.title)}</h1>
    <div class="rule"></div>
    ${spec.subtitle ? `<div class="subtitle">${esc(spec.subtitle)}</div>` : ""}
  </div>
  <div class="hold">工位/桥不可用时的降级底稿：截图后人工确认再发布</div>
</body>
</html>
`;
  return { id: spec.id, kind: "html_poster", html, label: "降级产出", mode: "degraded", manualPublishRequired: true };
}

/** 降级计划：批量海报 + 发布挂起说明；调用方负责落盘与事件留痕（mode=degraded）。 */
export function planDegradedContent(input: { reason: DegradeReason; specs: PosterSpec[] }): DegradedPlan {
  if (input.specs.length === 0) throw new Error("降级计划至少需要 1 张海报");
  return {
    mode: "degraded",
    reason: input.reason,
    assets: input.specs.map((spec) => buildDegradedPoster(spec)),
    publish: {
      status: "manual_hold",
      note: `降级原因 ${input.reason}：产物标注「降级产出」，自动发布挂起，需人工确认后手动发布`,
    },
    labels: ["降级产出", "manual_hold", `degrade:${input.reason}`],
  };
}
