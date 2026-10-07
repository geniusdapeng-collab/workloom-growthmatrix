# 标题字幕 bridge 连接器（ai-video）

把 `subtitleread.* / subtitlewrite.*` 工具接到本地字幕工位（ffmpeg + libass + **随包字体目录**），
供「字幕师」数字员工在后期环节做**选型 → 请求配方 → 烧录（字幕/标题/弹幕/贴纸/卡拉OK/双语）→ 处理回执**。

## 部署形态

```
WorkLoom（大脑：岗位/技能/围栏/事件账本）          Mac 字幕工位（手，独立内网）
  runtime ToolExecutor ──HTTP/Bearer──▶  subtitle-bridge (127.0.0.1:9776)
                                            ├─ ffmpeg / ffprobe（kit 受控安装）
                                            ├─ libass（ass/subtitles 滤镜）
                                            ├─ 工位字体目录（kit/install-fonts.sh 按 sha256 安装）
                                            ├─ 素材区（原片只读）
                                            ├─ 产物区（新文件 + 版本链 + 源字节保护）
                                            └─ 回执：sha256 / 输出规格 / 时间轴回读 / 字体解析
```

**大文件不出工位**：服务器只传路径与参数，工位本地读写素材，默认只回处理元数据与哈希。

## 接线

```ts
import { createSubtitleBridgeExecutor } from "./bundles/ai-video/connectors/subtitle-bridge/executor.ts";

const toolExecutor = createSubtitleBridgeExecutor({
  baseUrl: process.env.WORKLOOM_SUBTITLE_BRIDGE_URL!,      // 支持逗号分隔多端点
  token: process.env.WORKLOOM_SUBTITLE_BRIDGE_TOKEN!,
  tenantId: "ws-video",
  timeoutMs: 900_000,
});
// 注入宿主：packages/runtime/src/loop.ts 的 input.toolExecutor（部署适配器负责）
// 行业侧适配器：server-adapter.mts（读 WORKLOOM_SUBTITLE_BRIDGE_* 环境变量）
```

与调色/配乐工位同款：基座 seam 提案仍处「暂缓」（`proposals/workloom-im/0001-deployment-tool-executor-seam.md`），
因此当前生产入口是**行业侧脚本注入**（见 `runtime-smoke.mts` 与部署层 `server-adapter.mts`），不改任何基座文件。

## 工具面（14 个）

| 工具 | 类型 | 用途 |
|---|---|---|
| `subtitleread.health` | 读 | 工位与引擎健康（ffmpeg/ffprobe、libass、字体在位、编码器、配方库） |
| `subtitleread.probe` | 读 | 素材规格：分辨率/时长/帧率/音轨/编码（决定字号基准） |
| `subtitleread.analyze` | 读 | 画面可读性诊断：抽帧量化文字带**亮度**与**细节密度**、遮挡区命中、证据帧 |
| `subtitleread.fonts` | 读 | 字体档案检索与打分（场景×语言硬过滤 + 五维加权 + 账号锁定字体） |
| `subtitleread.recipes` | 读 | 平台版式与题材配方检索（安全区/字号倍率/描边/底衬/禁忌） |
| `subtitlewrite.plan` | 写 | **出方案包**：ASS 样式与事件 + 选型理由（不改成片）；诊断仅显式 `analyze=true` |
| `subtitlewrite.burn` | 写 | 字幕烧录出片（SRT→ASS→libass，带真实处理回执；`srt_path_en` 即双语） |
| `subtitlewrite.title` | 写 | 片头标题/花字渲染出片（请求平台版式 + 描边/底衬 + 输出规格） |
| `subtitlewrite.danmaku` | 写 | 弹幕轨：滚动（顶部 1/4 轨道）+ 顶部/底部固定；按请求完整渲染条目，记录密度事实 |
| `subtitlewrite.sticker` | 写 | 贴纸/花字：200ms 弹入；按请求有效时间和位置处理 |
| `subtitlewrite.karaoke` | 写 | 卡拉OK：`\kf` 逐字扫过；逐字时间轴显式或均分（如实标注）；可双语 |
| `subtitlewrite.sidecar` | 写 | 导出 SRT/ASS/VTT 与清单，源母版只读 |
| `subtitlewrite.softmux` | 写 | 按 copy 参数添加可开关字幕轨，记录实际轨道与源字节 |
| `subtitlewrite.best` | 写 | 兼容入口：请求配方确定字体，渲染一次；没有字幕需求时不产出文件 |

## 字号与版式怎么定（可解释、可复算）

```
字号 = 短边 × 场景基准比(标题 0.11 / 字幕 0.048 / 弹幕 0.04 / 贴纸 0.07)
       × 粗细修正(1 + (2.5 − 粗细) × 0.04) × 平台字号倍率
描边 = 字号 × 0.06（花底 0.08）；安全边距 = 短边 × 0.05
```

平台版式（画幅 / 字幕位置 / 字号倍率 / 封面风格）与 **UI 遮挡区矩形**见
`library/font-catalog/font_db.json#layout_policy`；抖音/快手字幕默认上抬至底部 18%（避开点赞栏与文案区）。

## 默认处理政策（2026-10-07.2）

已经成功渲染且能取得真实字节的原片直接进入正式字幕处理。默认不抽样原片、不计算亮度/边缘/对比度/可现度、不进行候选画面评分，也不因字号、行宽、平台遮挡区或密度建议删除成功产物。`qualityReviewed=false`、`presence=null`、空 `evidence` 是如实记录，不能当作通过了品质复评。

| 能力 | 实际行为 | 处理事实 |
|---|---|---|
| 弹幕 | 滚动/顶部/底部按请求条目完整渲染，透明度默认 0.85 | ASS 事件数、字体解析、输出规格、源字节 |
| 贴纸·花字 | 200ms 弹入；采用请求的有效时间、位置与预设 | ASS 事件数、字体解析、输出规格、源字节 |
| 卡拉OK | 显式逐字时间或按字数均分；均分标注为非真实发音对齐 | 逐字时间合计、标签、字体解析、输出规格 |
| 双语字幕 | 第二语言单独样式，采用所给时间轴 | ASS 回读、字体解析、输出规格 |
| 旁挂 | 输出 SRT/ASS/VTT 与清单，默认 `analyze=false` | 文件哈希、时间轴回读、源母版哈希保持 |
| 软轨 | 视频/音频执行 `copy`，添加可开关字幕轨 | 实际命令参数、轨道元数据、视频时长、源母版哈希保持 |

默认校验保留缺失/损坏素材、原片覆盖、字体缺失或实际解析失败、ASS 时间轴回读失败、真实 FFmpeg 处理失败、输出缺失及实际规格变化等错误。旧 `skip_verify` / `verify=false` 不会关闭这些处理事实校验。

显式 `subtitleread.analyze` 仍可做只读诊断；`plan` / `sidecar` 的 `analyze=true` 返回建议，建议不成为处理或发布的品质闸。`best` 兼容旧参数，但不使用 `min_score` 或候选数进行原片评分；没有内容或请求说明已有硬字幕时返回 `no_change_needed`。

## 字体：29 款随包分发（无需工位安装）

字体文件在 `library/fonts/{cn,en}/`（约 123MB，随 Bundle 分发），**三层 sha256 校验**：
字体档案（`library/font-catalog/font_db.json`）↔ 随包文件 ↔ bundle 完整性索引（发布门禁）；
`kit/fonts-pin.json` 记录上游项目与摘要，供升级比对。

```bash
bash kit/install-fonts.sh --check                     # 校验随包字体 + 外置覆盖目录
bash kit/install-fonts.sh --install                   # 随包字体 → 工位外置目录（可选）
bash kit/install-fonts.sh --from-dir <客户字体目录>     # 客户自备商用字体（逐文件 sha256）
bash kit/install-fonts.sh --download                  # 升级取新版本（只放行已核验条目）
bash kit/selftest.sh [输出目录]                        # 端到端自检
```

`WORKLOOM_SUBTITLE_FONTS_DIR` 指向外置目录时可覆盖随包字体（同名文件仍按 sha256 校验）。

## 真机演示与产物导出（不依赖数据库）

```bash
node bundles/ai-video/connectors/subtitle-bridge/demo-artifacts.mjs --out /tmp/subtitle-demo --platform 抖音/快手
```

产出 `source.mp4`（自造竖屏素材：深/浅/花三种底 + 环境声）、`subtitle.srt`、`brief.json`、
`subtitle-plan.json` / `.ass`、`burned.mp4`、`best.mp4`、显式诊断的 `analyze-*.png`、`report.json`、`README.md`。

## 运行时端到端（真实 PG + 真实围栏 + 真实 bridge + 真实 ffmpeg + 真实字体）

```bash
set -a; source .env; set +a
node_modules/.bin/tsx bundles/ai-video/connectors/subtitle-bridge/runtime-smoke.mts
```

| 场景 | 期望 |
|---|---|
| clean：常规字幕+标题渲染 | `completed`，产出成片，回执 sha256 与磁盘文件一致（G-SUB0 auto 直通） |
| review：品牌视觉锤变更（许可未核验） | `pending_review` + 审批号（G-SUB1 review） |
| blocked：覆盖原片 | `paused`，`blockedBy=覆盖原片禁止`（G-SUB2 block） |
| blocked-license：非白名单字体许可 | `paused`，`blockedBy=字体许可不合规`（G-SUB5 block） |
| outage：工位不可达 | `failed` + 步骤标未核实（软失败不伪造回执） |

## 安全

- token 只从受控秘密存储或工位本机文件读取，不进仓库、不进日志；
- bridge 默认只监听 `127.0.0.1`，跨机置于内网反代 + mTLS 之后；
- **路径监狱**：`WORKLOOM_SUBTITLE_ALLOWED_ROOTS`（冒号分隔）之外一律拒绝，软链逃逸同样拦；
- **原片只读**：输出路径等于输入路径直接拒绝（`overwrite_source_forbidden`），并由围栏 G-SUB2 一票否决；
- 客户素材与成品只落工位/租户素材区，不上行蜂群；
- 无回执 = 未核实：executor 不会为缺失的 receipt 伪造 `synced`。

## 错误码

可重试：`network_error` / `timeout` / `ffmpeg_failed` / `decode_failed` / `engine_failed` / `bad_response`

不可重试：`path_not_allowed` / `tenant_mismatch` / `overwrite_source_forbidden` / `disk_quota_exceeded` /
`ffmpeg_not_installed` / `bad_media` / `bad_font` / `font_not_found` / `bad_style` / `bad_srt` /
`bad_recipe` / `license_blocked` / `verify_failed` / `not_found` / `not_provided` / `not_configured`

## 与字幕纪律的对应

| 纪律 | 落点 |
|---|---|
| 请求内容实际落盘 | ASS/SRT/VTT 时间轴与事件回读、真实 FFmpeg 输出 |
| 选了字体就真用它 | 实际渲染 `fontselect` 日志与随包字体目录 |
| 原片只读 | 输出不能覆盖原片、处理前后源哈希一致 |
| 字体许可干净 | 许可白名单与既有预审批；字体不子集化 |
| 无回执不算完成 | 输出哈希、元数据和真实处理错误；outage 不伪造回执 |
| 已成功渲染原片默认直通 | 无画面评分、无品质触发重渲染；`qualityReviewed=false` |
