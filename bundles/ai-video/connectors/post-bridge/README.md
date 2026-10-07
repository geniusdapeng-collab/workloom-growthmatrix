# 后期交付与返修 bridge 连接器（ai-video）

把「一支片子交给用户」这件事做成可审计的确定性流程：**母版不烧字幕 → 同一批镜头派生多个风格变体 →
交付清单 + 工程文件 → 用户反馈按层增量本地重合成（不重新生成镜头）**。

**2026-10-07 当前默认**：成功渲染镜头直接正式后期。源片人物、服装、动作、原始规格、黑画面、音频、对白与口型不再作二次品质评审；不因旧品质失败或组件配方改变重生成。默认使用原节目音，不自动调用 ASR/TTS、不要求签章签发者。每个实际请求的后期层加工一次；实际缺文件、字节变化、权限/路径/许可错误和加工失败仍停止交付。回执标 `qualityReviewed=false`，品质分数与差异为 `null`。

## 为什么单独做一层

镜头生成（Seedance 渲染）是链路里唯一"贵且慢"的环节，后期（剪、调、配、加字、出封面）几乎只吃本地算力。
于是有两个结论：

1. **不要替用户猜风格**：按本次请求派生风格版本（封面/文案/BGM/调色/转场），让他按真实成片挑；显式单变体也可交付；
2. **不要动不动重生成**：反馈先做变更影响分析，能在本地重合成的绝不去烧渲染额度。

## 部署形态

```
WorkLoom（大脑：岗位/技能/围栏/事件账本）         Mac 后期工位（手，独立内网）
  runtime ToolExecutor ──HTTP/Bearer──▶  post-bridge (127.0.0.1:9777)
                                            ├─ ffmpeg / ffprobe（归一化/拼接/封面/软轨）
                                            ├─ ffmpeg scale/pad（按请求 HD/UHD 画布实际导出）
                                            ├─ subtitle-bridge 内核（旁挂字幕 + 软字幕轨 + 标题版式）
                                            ├─ color-bridge 内核（请求调色一次，无可见性品质评审）
                                            ├─ bgm-bridge 内核（请求配方一次，无声学品质评审）
                                            ├─ library/style-variants（风格配方：调色/BGM/转场/封面/文案）
                                            ├─ 产物区（新文件 + 版本链 + 缓存：enhanced/norm/assemble/graded/audio）
                                            └─ 回执：源/产物 sha256 / 真实配方 / 复用证据 / 成本口径
```

**大文件不出工位**：服务器只传路径与参数，工位本地读写素材，只回元数据与小图。

## 工具面（6 个）

| 工具 | 类型 | 用途 |
|---|---|---|
| `postread.health` | 读 | 工位体检（ffmpeg / 变体包 / LUT / 曲库 / 字幕工位） |
| `postread.plan` | 读 | 交付计划：镜头清单、变体差异轴、步骤与成本口径（不动文件） |
| `postread.impact` | 读 | **变更影响分析**：patch → 重算哪些层 / 是否需重生成镜头 / 花钱闸 |
| `postwrite.package` | 写 | 出交付包：干净母版 + 旁挂字幕 + 多风格变体 + 封面/文案 + 软字幕轨 + 清单 + 工程文件 |
| `postwrite.reedit` | 写 | **本地层增量重合成**：读工程文件 + patch → 新版本目录；镜头不动、复用带哈希证据 |
| `postwrite.triage` | 写 | 反馈分诊：自由文本 → 归因码 / 受影响层 / 是否重生成点名镜头 / 给用户的话 / patch 提示 |

## 交付包结构

```
<outDir>/
  master/master-clean.mp4                     干净母版（无字幕、无变体调色；返修地基）
  subtitles/<项目>.zh.srt|.zh.ass|.vtt       旁挂字幕（母版不烧字）
  subtitles/<项目>.subtitle-manifest.json    请求时间轴 / 字体解析 / 源与文件摘要
  variants/<变体>/<变体>.mp4                 变体成片（无字幕轨）
  variants/<变体>/<变体>.softsub.mp4         视频/音频流 copy + 可开关字幕轨（记录轨道/元数据与摘要）
  variants/<变体>/cover.png                  封面（按变体版式与文案渲染）
  variants/<变体>/copy.md|copy.json          文案包（标题/钩子/正文/话题/CTA + 四条校验）
  variants/<变体>/audio.json                 曲目/许可/署名/实际混音参数与来源，无声学评分
  film-project.json                          工程文件（层结构 + 产物血缘）——返修入口
  delivery-manifest.json                     交付清单（全产物 sha256 + 真实配方 + 未做品质复评 + 成本口径）
  delivery-report.md                         人看版说明（变体对照表 + 返修路径 + 未达标项）
  versions/v2/…                              返修版本目录（只增不覆盖）
```

## 命令行

```bash
post-cli health
post-cli variants
post-cli plan     --project project.json --shots a.mp4,b.mp4 [--quality hd|uhd] [--variants warm-story,clean-tech]
post-cli deliver  --project project.json --shots signed-shots.json --out-dir out/ \
                  [--quality hd|uhd] [--srt subs.srt] [--srt-en subs.en.srt] [--burn-subtitles] [--no-soft-subtitles]
post-cli impact   --project out/film-project.json --patch patch.json
post-cli reedit   --project out/film-project.json --patch patch.json [--shot SC-03=/path/new.mp4] \
                  [--audio-stems-by-shot signed-replacement-sources.json]
post-cli triage   --feedback "配乐太吵，另外第 3 个镜头人物走形"
```

退出码：`0` 成功；`2` 用法错误；`3` 工具错误（code 见 `PostError`）；`4` 需要人审（镜头重生成走 G8）。

## 默认原节目音与显式独立音轨合同

默认交付接受视频路径或 JSON 镜头清单，按源片原节目音加工；源片无音轨时按实际时间轴加入静音，回执如实记 `sourceAuthority=original-program-bytes`、`stemsVerified=false`，没有独立角色品质结论。

明确提供 `shots[].audioStems` 时才使用签章分轨合同，并要求 `project.audioScope={tenantId,workspaceId,projectId,revision}`。`revision` 是画面/原稿的生成版本，独立于后期工程 v1/v2；CLI 的 JSON 清单保留该显式引用。错误引用不自动丢弃或退回原节目音。下述严格校验只适用于该显式选择。

每镜必须明确 `dialogue/ambience/foley/music` 四个角色。可用源含 `status:"ready"`、音频路径、SHA256、
`sourceKind`、权威 `receipt`，可选 `inSec/durationSec/offsetSec`；不适用角色用
`status:"not_applicable"`、具体 `reason` 和同样的权威回执。允许来源为 TTS/独立录音对白、独立合成/录音
环境与拟音、作曲/许可音乐；从带配乐视频抽出的混合声与近似分离声不能冒充独立角色。

`../bgm-bridge/audio-stems.mjs#describeAudioStemSources` 定义签署绑定：租户、工作区、项目、原稿版本、镜头、原视频
哈希、角色、源字节、源时长与样点放置（模块自 2026-09-28 起由 `bgm-bridge` 自持，保证配乐工位自包含）。
`../bgm-bridge/audio-stems-trust.mjs` 只验证内部媒体工位签章，未提供生产
签发接口。工位通过独立的 `WORKLOOM_AUDIO_STEM_SIGNING_SECRET`（至少 32 字节）和
`WORKLOOM_AUDIO_STEM_SIGNING_KEY_ID` 配置验证能力；不得接受请求参数传入的密钥、`clean:true` 或普通
交付封签。密钥与签发进程必须由部署层隔离，HMAC 本身不提供同 UID/同主机管理员隔离。
显式选择签章分轨而未配置可信签发者时拒绝 `audio_stems_source_unverified`；默认原节目音不需要签发者。测试中的随机签发者只证明合同与算法。

源文件从同一打开的 FD 校验并复制到独占工作目录后才交给 FFmpeg。四角色按 48kHz 样点时间线派生；
节目轨只含对白、环境和拟音，保留的旧音乐永不进入节目轨。母版、禁用 BGM 和配乐失败草稿均只映射
画面及该节目轨。签章、源快照、角色/节目 WAV、工具指纹与配方摘要记录在 `work/audio-stems/*/audio-stems.json`。
工程/清单固定该文件与配方的哈希；返修重新校验当前签章、所有字节和确定性重放结果。过期回执可留档，不能授权新使用。

原工程明确选择签章分轨时，替换镜头必须同时提供 `audioStemsByShot`（工具为 `audio_stems_by_shot`，CLI 如上），且签章绑定新视频。默认原节目音工程继续使用新视频的实际原节目音。
改转场会重建同样的音轨时间线；改 BGM 从独立节目轨重混。旧工程只能保留文案/封面等草稿返修，
`independent_audio_sources=false`；不会从旧成片推断干净轨。真实音频重混每次重新执行，旧混音元数据不能授权缓存成功。
音频回执本身有冻结哈希，失败音频不会在下一轮仅改文案后变成通过。

同一 HTTP 幂等键的相同在途请求共用作业；不同参数返回 `idempotency_conflict`，完成后再次提交返回
`idempotency_revalidation_required`，避免旧成功绕过过期签章。已存在完成工程的输出目录不得重做 package，须走返修版本。

`quality` 缺省为 `hd`。`uhd` 对应竖屏 2160×3840、横屏 3840×2160、方屏 2160×2160、4:5 2160×2700。
请求 UHD 时，成功低分辨率源片默认接受，以 FFmpeg 实际缩放/补边到所请求画布，不强制模型增强或画质证明。归一化回执记录 `processingMode=ffmpeg-scale-pad`、真实参数和源/产物摘要；实际产物宽高不符请求则失败，不能仅在清单写 UHD。

在 Apple Silicon macOS 工位上先安装本机工具（安装脚本校验固定版本与哈希）：

```bash
bash bundles/ai-video/connectors/color-bridge/kit/install.sh
node bundles/ai-video/connectors/post-bridge/cli.mjs health
```

桌面安装包包含上述脚本与后期代码，不内置模型和 FFmpeg 二进制。现有 FFmpeg kit 的构建含 `--enable-nonfree`，不可随产品再分发；安装器把它下载到当前 Mac 的 `~/.workloom-color/bin`。后期工位优先使用显式 `WORKLOOM_POST_FFMPEG_PATH` / `WORKLOOM_POST_FFPROBE_PATH`，否则寻找该 kit，最后才查系统 `PATH`。无 FFmpeg 时请求失败并给出健康探针结果；本轮只验证离线本机合成媒体，没有新增真实模型增强验收。

## 返修并发与版本前置条件

页面 `video.delivery.get` 返回当前 `revisionBase: { version, projectSha256 }`；提交 `startRevision` 必须带
`expectedVersion` 与 `expectedProjectSha256`。服务先比较快照，原样传给 CLI，工位拿到包级排他锁后再次比较。
页面加载后若已有新版本，或同版本工程字节改变，本次请求返回 `CONFLICT`，用户刷新并核对后才能再次提交。

工具 `postwrite.reedit` 对应参数是 `expected_version` / `expected_project_sha256`；可先以 `dry_run: true`
取得只读计划及前置条件。CLI 可用 `--dry-run`，或显式传
`--expected-version N --expected-project-sha256 <64位小写SHA256>`。两个参数必须成对；均省略时只读取用户
`--project` 指定文件的快照，仍会拒绝过期文件，绝不自动跟随新版本。

工位用 `.revision.lock` 的独占创建认领包，同锁内独占创建 `versions/vN`；每个认领有 runId、基础版本与哈希。
先写产物与 `revision.json#commit`，最后以不可覆盖的原子硬链接发布 `film-project.json`，发布成功才算该版本提交。
失败目录保留 `revision-failed.json`，版本号不复用；下一次成功可能从 v1 跳到 v3。退出只清理本进程仍持有的锁。
异常退出留下的锁不会凭 PID 自动抢占，需运维核对对应进程、runId、认领和失败回执后恢复。

`revision_conflict`（快照/锁归属变化）、`revision_busy`（已有持有者）、`revision_io_failed`（认领存储失败）
均不可自动切换端点重试。此协议面向同一台工位的本地文件系统；不宣称网络文件系统上的分布式锁保证。
独占创建与网络文件系统限制依据 [Node.js 文件系统标志文档](https://nodejs.org/docs/latest-v24.x/api/fs.html#file-system-flags)。

## 风格变体（`library/style-variants/`）

| 变体 | 定位 | 配方轴（不作品质结论） |
|---|---|---|
| `warm-story` | 情感/文旅/民宿 | warm-film LUT 0.75 · fade 0.6s · acoustic-warm -23dB · 留白题签 · 温暖克制口吻 |
| `clean-tech` | 产品/科技/知识 | cool-technical 0.7 · hard · corporate-clean -25dB · 参数卡封面 · 简洁理性口吻 |
| `bold-promo` | 带货/本地生活 | high-contrast-social 0.9 · xfade 0.35s · sports-hype -21dB · 促销横幅 · 直接叫卖口吻 |

当前交付按请求实际产出并记录这些配方。清单 `divergence` 的画面、音轨和封面指标为 `null`，不因相似、静音或画面品质重试。G-DLV1 只阻断实际所请求变体缺产物。以下历史真机数据不代表本轮品质或耗时验证。

## 实际交付合同

| 项目 | 记录与失败处置 |
|---|---|
| 母版与字幕 | 母版不烧字；软字幕执行视频/音频 copy，记录实际轨道、元数据、时间轴和摘要，不默认逐帧/PCM 评分 |
| 变体与封面 | 所请求文件实际存在、可读取并记录尺寸/摘要；按请求配方加工一次，无差异或墨迹品质闸 |
| 时间轴与规格 | 核对当前工程请求的实际产物时间轴、画布与轨道；源片原始规格不作品质闸 |
| 配乐 | 原节目音或显式签章分轨 + 请求混音参数；一次实际加工，无响度/人声/可闻度品质重试 |
| 复用证据 | 复用层给出实际 SHA-256；源字节变化、缺产物或缺证据直接失败（G-DLV7） |

## 真机验证数据（2026-09-24，本地 Mac + ffmpeg 6.0）

以下为旧品质/混音合同的历史记录，不能作为 2026-10-07 当前流程或本轮耗时验收；原签章合同的合成媒体与正常入口回归见 `docs/repairs/T-2026-0927-0037.md`。

| 场景 | 结果 |
|---|---|
| 首次交付（3 镜 / 27s / 3 变体 / 中文字幕） | 约 68 秒；8 项交付检查全绿；9 个 MP4/PNG + 6 个元数据文件 |
| 只改字幕的返修 | **2.4 秒**；`text` 层重算，`shots/assemble/color/audio/cover` 全部复用；三个变体成片与上一版**逐字节一致** |
| 只改某变体配乐电平的返修 | 4.5 秒；命中混音缓存（未重跑混音），软字幕轨重出 |
| 点名镜头重生成 | `reedit` 拒绝执行并返回计划（exit 4）：先过 G8 人审 + `render-project.mts --only SC-03`，再带 `--shot SC-03=…` 回到本地合成 |
| 分诊 | "配乐太吵，另外第 3 个镜头人物走形，换个封面" → `rev.audio.mix` + `rev.shot.content` + `rev.cover.layout`；点名 SC-03；标注需人审 |

## 接线

```ts
import { createPostBridgeExecutor } from "./bundles/ai-video/connectors/post-bridge/executor.ts";

const toolExecutor = createPostBridgeExecutor({
  baseUrl: process.env.WORKLOOM_POST_BRIDGE_URL!,   // 支持逗号分隔多端点
  token: process.env.WORKLOOM_POST_BRIDGE_TOKEN!,
  tenantId: "ws-video",
  timeoutMs: 3_600_000,                            // 一次交付含归一化/拼接/调色/混音/封面/软轨
});
```

环境变量：`WORKLOOM_POST_BRIDGE_PORT`（默认 9777）、`WORKLOOM_POST_ALLOWED_ROOTS`（路径监狱，冒号分隔）、
`WORKLOOM_POST_WORK_DIR`（缓存与工作目录，默认 `~/.workloom-post`）、`WORKLOOM_POST_FFMPEG_PATH` / `WORKLOOM_POST_FFPROBE_PATH`。

## 与其它工位的关系

- **字幕工位**：旁挂字幕文件与软字幕轨由它产出（`subtitlewrite.sidecar` / `subtitlewrite.softmux`），本工位负责编排并记录真实加工结果；
- **调色/配乐工位**：变体的调色与混音直接调用其内核，一次实际加工，不做源片/后期品质评审；
- **渲染链路**：用户明确请求改画面内容时才提出渲染计划（点名镜头 + G8 前置人审），本工位只做"重生成之后的本地合成"。

## 纪律

- 原片只读，版本只增不覆盖（`v1 → v2 → v3`）；任何写入都落到新文件；
- 无回执=未核实：产物带 sha256，"复用"必须带"未被重算"的证据；
- 不猜：未知 patch 键、缺字体、曲库无匹配一律抛稳定 code 的错误，不静默兜底；
- 不烧钱：需要重生成镜头时只出计划 + 审批闸，不擅自执行。
