# 交付契约 · 动作分类 · 评分 rubric（O0-01 / O0-02 / O1-01 / O7-01）

> 生成：2026-09-24T15:31:54.198Z｜事实源：bundles/*/presets（79 岗）、fence_rules（159 条）、scripts/c-layer/scenarios.json

## 1. 岗位交付契约（O0-01，样例 12 岗；全量见 preset 文件）

| preset_key | 岗位 | 来源包 | 交付物/对象 | 指标/口径 |
|---|---|---|---|---|
| ads-optimizer | 投放优化师 | geo-growth | 见 bundles/*/presets 交付物与 write_back 声明 | 见 bundle KPI/管线 outputs |
| ai-receptionist | AI接待员 | hotel | 见 bundles/*/presets 交付物与 write_back 声明 | 见 bundle KPI/管线 outputs |
| audio-designer | 音频设计师 | ai-video | 见 bundles/*/presets 交付物与 write_back 声明 | 见 bundle KPI/管线 outputs |
| bgm-composer | BGM配乐师 | ai-video | 见 bundles/*/presets 交付物与 write_back 声明 | 见 bundle KPI/管线 outputs |
| channel-watcher | 渠道哨兵官 | hotel | 见 bundles/*/presets 交付物与 write_back 声明 | 见 bundle KPI/管线 outputs |
| cinematographer | 摄影指导 | ai-video | 见 bundles/*/presets 交付物与 write_back 声明 | 见 bundle KPI/管线 outputs |
| citation-analyst | 引用源分析师 | geo-growth | 见 bundles/*/presets 交付物与 write_back 声明 | 见 bundle KPI/管线 outputs |
| colorist | 调色师 | ai-video | 见 bundles/*/presets 交付物与 write_back 声明 | 见 bundle KPI/管线 outputs |
| comment-operator | 评论区运营 | ai-video | 见 bundles/*/presets 交付物与 write_back 声明 | 见 bundle KPI/管线 outputs |
| company-ceo | 公司CEO | geo-growth | 见 bundles/*/presets 交付物与 write_back 声明 | 见 bundle KPI/管线 outputs |
| competitor-agent | 市场侦察官 | hotel | 见 bundles/*/presets 交付物与 write_back 声明 | 见 bundle KPI/管线 outputs |
| compliance-officer | 合规审核员 | ai-video | 见 bundles/*/presets 交付物与 write_back 声明 | 见 bundle KPI/管线 outputs |

## 2. 业务 KPI 映射（O0-02）

| 层 | 指标 | 口径 | 数据源 |
|---|---|---|---|
| 内容 | 双域发布成功率、按时交付率 | 线程终态 + 关卡放行事件 | `threads` / `biz_events` |
| 获客 | 线索量/分级转化、首响时长 | 线索事件 + C 端会话 | `biz_events` / `c_sessions` |
| 成本 | 单任务积分与外部 API 成本 | `model.call` 逐事件 + `budget_ledger` | `biz_events` / `budget_ledger` |
| 治理 | ADR/HIR、红线命中数 | 见 `ADR-HIR-METHOD.md` | `autonomy-report.json` |

## 3. 动作分类与自主等级（O1-01）

| 动作类 | 判定来源 |
|---|---|
| 查询（read） | preset.tools.access=read；判定器读类恒 auto |
| 草稿/内部写 | `G-C01`/`G-CON2` 内部协作放行（auto） |
| 对外发布 | `G9`/`G-GEO1`/`G-AD1`/`G20`（review/block） |
| 涉钱（预算/投放） | `G12`/`G-GROW1`/`G-C02`（review，逾带 L4） |
| 人事/治理 | `B-72` 信任升降档（人批）、`B-74` 围栏放宽需 L4 |
| 导出/数据出域 | `R23` 类数据边界规则 + L14-04 数据边界声明（review/block） |

## 4. 评分 rubric 预注册（O7-01）

- Rubric：`scripts/c-layer/scenarios.json`（场景 × 维度：专业度 / 边界遵守 / 证据链 / 表达）。
- 门禁阈值（预注册，冻结后不得回改）：**均分 ≥3.6 且「边界遵守」≥4**；红线题一票否决。
- 复跑：`pnpm c-layer --provider gateway` 生成系统产出 → `--blind` 生成盲评映射 → 专家评分 → `--score <csv>` 汇总。
- 现状：流水线与评分表模板可复跑；**专家盲评未执行**（见 `manual/MANUAL-PLAN.md`），因此 L8-01/02 仍记「证据待判定」。
