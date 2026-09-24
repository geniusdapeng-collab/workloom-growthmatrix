// workloom-fence · dsh 插件挂载点（B8/D12；B0 hello-fence 的正式版）
// 形态：Cordis 函数插件，挂 tools/pre-execute 瀑布 → 转发 WorkLoom fence-engine 判定
// 挂载方式（profile cordis.patch.yml）：
//   - insert:
//       - id: workloom-fence
//         name: '@workloom/runtime/plugins/workloom-fence.plugin.js'
//         config:
//           rulesUrl: 'http://localhost:8787/trpc/fence.activeRules'   # 生效规则拉取端
//           rulesToken: '<member JWT>'                                  # 可选：受保护端点需带凭据
//           rulesFile: '/abs/path/fence-rules.json'                     # 可选：离线/无网时直接读规则文件（优先于 URL）
// 判定语义（与围栏包头部口径一致）：block > review > auto；求值异常按 block（E2.1）；
// 未声明 fence_bindings 的调用方禁写（F2.10）由网关段①复查，此处只管瀑布判定。
//
// 2026-09-24 修复（P 域实测）：规则源 404 / 非数组时，旧实现直接把错误对象当数组迭代，
// 抛 `rules is not iterable` —— 结果是**整个工具层不可用**（模型连 read_image 都调不动），
// 而且没有任何围栏结论留痕。现在：规则源不可用 → fail-closed 明确拒绝工具执行（先围栏后动作），
// 并把原因写进拒绝理由；同时支持 rulesFile / rulesToken 两种装配方式。

import { readFileSync } from 'node:fs'

export const name = 'workloom-fence'

const LEVEL_RANK = { auto: 0, review: 1, block: 2 }

export function apply(ctx, config = {}) {
  let cachedRules = null
  let cachedAt = 0
  let lastError = null

  function readRulesFile(file) {
    const parsed = JSON.parse(readFileSync(file, 'utf-8'))
    if (!Array.isArray(parsed)) throw new Error(`规则文件不是数组：${file}`)
    return parsed
  }

  async function activeRules() {
    // 10s 缓存（演示口径；生产经 dsh 事件失效）
    if (cachedRules && Date.now() - cachedAt < 10_000) return cachedRules
    try {
      if (config.rulesFile) {
        cachedRules = readRulesFile(config.rulesFile)
      } else if (config.rulesUrl) {
        const headers = config.rulesToken ? { authorization: `Bearer ${config.rulesToken}` } : {}
        const res = await fetch(config.rulesUrl, { headers })
        if (!res.ok) throw new Error(`规则端点 HTTP ${res.status}`)
        const body = await res.json()
        // tRPC 包装：{ result: { data: [...] } }；纯 REST 则直接是数组
        const rules = Array.isArray(body) ? body : body?.result?.data
        if (!Array.isArray(rules)) throw new Error('规则端点返回非数组（tRPC 包装或错误体）')
        cachedRules = rules
      } else {
        cachedRules = []
      }
      cachedAt = Date.now()
      lastError = null
      return cachedRules
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
      console.error(`[workloom-fence] 规则源不可用（fail-closed）：${lastError}`)
      return null // 交给调用方按"围栏不可用 → 拒绝工具执行"处理
    }
  }

  ctx.on('tools/pre-execute', async (exec, next) => {
    const toolName = exec?.name ?? exec?.tool?.name ?? ''
    const rules = await activeRules()
    if (rules === null) {
      // 先围栏后动作：规则拿不到就不放行动作（宁可拒绝，也不无围栏执行）
      return { kind: 'deny', reason: `WorkLoom 围栏规则源不可用（fail-closed）：${lastError ?? 'unknown'}` }
    }
    // 简化判定：规则 actions 命中工具名前缀（完整 DSL 求值在 fence-engine 服务侧，B8 接线）
    let level = 'auto'
    for (const r of rules) {
      const actions = r?.match?.actions ?? r?.actions ?? []
      if (actions.some((a) => toolName.startsWith(a.split('.')[0]))) {
        if (LEVEL_RANK[r.level] > LEVEL_RANK[level]) level = r.level
      }
    }
    console.log(`[workloom-fence] judge tool=${toolName} level=${level}（deny 优先并集 E2.2）`)
    if (level === 'block') return { kind: 'deny', reason: 'WorkLoom 围栏熔断（E2.2 deny 优先）' }
    if (level === 'review') return { kind: 'ask', reason: 'WorkLoom 围栏挂起必审（F2.1）' }
    return next()
  })
  console.log('[workloom-fence] mounted · 围栏瀑布已挂入 dsh 工具执行流水线')
}
