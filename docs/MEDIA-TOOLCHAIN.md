# 媒体工具链与 U-02 环境漂移（audio-stems 冻结缓存）

> 适用：`bundles/ai-video/connectors/{bgm-bridge,post-bridge}` 的独立音轨（audio-stems）链路。
> 背景：排雷台账 U-02 —— 冻结音轨缓存的「工具指纹」在换环境后复用会报 `audio_stems_stale`，
> 现场无法区分**环境漂移**与**缓存被改**，媒体用例也因此出现「本机必败」的假失败。

## 1. 指纹由什么组成

缓存清单 `audio-stems.json` 记录 `recipe.toolchain`，复验时逐字节比对三项：

| 项 | 来源 | 漂移含义 |
|---|---|---|
| `rendererSha256` | `bundles/ai-video/connectors/bgm-bridge/audio-stems.mjs` 文件摘要 | 渲染器代码变过（升级/热改）——旧缓存必须在同一渲染器版本下重建 |
| `ffmpeg` | `ffmpeg -version` 首三行 | 换了另一套 ffmpeg 构建 |
| `ffprobe` | `ffprobe -version` 首三行 | 换了另一套 ffprobe 构建 |

复验失败一律是 `audio_stems_stale`；自 U-02 起错误文案会**点名差异项**并给出存/现指纹首行，例如：

```text
音轨缓存工具指纹与当前环境不一致（差异项：ffmpeg）——缓存 ffmpeg=ffmpeg version 6.0 …；
当前 ffmpeg=ffmpeg version 99.0-u02-drift …。同一产物必须由同一 ffmpeg/ffprobe 构建与同一渲染器复验
（环境漂移请重建缓存；CI 请固定 ffmpeg 构建）
```

## 2. 为什么会出现「同一产物换个进程就 stale」

派生与复验必须解析到**同一对二进制**。解析顺序（bgm-bridge / post-bridge 一致）：

1. `WORKLOOM_POST_FFMPEG_PATH` / `WORKLOOM_POST_FFPROBE_PATH`
2. `WORKLOOM_SUBTITLE_FFMPEG_PATH` / `WORKLOOM_SUBTITLE_FFPROBE_PATH`
3. `~/.workloom-color/bin/ffmpeg`（工位 kit，存在即优先于 PATH）
4. `PATH` 里的 `ffmpeg` / `ffprobe`

历史坑位：父进程按 `WORKLOOM_POST_*` 解析、CLI/HTTP 子进程按 PATH 或 kit 解析，两边不是同一套构建时，
复验必然报指纹不一致。测试与脚本现在会把解析结果写回子进程 env（见
`bundles/ai-video/connectors/bgm-bridge/audio-stems-mix.test.mjs`），保证「谁派生、谁复验」一致。

## 3. 环境要求与自检

```bash
# 打印本机/流水线的媒体工具链指纹（版本、二进制 sha256、libx264、渲染器摘要）
pnpm media:toolchain

# 作为门禁用（缺 ffmpeg/ffprobe 或缺 libx264 → exit 1）
node scripts/ci/media-toolchain.mjs --strict

# CI 归档用（机器可读）
node scripts/ci/media-toolchain.mjs --json
```

要求：

- `ffmpeg` / `ffprobe` 在位，且构建含 `libx264`（媒体用例用 `testsrc2 + libx264` 造夹具）；
- 跑下面两个原生用例文件时，**派生与复验必须同一构建**：
  - `bundles/ai-video/connectors/post-bridge/audio-stems.test.mjs`
  - `bundles/ai-video/connectors/bgm-bridge/audio-stems-mix.test.mjs`
  （由 `packages/base/bundles/post-audio-stems.test.ts` 在 `pnpm test` 中拉起）；
- 缺工具或缺 `libx264`：原生媒体用例跳过，探针在测试输出里显式标注（不会把环境缺陷伪装成 `audio_stems_stale`）；
- CI（db-gate）在跑主测试套件前按发行版固定构建补装 ffmpeg 并打印指纹，保证这两组用例真跑而不是跳过。

## 4. 复现与修复口径

| 现象 | 判定 | 处置 |
|---|---|---|
| `差异项：ffmpeg` / `差异项：ffprobe`，两侧版本首行不同 | 环境漂移（换了构建） | 统一两边解析来源（env 注入或 kit），或按新构建重建缓存 |
| `差异项：renderer` | 渲染器代码变过 | 用当前渲染器重建缓存（旧产物不再可复验） |
| 三项都一致仍 stale | 缓存/来源被改或作用域不符 | 按错误文案逐项排查（作用域、配方摘要、来源签章） |

回归证据：

- `bundles/ai-video/connectors/post-bridge/audio-stems.test.mjs` 的「U-02 换 ffmpeg 构建复验时必须点名差异项」用例
  （真 ffmpeg + 包装脚本模拟另一构建）；
- `node scripts/ci/media-toolchain.mjs`（工具链指纹探针）与 `.cnb.yml` db-gate 的媒体工具链步骤。
