# 通道声明排除（B-75）

> 依据：计划 v1.3 B-75「海外与视频号通道联调（TikTok/视频号真实账号；未就绪则转声明排除）」。
> 结论来源：`tsx scripts/channel-readiness.mts`（单一事实源 `packages/base/publish-rpa/readiness.ts`）。

## 当前声明

| 通道 | 状态 | 原因 | 触发条件（满足后解除） |
|---|---|---|---|
| TikTok | 声明排除 | 本机无海外真实账号会话与桥配置；选择器/风控指纹需真机标定 | 配置 `WORKLOOM_TIKTOK_BRIDGE_URL/TOKEN` 或 `WORKLOOM_TIKTOK_SESSION_DIR`，并在桌面包完成登录与一次真实发布回执样本 |
| 微信视频号 | 声明排除 | 视频号创作端无开放发布 API，需桌面 RPA 会话；本机未配置会话目录 | 配置 `WORKLOOM_SHIPINHAO_BRIDGE_URL/TOKEN` 或 `WORKLOOM_SHIPINHAO_SESSION_DIR`，完成登录与回执样本 |

## 纪律

1. 声明排除 = 未联调：这两条通道的 `loginCheck` 恒 false、`upload` 抛错，runner 一律转人工，不伪造回执。
2. 解除排除需要三件套：真实账号会话 + 至少一次真实发布回执（含 platformPostId/证据）+ 选择器标定记录。
3. `tsx scripts/channel-readiness.mts --strict` 在存在排除项时非 0；发布前检查若要求全通道就绪，必须移除排除项或书面豁免。
