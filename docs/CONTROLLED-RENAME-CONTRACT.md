# 受控改名器与差异保留同步契约（MC-008）

> 适用对象：`workloom-ai/WorkLoom-growthmatrix`（骇客帝国 · 隔离实验副本）
> 上游事实源：`workloom-ai/WorkLoom-growth`（本契约以 `2b2ff15` 为测量基线）
> 策略文件：`.workloom-rename-policy.json` ｜ 工具：`scripts/ci/controlled-rename.mjs`、`scripts/ci/verify-sync-contract.mjs`
> 门禁接入：`.cnb.yml` 静态门禁阶段「受控改名与同步契约」

## 1. 问题：为什么需要契约

本仓的同步方式是「把上游整仓覆盖过来，再把标识改成 growthmatrix」。这种方式带来三个可复现的故障：

| 故障 | 事实证据 | 后果 |
|---|---|---|
| 受控只读资产被改名流程改写 | `.workloom-base-sync.json#requiredRootAssetsSha256` 曾记录 34 项中 9 项摘要漂移（`docs/DEVELOPMENT-PROTOCOL.md`、`docs/REAL-DEVICE-ACCEPTANCE-SPEC.md`、`WORKLOOM_PRODUCT_CONTEXT.md` 等） | 舰队认知失真：本仓副本与基座原文冲突，且冲突无法从 git 追溯 |
| 自有改动被下一次整仓覆盖静默清零 | 上一轮 46 个受版本控制文件（节拍调度器、目标/指标事实源、行业规划器、内容日历、三岗、工具声明守护）不在任何「保留清单」里 | 施工成果丢失，且丢失无声 |
| 差异不可解释 | 上游 `2b2ff15` 与本仓 HEAD 之间有 141 处同名内容差异 + 105 处路径迁移，无清单说明哪些是改名、哪些是人为改动 | 无法审计，无法回滚，无法回答「这仓到底改过什么」 |

## 2. 三条硬纪律（代码强制）

1. **受控资产永不改内容**：命中 `requiredRootAssetsSha256` 的文件按上游原字节落盘，即使内容里出现待改名标识（`plan` 记为 `protected`）。
2. **已登记差异永不覆盖**：`declaredDiffs` 命中的目标文件保留本仓现有内容（`plan` 记为 `preserved`，`apply` 不动它）。
3. **未登记差异必须可见**：目标树里既非改名可达、又未登记的差异，一律计入 `unexplained`；同步操作（`--strict`）失败。

## 3. 策略文件结构

```jsonc
{
  "schema": "workloom.rename-policy/v1",
  "identity":  { "repository": "...growthmatrix", "upstreamRepository": ".../WorkLoom-growth", "upstreamRef": "2b2ff15" },
  "contract":  { "statement": "...", "protectedAssetsSource": ".workloom-base-sync.json#requiredRootAssetsSha256", "excludedPaths": [ "...": "不同步的目录" ] },
  "rules":     [ { "id": "content.*", "kind": "content", "match": "<正则>", "replace": "<替换>", "scope": ["**/*"], "evidence": "<依据>" },
                 { "id": "path.*",    "kind": "path",    "match": "<正则>", "replace": "<替换>" } ],
  "declaredDiffs": [ { "reason": "...", "task": "T-2026-0929-0001", "kind": "added|modified|removed", "paths": [ "..."] } ],
  "measuredBaseline": { "…": "实测覆盖率与复现命令" }
}
```

排除目录（`contract.excludedPaths`）只排除**同步面无关**的目录：`**/node_modules/**`、`.git/**`、`outputs/**`、`release/**`、`apps/*/dist/**`、`apps/*/build/**`、`packages/*/dist/**`、`services/*/dist/**`、`**/.next/**`、`**/coverage/**`、`**/*.tsbuildinfo`。
注意：`build/entitlements.mac*.plist` 是**受版本控制的构建输入**，因此不得用 `**/build/**` 这种粗排除（本契约已按实测修正）。

## 4. 改名规则与实测覆盖率

### 4.1 内容规则（6 条，按序应用，最长标识优先）

| 规则 id | 匹配 | 替换 | 说明 |
|---|---|---|---|
| `content.repo-slug-cnb` | `workloom-ai/WorkLoom-growth`（非 -matrix） | `workloom-ai/WorkLoom-growthmatrix` | CNB 仓 slug（含 `//cnb.cool/...` 与 GitHub 旧址引用） |
| `content.repo-slug-lower` | `workloom-ai/workloom-growth`（非 -matrix） | `workloom-ai/workloom-growthmatrix` | 小写形态引用 |
| `content.product-name` | `WorkLoom-growth`（非 -matrix） | `WorkLoom-growthmatrix` | 产品显示名 / 仓库标题 |
| `content.package-scope` | `workloom-ai-growth`（非 -matrix） | `workloom-ai-growthmatrix` | 包命名空间 |
| `content.package-name` | `workloom-growth`（非 -matrix） | `workloom-growthmatrix` | 包名、桌面发布 runner 标签、示例目录名 |
| `content.industry-bundle` | `geo-growth`（非 -matrix） | `geo-growthmatrix` | 行业包目录/标识；业务域词 `growth-lead`、`growth-review`、`id:"growth"` 不改 |

### 4.2 路径规则（3 条）

| 规则 id | 匹配 | 替换 | 覆盖 |
|---|---|---|---|
| `path.bundle-dir` | `(^|/)bundles/geo-growth/` | `$1bundles/geo-growthmatrix/` | 行业包目录 |
| `path.industry-and-bundle-ids` | `(^|/)geo-growth`（非 -matrix） | `$1geo-growthmatrix` | 其余行业标识路径段 |
| `path.package-dir` | `(^|/)workloom-growth`（非 -matrix） | `$1workloom-growthmatrix` | 包名目录、模板示例目录 |

### 4.3 实测覆盖率（基线 `2b2ff15` ↔ HEAD `8785761`）

| 指标 | 数值 | 说明 |
|---|---|---|
| 上游文件 | 2935 | `git ls-tree -r 2b2ff15` 全量 |
| 本仓文件 | 2949 | `git ls-tree -r HEAD` 全量 |
| 路径迁移文件 | 105 | 上游存在、本仓改名后存在的文件 |
| 路径迁移被规则复现 | 102 | 余 3 项为已登记差异（见 §5） |
| 同名内容差异 | 141 | 同路径但内容不同 |
| 同名差异被规则复现 | 117 | 余 24 项为已登记差异 |
| 逐字节一致 | 2715 | 无需任何改写的文件 |
| 不可复现差异 | **0** | `classify --strict` 退出码 0 |

复现命令（A 级证据，实测通过）：

```bash
# 取一份干净的上游树与本仓树后逐文件复算
git -C <workloom-growth 克隆> archive 2b2ff15 | tar -x -C /tmp/upstream
git -C <本仓克隆>          archive HEAD     | tar -x -C /tmp/target
node scripts/ci/controlled-rename.mjs classify --source /tmp/upstream --target /tmp/target --strict
# 输出：上游 2935 文件 → 可复现 2935/2935（逐字节一致 2715）
#       改名可复现 159 · 已登记差异 27 · 受控资产一致 34
#       未登记差异 0 · 受控漂移 0 · 缺文件 0 · 未登记新增 0
```

## 5. 差异保留登记（`declaredDiffs`）

当前登记 11 组、41 条路径（27 条修改 + 14 条新增），全部归属任务卡 `T-2026-0929-0001`：

| 组 | 内容 | 条数 |
|---|---|---|
| F-01 | 素材寻源岗移除未接线工具 `visualread.search_stock`，缺口显式登记进技能 | 2 |
| F-04 | 新增三岗（内容排期官 / 达人库管理员 / 成本核算员）+ 编制口径同步 | 1 |
| A 组 | 节拍调度器挂载、目标/指标 tRPC、行业规划器注册 | 5 |
| E-01 | OSS 清单与扫描状态刷新（生成器产物） | 4 |
| E-02 | C 端投影摘要重生成 | 1 |
| E-03 | 套件数据态自愈（开跑前自愈 + `try/finally`） | 1 |
| E-04 | 身份句纠正与站点旧品牌清理 | 3 |
| F-01/F-02 | 静态门禁新阶段、bundle 脚本、bgm 桥白名单补齐 | 3 |
| — | bundle 摘要与能力清单刷新 | 5 |
| — | 测试契约同步（行业包治理 / 围栏别名） | 2 |
| 新增 | 节拍调度器、目标与指标事实源、行业规划器、内容日历管线、三岗、工具声明守护 | 14 |

登记纪律：

- 新增**有意差异**（新文件、有意修改）必须同步在 `declaredDiffs` 登记，写明 `reason` 与 `task`；
- 登记项必须真实存在（`kind: removed` 除外），否则门禁报「登记指向不存在的文件」；
- 登记项不得与受控资产重叠（受控资产必须与上游逐字节一致，不存在「有意差异」）。

## 6. 受控资产（`protectedAssets`）

来源：`.workloom-base-sync.json#requiredRootAssetsSha256`——34 个整文件 + 1 个片段级（`AGENTS.md#managed-section`）。

- 校验：`node scripts/ci/verify-sync-contract.mjs` 逐项复算 sha256，漂移必须为 0；
- 语义：这些文件只在基座 `workloom-im` 修改，本仓只允许**原样保存**；
- 同步时即使内容里含 `geo-growth` / `WorkLoom-growth` 等标识，也不改写（宁可保留上游原句，也不制造认知失真）。

## 7. 同步操作手册

```bash
# 0) 准备：一份干净的上游工作树（例如 workloom-growth@<目标 sha> 的 checkout）
# 1) 生成同步计划（dry-run，不写盘；报告逐文件记录动作与命中规则）
node scripts/ci/controlled-rename.mjs plan --source <上游工作树> --target . --report outputs/sync/plan.json
# 2) 执行同步：受控资产原字节 / 已登记差异保留 / 其余按规则改写；不删除任何文件
node scripts/ci/controlled-rename.mjs apply --source <上游工作树> --target . --write --report outputs/sync/apply.json
# 3) 契约校验（同步操作必须带 --strict：未登记差异即失败）
node scripts/ci/verify-sync-contract.mjs --source <上游工作树> --strict --report outputs/sync/contract.json
# 4) 复核报告中的 preserved / staleTargets / declaredMissing，必要时补登记后再跑第 3 步
```

新增有意差异时，用分类器直接产出可粘贴的登记片段（按修改 / 新增 / 删除分组）：

```bash
node scripts/ci/controlled-rename.mjs classify --source <上游工作树> --target . \
  --snippet --snippet-task T-2026-0929-0002
# 输出 JSON 片段 → 粘贴进 .workloom-rename-policy.json#declaredDiffs → 重跑第 3 步
```

幂等性（实测）：对已同步树再次执行第 2 步，`diff -r` 逐字节差异为 **0**——即受控同步可重复执行且不会漂移。

## 8. 报告与判定

`workloom.rename-report/v1` 字段：`command`、`policy`、`sourceRoot`、`targetRoot`、`dryRun`、`stats`、`entries[]`（`sourcePath` / `targetPath` / `action` / `protected` / `binary` / `declared` / `rules`）、`staleTargets`、`declaredMissing`、`outcome`、`errors`、`warnings`。

动作语义：

| action | 含义 | apply 行为 |
|---|---|---|
| `protected` | 受控只读资产 | 按上游原字节写入（不改内容） |
| `preserved` | 已登记差异 | 保留本仓现有内容，不写 |
| `removed-declared` | 已登记删除 | 不写入（本仓有意不保留该上游文件） |
| `rewritten` | 内容命中改名规则 | 写改写后的内容 |
| `path-renamed` | 仅路径命中规则 | 写原内容到新路径 |
| `copied` | 无规则命中（含二进制） | 原字节写入 |

## 9. 边界（本契约不解决什么）

1. **不删除文件**：本仓存在、上游与登记都无法解释的文件只记 `staleTargets`，不自动删（删文件必须人工确认）。
2. **不做二进制改名**：含 NUL 字节的文件一律按字节复制（改名规则面向文本标识；对 PNG/字体/压缩包做正则替换会静默损坏资产）。
3. **不做跨仓公共化**：本契约只保证「本仓与上游的差异可解释」。公共根因仍按舰队纪律先在基座 `workloom-im` 修复，再经代码车道下发（本仓为隔离副本，不参与 fanout）。
4. **不替代 code review**：门禁只证明「差异被登记/可复现」，不判断差异本身是否正确。

## 10. 复现与验证清单

| 验证项 | 命令 | 期望 |
|---|---|---|
| 受控资产零漂移 | `node scripts/ci/verify-sync-contract.mjs` | 漂移 0 / 缺失 0 |
| 策略自洽 | 同上 | 规则错误 0 |
| 差异全登记 | `node scripts/ci/verify-sync-contract.mjs --source <上游> --strict` | 失败项 0 |
| 复现率 | `node scripts/ci/controlled-rename.mjs classify --source <上游> --target .` | `2935/2935`（基线快照） |
| 幂等 | `apply --write` 后 `diff -r` | 差异 0 |
| 单元回归 | `node --test scripts/ci/controlled-rename.test.mjs` | 18/18 通过 |
