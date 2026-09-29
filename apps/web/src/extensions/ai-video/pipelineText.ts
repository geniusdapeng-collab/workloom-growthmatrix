/**
 * 视频管线展示词典（客户可见中文边界）。
 *
 * 背景（2026-09-29 UI 门禁修复 MC-011）：视频链路内部的质量门（G5–G10）、交付判定
 * （visible/subtle/negligible）、调色与转场档位、字幕文件格式都是**机器码**，客户界面
 * 不得直接释放——门禁 `scripts/verify-ui-consumer.mjs` 的「客户端可见英文未登记中文边界」与
 * 「客户端不得展示 P/F/E/L 工程代号」两条规则会把它们判红。
 *
 * 口径：能翻成业务中文的一律翻（额度审批、暖调胶片、淡入淡出…）；未知值经 `dictText`
 * 与 `clientChineseText` 兜底，宁可不显示也不释放机器串。
 */
import { dictText } from "../../lib/display";
import { clientChineseText } from "@workloom/ui";

/** 视频质量门：内部代号 → 业务中文（与 docs/pipeline-stages-and-gates-2026-09-24.md 对账） */
export const VIDEO_GATE_TEXT: Readonly<Record<string, string>> = {
  G1: "选题确认",
  G2: "脚本确认",
  G3: "分镜确认",
  G4: "素材确认",
  G5: "定妆照确认",
  G6: "提示词确认",
  G7: "预生产确认",
  G8: "额度审批",
  G9: "发布审批",
  G10: "评论分流确认",
};

export function videoGateText(gate: string | null | undefined): string {
  return dictText(VIDEO_GATE_TEXT, gate);
}

/** 版本差异判定：visible / subtle / negligible → 中文 */
export const VIDEO_VERDICT_TEXT: Readonly<Record<string, string>> = {
  visible: "肉眼可辨",
  subtle: "细看可辨",
  negligible: "基本一致",
};

export function videoVerdictText(verdict: string | null | undefined): string {
  return dictText(VIDEO_VERDICT_TEXT, verdict);
}

/** 调色档位（bundles/ai-video/connectors/color-bridge/core.mjs#PROFILES 的键） */
export const COLOR_LOOK_TEXT: Readonly<Record<string, string>> = {
  natural: "自然原色",
  "clean-bright": "通透亮调",
  "warm-film": "暖调胶片",
  "cool-technical": "冷调科技",
  "teal-orange": "青橙对比",
  "moody-dark": "暗调氛围",
  "high-contrast-social": "高对比社媒",
  "vintage-fade": "复古褪色",
};

export function colorLookText(profile: string | null | undefined): string {
  return dictText(COLOR_LOOK_TEXT, profile);
}

/** 转场档位：hard / fade / xfade → 中文 */
export const TRANSITION_MODE_TEXT: Readonly<Record<string, string>> = {
  hard: "硬切",
  fade: "淡入淡出",
  xfade: "交叉淡化",
};

export function transitionModeText(mode: string | null | undefined): string {
  return dictText(TRANSITION_MODE_TEXT, mode);
}

/** 字幕文件格式 → 中文（扩展名是机器串，不上屏） */
export const SUBTITLE_FORMAT_TEXT: Readonly<Record<string, string>> = {
  srt: "通用字幕",
  ass: "样式字幕",
  ssa: "样式字幕",
  vtt: "网页字幕",
  txt: "纯文本",
};

export function subtitleFormatText(format: string | null | undefined): string {
  const key = String(format ?? "").trim().toLowerCase();
  return dictText(SUBTITLE_FORMAT_TEXT, key);
}

/** 分诊归因码（rev.<轴>.<子项>）→ 中文；未知码不直接释放 */
export const ATTRIBUTION_TEXT: Readonly<Record<string, string>> = {
  "rev.text.track": "字幕轨",
  "rev.audio.mix": "配乐混音",
  "rev.color.look": "调色观感",
  "rev.cover.layout": "封面版式",
  "rev.copy.tone": "文案口吻",
  "rev.edit.pacing": "剪辑节奏",
  "rev.shots.regenerate": "镜头重生成",
  "rev.assemble.order": "拼接顺序",
};

export function attributionText(code: string | null | undefined): string {
  const value = String(code ?? "").trim();
  if (!value) return "待人工指认";
  return ATTRIBUTION_TEXT[value] ?? clientChineseText(value, "待人工指认");
}

/** 配乐响度/增益口径统一到中文单位（机器值一律不进文案） */
export function loudnessText(lufs: number | null | undefined): string {
  return lufs ? `响度 ${lufs}` : "";
}

/** 媒资类型（video.media.list 的 kind 口径）→ 中文 */
export const MEDIA_KIND_TEXT: Readonly<Record<string, string>> = {
  clip: "镜头",
  final_cut: "成片",
  portrait: "定妆照",
  cover: "封面",
  shot_plate: "底板",
  upload_video: "上传视频",
  upload_image: "上传图",
  upload_audio: "上传音频",
  product_image: "商品图",
  reference_image: "参考图",
};

export function mediaKindText(kind: string | null | undefined): string {
  return dictText(MEDIA_KIND_TEXT, kind);
}

/** 发布预检级别 → 中文（apps/server/src/video/gen/publish.ts 的 level 口径） */
export const PUBLISH_LEVEL_TEXT: Readonly<Record<string, string>> = {
  auto: "自动放行",
  review: "人工复核",
  block: "阻断",
};

export function publishLevelText(level: string | null | undefined): string {
  return dictText(PUBLISH_LEVEL_TEXT, level);
}

/** 发布执行结果 → 中文 */
export const PUBLISH_KIND_TEXT: Readonly<Record<string, string>> = {
  executed: "已执行",
  blocked: "已阻断",
  pending_review: "待人工复核",
  skipped: "未执行",
};

export function publishKindText(kind: string | null | undefined): string {
  return dictText(PUBLISH_KIND_TEXT, kind);
}

/** 发布驱动 → 中文（dry-run 是本机试运行，不能冒充真实上传） */
export const PUBLISH_DRIVER_TEXT: Readonly<Record<string, string>> = {
  "dry-run": "本机试运行",
  desktop: "桌面端真实上传",
};

export function publishDriverText(driver: string | null | undefined): string {
  return dictText(PUBLISH_DRIVER_TEXT, driver);
}
