-- 0041_publish_text_channels.sql · B-18 五类国内图文通道
-- 只增不改：把 publish_tasks.platform 的 CHECK 从六视频平台扩展到「六视频 + 五图文」，
-- 与 packages/base/publish-rpa/types.ts#PlatformSchema 保持同源；历史行不受影响。
ALTER TABLE publish_tasks DROP CONSTRAINT IF EXISTS publish_tasks_platform_check;
ALTER TABLE publish_tasks ADD CONSTRAINT publish_tasks_platform_check
  CHECK (platform IN (
    'douyin', 'tiktok', 'xiaohongshu', 'shipinhao', 'bilibili', 'youtube',
    'wechat-mp', 'weibo', 'zhihu', 'toutiao', 'baijia'
  ));
