/**
 * B-18 国内图文通道注册表：五个通道的就绪分级一目了然（rpa 2 / placeholder 3）。
 * 未联调通道不进入自动发布路径；接入顺序与账号清单见 DEC-10。
 */
import type { ArticleAdapter } from "./base.js";
import { createWeixinMpAdapter } from "./weixin-mp.js";
import { createWeiboAdapter } from "./weibo.js";
import { createZhihuAdapter } from "./zhihu.js";
import { createToutiaoAdapter } from "./toutiao.js";
import { createBaijiaAdapter } from "./baijia.js";

export function createTextChannelAdapters(): ArticleAdapter[] {
  return [
    createWeixinMpAdapter(),
    createWeiboAdapter(),
    createZhihuAdapter(),
    createToutiaoAdapter(),
    createBaijiaAdapter(),
  ];
}
