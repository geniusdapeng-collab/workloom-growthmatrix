/**
 * 获客增长行业规划器（geo-growthmatrix · QuestPlanner seam 的行业实现）。
 *
 * 背景（2026-09-29 审计实证）：`runQuestForThread` 对**所有行业**都注入酒店规划器
 * （`acquisition-quest-planner`），于是增长工作区的目标会被翻译成酒店语义的步骤，
 * 「增长目标 → 增长工具」这条路根本走不到；视觉目标的直译也只是搭了酒店规划器里的顺风车。
 *
 * 本规划器的职责（与酒店规划器同一纪律：只做确定性直译，不猜数据）：
 *  1. **平台化视觉物料**：目标里点明平台（小红书/抖音/视频号/朋友圈/公众号/B站/快手/微博等）时，
 *     按 `cover-platforms.ts` 的**唯一规格源**取画幅与画布，产出「文字预渲染 → 合成 → 校验」三段；
 *     配方形状与已被真机验证的 CLI 计划（`scripts/visual-quest-runner.mts#coverPlan`）逐字段同构。
 *  2. **无工位输出目录时的降级**：工位输出目录（`WORKLOOM_VISUAL_BRIDGE_OUT_DIR`）未配置时，
 *     合成链路缺少可写路径，改走已被真机验证的单步 `visualwrite.generate`，并把平台与画幅写进提示词。
 *  3. **其它目标**：交回基座确定性规划（`planQuest`）——行业化不得吞掉通用能力，也不得凭空造步骤。
 */
import { planQuest, type AssembledPreset, type QuestPlanner, type QuestStep } from "@workloom/runtime";
import { COVER_PLATFORMS, getCoverSpec } from "@hyperreality/video-studio";

/** 视觉物料意图（平台化素材的入口判据；宁窄勿宽，避免把文字任务误判成出图） */
export const GROWTH_VISUAL_PATTERN =
  /(海报|封面|配图|主图|长图|九宫格|朋友圈|促销图|活动图|主视觉|KV|答案卡|素材图|做一?[张幅].{0,12}图|生成.{0,12}图|出一?[张幅].{0,12}图)/i;

/** 平台关键词 → 规格注册表键（注册表的别名表会再兜一层归一化） */
const PLATFORM_KEYWORDS: Array<[RegExp, string]> = [
  [/小红书|红书|redbook|xhs/i, "xiaohongshu"],
  [/抖音|douyin|tiktok(?!\s*海外)/i, "douyin"],
  [/视频号|微信视频|channels/i, "wechat-channels"],
  [/快手|kuaishou/i, "kuaishou"],
  [/B站|bilibili|哔哩/i, "bilibili"],
  [/微博|weibo/i, "weibo"],
  [/公众号|订阅号|服务号|微信图文/i, "wechat-official"],
  [/朋友圈/i, "wechat-moments"],
];

export interface GrowthPlatformSpec {
  kind: "spec";
  /** 规格注册表内的平台键 */
  key: string;
  /** 目标里出现的原始写法（留痕用） */
  matched: string;
  width: number;
  height: number;
  ratio: string;
  headlineMaxChars: number;
}

export interface GrowthPlatformUnsupported {
  kind: "unsupported";
  /** 目标里点名的、但本仓规格表未收录的平台 */
  matched: string;
}

export type GrowthPlatformResolution = GrowthPlatformSpec | GrowthPlatformUnsupported;

/**
 * 从目标里解析平台；三种结果：
 *  - `{kind:"spec"}`：点名平台且本仓规格表**有**该平台（用注册表数值，绝不回退默认平台）；
 *  - `{kind:"unsupported"}`：点名了平台但规格表未收录（微博/公众号/朋友圈等）——
 *    只如实转述，不套用其它平台的画幅（套用等于静默给错规格）；
 *  - `undefined`：目标里没有点名平台（不做"猜平台"）。
 */
export function resolveGrowthPlatform(goal: string): GrowthPlatformResolution | undefined {
  for (const [pattern, key] of PLATFORM_KEYWORDS) {
    const hit = pattern.exec(goal);
    if (!hit) continue;
    if (!COVER_PLATFORMS[key]) return { kind: "unsupported", matched: hit[0]! };
    const spec = getCoverSpec(key);
    return {
      kind: "spec",
      key: spec.id,
      matched: hit[0]!,
      width: spec.canvas.width,
      height: spec.canvas.height,
      ratio: spec.ratio,
      headlineMaxChars: spec.headlineMaxChars,
    };
  }
  return undefined;
}

/** 物料形态（决定版式参数；默认封面） */
export type GrowthMaterialKind = "cover" | "poster" | "moments" | "promo" | "answer-card";

export function detectMaterialKind(goal: string): GrowthMaterialKind {
  if (/答案卡|参数对比|信源配图/i.test(goal)) return "answer-card";
  if (/九宫格|朋友圈/i.test(goal)) return "moments";
  if (/促销|优惠|折扣|秒杀|活动图/i.test(goal)) return "promo";
  if (/海报|主视觉|KV|主图/i.test(goal)) return "poster";
  return "cover";
}

/**
 * 标题抽取：只认显式标注（「」/“”/《》/标题：X/主题：X）。
 * 抽不到就不给标题——让合成只出底版，避免把整句目标当成标题印在图上。
 */
export function extractTitle(goal: string): string | undefined {
  const quoted = /[「“"《]([^」”"》]{1,40})[」”"》]/.exec(goal)?.[1];
  if (quoted && quoted.trim().length > 0) return quoted.trim();
  const labelled = /(?:标题|主题|文案)\s*[:：]\s*([^\s，。;；]{1,40})/.exec(goal)?.[1];
  if (labelled && labelled.trim().length > 0) return labelled.trim();
  return undefined;
}

/** 标题按平台上限截断（中文按视觉字符近似：这里按码点截断，宁可少一字不越界） */
export function clampTitle(title: string, maxChars: number): string {
  const chars = [...title];
  return chars.length <= maxChars ? title : chars.slice(0, maxChars).join("");
}

/** 工位输出目录（与视觉工位部署口径一致；未配置 → 走 generate 降级路径） */
export function visualOutDirFromEnv(): string | undefined {
  const dir = process.env.WORKLOOM_VISUAL_BRIDGE_OUT_DIR;
  return dir && dir.trim().length > 0 ? dir.trim() : undefined;
}

/**
 * 平台化合成计划：文字预渲染 → 合成 → 尺寸校验。
 * 配方字段与 `scripts/visual-quest-runner.mts#coverPlan` 同构（该计划已在真机跑通），
 * 差异只有：画布来自规格注册表、标题来自目标、导出行带平台与尺寸。
 */
export function growthCoverPlan(input: {
  platform: GrowthPlatformSpec;
  kind: GrowthMaterialKind;
  title?: string;
  outDir: string;
}): QuestStep[] {
  const { platform, kind, outDir } = input;
  const title = input.title ? clampTitle(input.title, platform.headlineMaxChars) : undefined;
  const titlePng = `${outDir}/title.png`;
  const coverPng = `${outDir}/${platform.key}-${kind}.png`;
  const steps: QuestStep[] = [];

  if (title) {
    steps.push({
      stepId: `s${steps.length + 1}`,
      action: "visualwrite.text",
      objectType: "visual_asset",
      tool: "visualwrite.text",
      params: {
        output: titlePng,
        spec: {
          text: title,
          font: "PingFang SC",
          size: Math.round(platform.width * 0.088),
          weight: "bold",
          color: "#FFFFFF",
          align: "center",
          width: Math.round(platform.width * 0.84),
        },
      },
      label: "预渲染标题文字",
    });
  }

  const recipe = {
    recipe_version: 1,
    name: `${platform.key}-${kind}`,
    canvas: { width: platform.width, height: platform.height, resolution: 72 },
    layers: [
      { type: "solid", name: "bg", color: "#0B1220", x: 0, y: 0, width: platform.width, height: platform.height },
      { type: "solid", name: "accent", color: "#FF4D2E", x: Math.round(platform.width * 0.083), y: Math.round(platform.height * 0.104), width: Math.round(platform.width * 0.204), height: 14 },
      ...(title
        ? [{ type: "image", name: "title", source: titlePng, x: Math.round(platform.width * 0.083), y: Math.round(platform.height * 0.146), width: Math.round(platform.width * 0.834), height: Math.round(platform.height * 0.16), opacity: 1 }]
        : []),
      {
        type: "text",
        name: "sub",
        text: `${platform.matched} · ${platform.ratio} · ${kind}`,
        font: "PingFang SC",
        size: 44,
        weight: "regular",
        color: "#9FB3C8",
        align: "left",
        x: Math.round(platform.width * 0.083),
        y: Math.round(platform.height * 0.361),
        width: Math.round(platform.width * 0.834),
      },
    ],
    exports: [{ format: "png", path: coverPng }],
  };

  steps.push({
    stepId: `s${steps.length + 1}`,
    action: "visualwrite.compose",
    objectType: "design_recipe",
    tool: "visualwrite.compose",
    params: {
      recipe_status: "approved",
      has_portrait: false,
      has_third_party_asset: false,
      recipe,
      out_dir: outDir,
    },
    context: { daily_rendered: 0 },
    label: "合成平台化素材并导出",
  });

  steps.push({
    stepId: `s${steps.length + 1}`,
    action: "visualread.verify",
    objectType: "visual_asset",
    tool: "visualread.verify",
    params: { path: coverPng, width: platform.width, height: platform.height },
    label: "校验成品尺寸与哈希",
  });

  return steps;
}

/** 无工位输出目录时的降级提示词：把平台与画幅写进 prompt，由 AI 生图产出主视觉 */
export function growthGeneratePrompt(goal: string, platform?: GrowthPlatformResolution): string {
  const platformLine = !platform
    ? "目标平台：未指定（默认按竖版 3:4 构图）"
    : platform.kind === "spec"
      ? `目标平台：${platform.matched}（${platform.ratio}，${platform.width}×${platform.height}；标题不超过 ${platform.headlineMaxChars} 字）`
      : `目标平台：${platform.matched}（本仓规格表未收录该平台：按平台常规画幅产出，并在交付物中标注实际尺寸，禁止套用其它平台规格）`;
  return [
    platformLine,
    "要求：主体居中、下方预留平台文案区、画面内不出现水印与第三方品牌标识、不虚构产品参数。",
    `原始需求：${goal.slice(0, 1000)}`,
  ].join("\n");
}

/** 增长行业规划器入口 */
export function geoGrowthmatrixQuestPlanner(goal: string): QuestPlanner {
  return (_goal, preset: AssembledPreset) => {
    const tools = new Set(preset.tools.map((tool) => tool.name));
    if (!GROWTH_VISUAL_PATTERN.test(goal)) return planQuest(goal, preset);

    const platform = resolveGrowthPlatform(goal);
    const kind = detectMaterialKind(goal);
    const title = extractTitle(goal);
    const outDir = visualOutDirFromEnv();

    // 平台 + 工位输出目录都在：走「文字 → 合成 → 校验」平台化链路（配方与真机 CLI 计划同构）
    if (platform?.kind === "spec" && outDir && tools.has("visualwrite.compose") && tools.has("visualread.verify")) {
      return growthCoverPlan({ platform, kind, ...(title ? { title } : {}), outDir });
    }

    // 降级：单步 AI 生图（真机已验证路径），平台与画幅写进提示词
    if (tools.has("visualwrite.generate")) {
      return [
        {
          stepId: "s1",
          action: "visualwrite.generate",
          objectType: "visual_asset",
          tool: "visualwrite.generate",
          params: { prompt: growthGeneratePrompt(goal, platform) },
          label: "按平台规格生成主视觉（AI 生图降级路径）",
        },
      ];
    }

    // 视觉目标但岗位没有可用的视觉工具：交回基座确定性规划（不伪造步骤）
    return planQuest(goal, preset);
  };
}
