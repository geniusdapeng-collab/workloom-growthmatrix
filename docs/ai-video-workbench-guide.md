---
guideVersion: 2026-10-07.1
productId: workloom-ai-growthmatrix
repository: workloom-ai/WorkLoom-growthmatrix
---

# Matrix 内置 AI 工作台：把视频需求交给系统

本指南供本仓内置 AI 工作台、数字员工及连接本仓的外部 Agent 使用。接到视频需求后，先读完整指南，再保留完整需求、选择入口、检查依赖，最后调用既有工位并核对回执。指南可被 CLI 和 MCP 读取，读取本身只访问本仓固定文件，不启动服务、不调模型、不生成媒体。

本仓是 Matrix 隔离实验副本。本指南按 Matrix 当前代码编写；不可拿 Growthtest 的 `film-standard-post.mts`、`standard-post-contract.ts` 或 native standard-post 修复当成本仓已有能力。

## 1. 首先读取这份指南

源码目录下：

```bash
node scripts/workloom-agent.mjs list
node scripts/workloom-agent.mjs describe growth.video.workbench.guide
node scripts/workloom-agent.mjs invoke growth.video.workbench.guide
```

MCP 工具名为 `workloom_growth_video_workbench_guide`，参数只能是 `{}`。CLI 返回 `result.content` 为本文件完整 UTF-8 正文，另含固定路径、产品标识、版本、字节数和 SHA-256；保存或传给下一位员工时应核对摘要。缺文件、文档版本不符、非法 UTF-8、符号链接、错产品或超过 512 KiB 都会失败，不能把错误或截断文本当成指南。

安装客户使用随安装目录提供的 Node 和 `runtime/scripts/workloom-agent.mjs`，产品根是同目录的 runtime；完整指南随运行载荷分发。旧载荷若没有此能力，或调用报固定指南缺失，先更新载荷，再读取本仓文档；不能改调任意文件读取或借用别仓指南。`WORKLOOM_VIDEO_ARTIFACT_ROOT` 仅调整生产产物读取根，不改变指南固定位置。外部工作台接入详见 [CLI/MCP](agent-cli-mcp.md) 和 [Agent 客户端](AGENT-CLIENTS.md)。

## 2. 把用户的完整需求保留下来

**按每条短片重新规划，不把成功样片变成固定模板。**总时长遵循用户明确要求；用户未指定时，由视频管线结合目标平台、内容和预算提出方案，并标明这是系统规划。镜头数、逐镜时长和镜头编排由正式视频管线按叙事、商品展示、台词、节奏、可用素材及当前生成能力自主拆分；只有用户明确指定的项才作为作业固定项。工作台不得沿用上次的「6 镜」「每镜 5 秒」或镜头顺序替管线做决定。版本数按本次需求和所选正式交付入口核对。

先把需求原文和结构化约束写入项目档案 `brief.json`，并记录其 SHA-256。没有用户给出的信息写「未提供」，不得自动补成事实。至少保留：

| 字段 | 必须留下的内容 | 下游核对位置 |
|---|---|---|
| `requestOriginal` | 用户完整原话及后续修订 | 原稿档案、冻结 document、交付说明 |
| `durationSec` / `aspectRatio` / `resolution` / `platform` | 时长、比例、尺寸、投放平台 | 项目意图、逐镜时长、媒体实测 |
| `title` / `subtitle` / `dialogue` | 标题、字幕语言/方式、台词原文与说话人 | 镜头卡、字幕、音轨核查 |
| `character` / `authorization` / `product` | 角色/真人 ID、授权期限、商品锚点与素材来源 | 角色/真人/商品档案、引用及镜头卡 |
| `soundPolicy` | 原生对白是否必须保留，是否允许配音/TTS、音乐及音效偏好 | 执行前能力检查、音轨与交付清单 |
| `style` / `mustInclude` / `mustNotInclude` | 画面偏好、必须出现和禁止改动的内容 | 分镜与交付逐项核对 |
| `maxBudgetCny` / `deliverables` | 预算、母版/字幕/封面/变体要求 | 服务工位预算、台账、文件回执 |

示例档案（数字是用户明确要求的例子，不能作为其他项目默认）：

```json
{
  "requestOriginal": "用我已授权的角色拍一支27秒竖屏品牌故事，保留片段原生对白，中文字幕，轻快配乐，交母版和封面。",
  "durationSec": 27,
  "aspectRatio": "9:16",
  "platform": "抖音",
  "soundPolicy": {"preserveNativeDialogue": true, "allowTts": false},
  "deliverables": ["master", "subtitles", "cover"],
  "authorization": "待从现有角色档案核对"
}
```

短标题只用于路由和展示，不能取代完整档案。尤其不要把长需求裁到 `core.task.dispatch.title` 的 120 字符以内后声称约束已经完整传入；该接口没有 brief/document 字段，`goalRef` 也不是任意文件读取入口。

## 3. 三个常见场景，选对入口

| 场景 | 入口与动作 | 必须停止的条件 |
|---|---|---|
| 新做一条有明确商品的营销片 | 内置视频 Studio 建项目，分流营销；核对商品档案和 G1，再形成镜头卡 | 商品来源/授权缺失、分流待澄清、预算或依赖未就绪 |
| 已有叙事项目和冻结镜头卡，需要继续后期或取件 | `video.film.start` 运行固定阶段；同一 `invocationId` 查 `video.film.receipt`、`video.film.artifact` | 原稿/阶段/文件摘要不符、项目不属当前成员、未知执行状态 |
| 要求原生对白原样保留，并禁止 TTS 的既有片段剪辑 | 先核查本仓能力并报告严格原生后期缺口 | 本仓没有 native standard-post 合同；不得改走 voice/TTS 冒充完成 |

通用岗位问询可用 `core.task.dispatch` 自动选岗或指定 `presetKey`，它适合职责、缺口及短目标问询。调用视频生成时应使用视频专用入口并保留完整原稿。岗位名称、一次工具成功、CLI 退出码 0 都不能证明整片已经交付。

## 4. 内置视频 Studio：新项目与预生产

PC 入口为 `/ai-video/assets?tab=studio`。服务端过程是 `video.studio.start`（不是现有 CLI/MCP 清单里的能力 ID）。它接收 `intent`（1–2000 字符）、可选 `metadata`、`projectId` 与 `route=auto|marketing|narrative`；完整 brief 可放进 `metadata.brief`，用户原文也要留在档案。此 metadata 的传输不代表每个下游约束都会自动执行，必须逐项核对。

重要现存限制：Studio 的新项目和补跑分支都调用 `buildPipelineIntent(..., {durationSec: 30, ...})`。因此「27 秒」等非 30 秒需求不能靠在 title/metadata 写一遍就算完成。启动前要明确这个差异，预生产后核对形成的意图、文稿和镜头卡；发现被改成 30 秒时停止，不得未经授权静默接受或花钱渲染。需使用能显式保存该请求的已有项目/冻结 document/CLI 镜头卡路径，并验证真实时长；不能本次擅自修改这段管线机制。

默认 `auto` 进行营销/叙事/口播分流。返回 `kind=clarify` 时保留 `question/missing/signals`，补齐必须信息后再继续；不能用强塞 `route` 替用户决定商品信息。返回 `kind=routed` 后保留 `projectId/runId/pipeline`。口播解说片会给出 `shotbookId` 与下一步 `video.explainer.saveScript/shotbook/submit/finalize`，按该专用链执行，不塞入叙事影片工位。

预生产核对点：商品/角色/授权档案、剧本与逐镜卡、镜头时长、对白和声音政策、平台与比例、预算、定妆验收。真人参考只用受授权 `asset://` 通道；不得直传真人照片绕过平台。默认陈卓是本仓随附角色，只有用户未指定角色且适用时才沿用，不能替换用户指定的真实人物。G5 定妆放行由人类验收，机器像不像结论只留证；不能代签。

## 5. 服务端固定影片工位：已存在的项目

先 `describe video.film.start` 读取当前契约。本人成员已有的叙事/营销项目、完整 JSON document（含 `shots[]`，最多 4 MiB）、固定 stages、idempotencyKey 必须具备；不能用任意脚本、shell 或输出路径代替工位输入。options 的真实白名单在 `normalizeFilmJobRequest`，未知选项会拒绝。

在受控客户端把已验收的完整镜头卡装入 document，准备 `film-request.json`，再调用：

```bash
node scripts/workloom-agent.mjs describe video.film.start
node scripts/workloom-agent.mjs invoke video.film.start --input-file film-request.json
node scripts/workloom-agent.mjs invoke video.film.receipt --input-file receipt-request.json
node scripts/workloom-agent.mjs invoke video.film.artifact --input-file artifact-request.json
```

请求结构如下；示意文字必须换成真实项目和镜头卡，不能原样提交：

```json
{
  "projectId": "VID-已有项目编号",
  "document": {"brief": {"requestOriginal": "完整需求原文"}, "shots": ["替换为完整真实镜头对象"]},
  "stages": ["spec", "compose", "color", "subtitle", "bgm", "cover", "mux", "master", "deliver"],
  "options": {"routeKind": "narrative", "subtitleMode": "both", "reviewPolicy": "off"},
  "maxBudgetCny": 100,
  "idempotencyKey": "该次逻辑请求的稳定唯一键"
}
```

`maxBudgetCny=100` 只是结构示例，应替换成用户实际批准预算；缺预算不代表无限费用。阶段按现有素材和真实需求选择，不能跳规范闸。服务端已接线 `FullChainFilmWorker`：冻结原稿和摘要，运行固定 CLI 工位，通过父通道处理受限组件调用、期限、预算与评审。它不是任意本地 shell 代理。

回执输入为 `{"invocationId":"真实调用 UUID"}`；取件输入再加 `"index":0`，索引必须来自实际回执。保存 `result.artifact.base64` 前核对 MIME、长度与 SHA-256。pending 继续查原调用；超时或状态未知保留原幂等键，不再派一次。相同键相同参数重查原请求，同键异参会拒绝。`core.task.cancel` 不提供影片异步作业或外部动作的假回滚。

服务工位默认保持 `dataMode=unverified`；来源可核对不等于用户业务结果已验收。固定阶段成功后仍要检查最终文件和需求。

## 6. 有终端的 Agent：沿用本仓 CLI

需要本仓锁定的 Node/pnpm、完整工作区依赖、ffmpeg/ffprobe、素材和授权。先读 [ai-video runbook](../bundles/ai-video/README.md) 和 [交付规范](video-delivery-and-revision.md)。密钥从既有受控环境/密钥文件读取，不写入 brief、命令文本、日志或提交。

```bash
pnpm video:doctor
pnpm exec tsx scripts/tools/route-video.mts --title "本次需求的短标题" --brief work/film/brief.json --out work/route.json
node scripts/workloom-agent.mjs invoke growth.video.production.plan --input-file plan-request.json
```

分流前核对 brief 文件确实存在且是合法 JSON（当前 route CLI 的缺文件路径不会替你保留 brief）。上面的规则分流不带 `--llm`；只有明确授权且需要仲裁时才启用它。`production.plan` 是预览，返回本指南锚点、前置检查和建议命令，不生成分镜/视频，也不保留其 title 以外的全部需求。复制建议命令后，把原始 `--brief` 和真实 `--shots` 路径保留下来。

固定执行形式见 runbook，核心参数是：

```bash
pnpm exec tsx scripts/tools/full-chain-film.mts \
  --shots work/film/shotlist.json --brief work/film/brief.json --project VID-真实项目 \
  --work-dir work/vm-VID-真实项目 --out work/out-VID-真实项目 \
  --route work/route.json --platform 抖音 --fps 24 \
  --subtitle-mode both --review-policy off
```

实际生成会使用用户已配置供应商/组件并可能产生费用；读取指南和计划并未授予费用权限。营销片先确认商品档案/G1，真人先确认授权和清单；逐镜卡要通过 spec。默认成功渲染后沿用完整后期链，创作偏好咨询与事实硬闸分开；不能用删除失败记录、豁免参数或手工混音绕过工位。

## 7. 声音、后期和既有素材的真实边界

本仓普通链有 `voice → compose → color → subtitle → bgm → cover → mux → master → deliver`，可选 danmaku/sfx，按请求和素材选择。旧 voice 工位会核查片段声音，必要时补配音；统一旁白选项也会重配对白。因此严格要求「保留原生音轨、禁止 ASR/TTS/重配音」时，不能启动旧 voice 链后把声音改变称为修复。禁止自动改用口播解说片。服务 options 中 `unifiedNarration` 和 CLI 旧统一旁白开关都需要单独授权。

Matrix 当前没有 Growthtest 的 `film-standard-post.mts` 或原生标准后期合同，所以严格 native 请求先报告能力缺口并停止该生产路径。没有缺口修复或另获用户授权就不得产出冒充合规的交付；指南不移植跨仓生产机制。

已有片段 `post-only` 需要显式声明 `assembly-mode=post-only` 与至少 8 字的 `assembly-reason`，规范 spec 自动补入；这只声明复用组装，不证明原生对白/源片字节保持，也不是 strict native 替代品。调色、字幕、配乐、封面之后要查音轨、时长和所需变体。配乐来源若是 declared-unverified，应保留来源口径，不冒充签章分轨；用户禁止配乐时不能偷偷加音乐。

## 8. 时间、失败和续跑

下面的「30 秒、6 镜、五版本」仅是本次历史样本的计时条件，不是生产默认参数或通用交付数量，也不参与拆镜决策。新作业按管线实际镜头数、逐镜时长、生成类型和所需版本重新估时；17–30 分钟及 25 分钟不作为全局超时或验收闸。第 4 节列出的 Studio 固定 30 秒是本仓已有入口限制，本次没有新增该限制，也不能将它推广成视频创作规则。

本轮跨仓参考估算（D 级，未在 Matrix 本轮实测、非 SLA）：30 秒/6 镜、五版本，素材授权齐备、热环境、单轮通过，且没有欠费、等待人验收或返修时，从完整指令到前期提示词、渲染、后期、QA 打包建议 **17–30 分钟**，排期可留约 **25 分钟**；已有素材只跑后期建议 **6–12 分钟**。拆分参考为前期 2–5 分钟、逐镜云端 8–10 分钟、取片检查 0.5–2 分钟、后期 5–8 分钟、QA 1–3 分钟，合计 16.5–28 分钟再留余量。本仓不保证这个范围，五版本能力也须按本仓真实机制和请求核对，不能套用 Growthtest 的 native 五版合同。

依据为本轮 Growthtest 留证的六个供应商视频任务：created→updated 单任务约 66–82 秒，总和 435 秒，其中两任务有重叠，活动区间并集 391 秒；不能把含等待/返修的最早→最晚 2 小时 24 分钟当正常耗时。最终已有素材后期 31 条工位 ms 合计 285697（4 分 45.697 秒），没有完整 start/end wall clock，不能称端到端实测。上述是其他隔离仓样本对本仓排期的参考推断，没有移植其生产机制。

本仓历史 [交付规范](video-delivery-and-revision.md) 的 2026-09-24 记录另有 3×9 秒已有片段的三变体后期包 68 秒、字幕约 2.4 秒、配乐约 4.5 秒；这是旧机器/旧输入样本，本次未重跑，不包含新片预生产和视频生成。工位每镜约 19 分钟及全作业 3 小时是失败超时上限，不是正常平均时间。实际更新应从本项目阶段账本、job 和调用回执计算，说明阶段、输入、硬件与模型。

| 失败或未知状态 | 处理方式 |
|---|---|
| 分流 clarify、商品/授权/原稿缺失、30 秒意图与请求冲突 | 保留原请求，停止进入生产，补齐必要事实或报告路径缺口 |
| 固定指南不存在/错版本/符号链接/旧载荷 | 报缺失并更新同仓载荷，不能返回空指南或借用别仓 |
| 未登录/无权限/跨成员或工作区 | 使用本机受控身份；按 401/403/404 原样失败，不代换身份 |
| 模型未配置、quota/AccountOverdue、预算不够 | 停止提交，报告实际错误；不得盲目重试、换模型或借账户 |
| 请求超时、pending、终态未知 | 查同一 invocation/job 与事件；不换幂等键重复提交 |
| 文件缺失/摘要变了/音轨或字幕不符 | 保留失败证据，修对应阶段并核对新回执；不能把旧文件标成新完成 |

## 9. 最终交付与如实汇报

1. 核对完整 brief 每一项：时长、比例、角色/授权、商品、原对白/声音政策、字幕、封面、变体和预算。
2. 服务调用核对 `video.film.receipt` 中 job、阶段、预算、失败、产物；CLI 调用核对 `growth.video.production.status` 与 `growth.video.delivery.inspect`。本地 SHA-256 完整只能证明文件未被换，不能证明画面好看或对白没变。
3. 从真实清单取母版、字幕/softsub、封面、所需变体及台账；文件名与实测时长一致，解码取件后复算 SHA-256。请求不需要的附件不得冒充必需交付。
4. 汇报实际完成/未完成、来源与摘要、模型/组件真实调用、费用或缺登记、等待与失败、需求偏差及其原因。完整需求未满足就不能报告「整片已完成」。

## 10. 实现依据与版本复核

本指南基于本仓实际接口；以下是复核入口，当前 `describe` 与服务严格校验优先于历史示例：

- 固定发现与调用：[行业清单](../bundles/geo-growthmatrix/agent-capabilities.json)、[本地模块](../bundles/geo-growthmatrix/capabilities/workbench-guide.mjs)、[CLI](../scripts/workloom-agent.mjs)、[MCP](../scripts/workloom-agent-mcp.mjs)。
- 岗位/影片契约：[核心清单](../scripts/agent-capabilities.core.json)、[agentRouter](../apps/server/src/trpc/agent-router.ts)、[filmRouter](../apps/server/src/video/film-router.ts)、[工位服务](../apps/server/src/video/film-worker.ts)。
- Studio 的 intent/metadata 与 30 秒构建：[videoRouter](../apps/server/src/video/router.ts) 的 `studioRouter.start`。
- 阶段、options、父通道：[normalizeFilmJobRequest / FullChainFilmWorker](../packages/video-studio/src/film-worker-runtime.ts)。
- CLI 分流与旧出片：[route-video](../scripts/tools/route-video.mts)、[full-chain-film](../scripts/tools/full-chain-film.mts)。
- 打包固定指南：[product-runtime-assets](../scripts/product-runtime-assets.mjs)，单独白名单此文档并登记 RUNTIME_ASSETS.json 摘要，不包含整个 docs 目录。

读取能力的成功仅证明本次拿到完整指南。本次指南更新未调用模型、供应商、TTS、ASR 或媒体生成；生产可用性和客户设备上完整出片另用真实需求与回执验收。
