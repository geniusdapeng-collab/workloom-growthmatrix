# 用 Codex 调用 Matrix 系统和指定数字员工

Matrix 的 JSON CLI 和 stdio MCP 使用同一份能力清单，连接当前工作区的服务端。给系统一个目标可以自动选岗；提供 `presetKey` 可以指定已经上岗的数字员工。任务、事件和文件回执都使用同一个调用编号查询。

适用场景：让系统生成一张封面并取回文件；向内容排期官或成本核算员询问当前数据缺口；在自己的影片项目中运行固定工位阶段并核对阶段文件。只读岗位保持只读，付费生成、公开发布和高风险动作继续走已有权限、围栏和审批流程。

## 连接正在运行的客户服务

源码入口是 `scripts/workloom-agent.mjs` 和 `scripts/workloom-agent-mcp.mjs`。客户安装后的入口位于本机产品运行目录的 `runtime/scripts/`，使用同一安装目录随附的 Node。安装预检会检查入口、清单、影片辅助模块及行业资产是否存在。

服务地址默认从当前 `product.manifest.json` 的桌面端口偏移读取，也可以用 `WORKLOOM_BASE_URL` 指定。远程服务使用 HTTPS，本机可用回环 HTTP。地址不能含用户名、密码或查询参数。

生产成员使用本机受控来源提供的 `WORKLOOM_ACCESS_TOKEN`；令牌只传进程环境，不能写入仓库、JSON 输入、MCP 示例或日志。本机开发示例工作区可以沿用现有默认成员登录。设置 `WORKLOOM_DEV_AUTO_LOGIN=0` 会禁用该开发便利入口。

```bash
node scripts/workloom-agent.mjs list
node scripts/workloom-agent.mjs describe core.task.dispatch
node scripts/workloom-agent.mjs describe video.film.start
```

## 给系统目标，或指定一个岗位

保存 `request.json`。省略 `presetKey` 时系统自动选岗。

```json
{
  "title": "生成一张小红书封面，标题「本周门店故事」",
  "runImmediately": true,
  "idempotencyKey": "my-cover-request-001"
}
```

```bash
node scripts/workloom-agent.mjs invoke core.task.dispatch --input-file request.json
```

指定岗位时，在同一个输入中加入 `"presetKey": "visual-designer"`。问询可使用：

```json
{
  "title": "当前岗位职责和可用数据有哪些缺口？",
  "presetKey": "content-calendar-officer",
  "runImmediately": true,
  "idempotencyKey": "my-calendar-question-001"
}
```

`title` 长度为 1 至 120 字符；请求键为 8 至 200 字符，同一逻辑请求重试必须保留原键和原参数。新目标使用新键。不存在、停用或未就绪的岗位会返回具体失败，不会替换成另一个岗位。

返回中的 `result.invocationId` 是调用编号，`result.thread.id` 是实际任务编号。`status=pending` 表示仍在排队、执行、等待审批或对账；`status=failed` 表示失败或缺少有效交付；`status=succeeded` 仍需核对 `delivery`、事件与产物。CLI 退出码 0 表示拿到了合法协议响应，不能单凭退出码判断任务成功。

调用未返回、网络超时或状态未知时，使用原请求键重查原调用，或查询已有编号。客户端不会自动重派未知副作用。

```json
{ "invocationId": "把实际调用编号填在这里" }
```

```bash
node scripts/workloom-agent.mjs invoke core.task.receipt --input-file receipt-request.json
```

## 取回产物与停止队列任务

任务回执的 `result.artifacts` 列出已登记文件的索引、MIME、字节数和 SHA-256。用实际索引取件：

```json
{ "invocationId": "把实际调用编号填在这里", "index": 0 }
```

```bash
node scripts/workloom-agent.mjs invoke core.task.artifact --input-file artifact-request.json
```

文件在 `result.artifact.base64`，同时返回 `mime`、`bytes`、`sha256`。保存前按 MIME 选择文件后缀，解码后复算长度和 SHA-256。文件不存在、被改动、链接越界或超过取件上限时会拒绝，不能用失效文件充当原交付。

ASK 问询的回答保存在实际 `ask.answer` 事件中，通过 `result.delivery.answer` 返回。调用方可以把它导出为 Markdown；该客户端导出应与服务端登记的图片、视频等文件区分。没有真实业务数据时会说明缺口，模拟回答不代表真实经营核算。

`core.task.cancel` 接收 `invocationId` 和一个新的 `idempotencyKey`。它能停止尚未绑定的调用及普通 Quest 的后续步骤，完成/失败/取消的终态保持原状。ASK 即时回答、影片异步作业和已经开始的外部动作不提供假回滚。

## 影片固定工位

`video.film.start` 接收本人成员已有项目的 `projectId`、完整 `document`、固定 `stages`、受控 `options`、可选 `maxBudgetCny` 和 `idempotencyKey`。`describe` 展示当前允许阶段和输入结构；原稿最多 4 MiB。`video.film.receipt` 查询作业、阶段评审、错误、预算和文件摘要；`video.film.artifact` 按索引取件。

工位沿用 Matrix 的影片管线及父进程评审，包含项目/工位/原稿/实现摘要校验、期限、组件台账和预算门禁。任意脚本、任意 shell、任意输出路径或调用方提交的工具计划不在接口范围内。确定性评审和本地文件成功不能证明付费生成或公开发布达标。

## 在 Codex 中连接 MCP

按照当前 [OpenAI 官方 MCP 文档](https://learn.chatgpt.com/docs/extend/mcp)，stdio 服务器配置可提供 `command`、`args`、`cwd`、`env` 与 `env_vars`。把下面路径替换成该客户机器上的实际绝对路径；令牌通过已有受控环境转发。

```toml
[mcp_servers.workloom_matrix]
command = "/absolute/path/to/node"
args = ["/absolute/path/to/runtime/scripts/workloom-agent-mcp.mjs"]
cwd = "/absolute/path/to/runtime"
env_vars = ["WORKLOOM_ACCESS_TOKEN"]

[mcp_servers.workloom_matrix.env]
WORKLOOM_DEV_AUTO_LOGIN = "0"
```

本机开发工作区需要默认成员时，可将 `WORKLOOM_DEV_AUTO_LOGIN` 改为 `"1"`，并设置该工作区的 `WORKLOOM_WORKSPACE_SLUG`、`WORKLOOM_MEMBER_NO`。不要把示例身份用于客户生产工作区。

连接后会发现 `workloom_core_task_dispatch`、`workloom_core_task_receipt`、`workloom_core_task_cancel`、`workloom_core_task_artifact` 及三个 `workloom_video_film_*` 工具。CLI 与 MCP 接收相同参数并共享持久幂等记录，可以跨传输重查同一个任务。

## 接口边界与回归

未登录返回 401，当前权限不足返回 403，读取不属于本人成员的调用返回 404，同键异参返回 409，取件摘要不满足返回 412。参数格式错误由 CLI 本地校验或服务端严格输入校验拒绝。

请求键已认领后的执行错误保存在调用回执中。岗位不存在、尚未就绪、执行或取消失败时，请检查 `status`、`result.failureCode` 和 `result.response.code`（取消结果在 `result.cancellation`）；即使 HTTP 和 CLI 协议成功也不能把该任务标为成功。状态未知时保持原键查询，不重复执行。

`receipt.sourceVerified` 表示当前事件和文件来源可核对，`receipt.businessVerified` 仍为 false。`dataMode=simulated`、`provided-unverified` 或 `unverified` 都要按原含义保留。真实业务结果需要另做业务断言，不从模型名称、客户配置或任务编号推导。

```bash
pnpm test:agent
pnpm test:desktop
pnpm typecheck
```

数据库及真实 CLI/MCP 沙箱验收使用独立隔离数据库和本地执行器，实际回执记录源提交、运行角色、参数、退出码和摘要。签名、Windows 真机、付费模型及客户经营任务单独验收。
