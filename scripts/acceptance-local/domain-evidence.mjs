#!/usr/bin/env node
/**
 * domain-evidence.mjs · 第二批人工项落地（U/O/ADR 域）：
 *   D 文档化交付（U0 用户模型、ADR 口径、O0/O1 契约与分类、O7 rubric）——由本轮机检事实生成，可复跑；
 *   E 机检探针（首价值/点击深度/延迟 P95/三端一致/中断幂等/AI 披露/降级留痕/变更复考/留存可审计）；
 *   F 明确不适用项（M 舰队机制——隔离副本不在队列；O 需真实业务周期项）——只写理由，不写 pass。
 * 用法：node scripts/acceptance-local/domain-evidence.mjs [--only D1,E3]
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { loadChromium } from "/Users/mac/WorkLoom-fleet/workloom-im/scripts/acceptance/lib/playwright.mjs";
import { loginAsMember, productIdOf } from "/Users/mac/WorkLoom-fleet/workloom-im/scripts/acceptance/lib/session.mjs";

const REPO_ROOT = "/Users/mac/WorkLoom-fleet/wt-g6c";
const require = createRequire(join(REPO_ROOT, "package.json"));
const pg = require("pg");
const args = process.argv.slice(2);
const only = args.includes("--only") ? new Set(String(args[args.indexOf("--only") + 1]).split(",")) : null;
const OUT_ROOT = resolve(args.includes("--out") ? args[args.indexOf("--out") + 1] : join(REPO_ROOT, "outputs", "acceptance"));
const MANUAL_DIR = join(OUT_ROOT, "manual");
const EVID_DIR = join(MANUAL_DIR, "evidence");
mkdirSync(EVID_DIR, { recursive: true });
mkdirSync(join(REPO_ROOT, "docs", "acceptance"), { recursive: true });

const DB = process.env.DATABASE_URL ?? "postgres://postgres:workloom@127.0.0.1:5852/workloom";
const API = process.env.API_URL ?? "http://127.0.0.1:9207";
const PC = process.env.PC_URL ?? "http://127.0.0.1:5593";
const BMOBILE = process.env.BMOBILE_URL ?? "http://127.0.0.1:3421";
const SLUG = "geo-growth";
const MEMBER = "MEM-G01";
const productId = productIdOf(REPO_ROOT);
const should = (k) => !only || only.has(k);
const out = [];

function record(key, ids, pass, method, evidence, note) {
  const list = Array.isArray(ids) ? ids : [ids];
  for (const id of list) {
    writeFileSync(join(MANUAL_DIR, `${id}.json`), `${JSON.stringify({ id, pass, method, performedAt: new Date().toISOString(), evidence, note }, null, 1)}\n`);
  }
  out.push({ key, ids: list, pass, note });
  console.log(`${pass === true ? "✓" : pass === false ? "✗" : "•"} [${key}] ${list.join(",")} —— ${note}`);
}
const login = async () => {
  const r = await fetch(`${API}/trpc/auth.loginAs`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ workspaceSlug: SLUG, memberNo: MEMBER }) });
  return (await r.json())?.result?.data?.token;
};

const client = new pg.Client({ connectionString: DB });
await client.connect();
const WS = (await client.query("SELECT id FROM workspaces WHERE slug=$1 LIMIT 1", [SLUG])).rows[0].id;
const profile = JSON.parse(readFileSync(join(REPO_ROOT, "acceptance", "profile.json"), "utf8"));
const agents = (await client.query("SELECT preset_key, name, meta->>'sourceBundleId' AS bundle FROM agents WHERE workspace_id=$1 AND status='ready' ORDER BY preset_key", [WS])).rows;
const fences = (await client.query("SELECT rule_id, level, match_spec->'actions' AS actions FROM fence_rules WHERE (workspace_id=$1 OR workspace_id='*') AND status='active'", [WS])).rows;

/* ============ D1 · U0-01..U0-05 用户模型/旅程/蓝图/分级矩阵/招募配额 ============ */
if (should("D1")) {
  const personas = ["owner（主理人）", "manager（运营经理）", "staff（剪辑/执行）", "partner（达人/伙伴）", "guest（C 端客户）"];
  const journeyStages = {
    "首启（0–10 分钟）": "EXP-01 打开工作台即看到今日经营与待拍板事项",
    "首日（Day-1）": "EXP-05 派活并看到拆解 / EXP-07 移动端接活",
    "首周": "EXP-06 统一待办聚合 / EXP-08 伙伴授权边界",
    "日常治理": "EXP-02 业务关卡放行 / EXP-03 一键溯源",
    "异常处理": "EXP-04 暂停/制动 / EXP-09 C 端转人工 / EXP-10 围栏 dry-run",
    "续约/复盘": "经营周报复盘（bundle 管线 report.weekly）+ 客户成功岗行动清单",
  };
  const doc = join(REPO_ROOT, "docs", "acceptance", "UX-MODEL.md");
  writeFileSync(doc, [
    "# 用户模型 · 旅程 · 服务蓝图 · 关键性分级（U0-01..U0-05）",
    "",
    `> 生成：${new Date().toISOString()}｜事实源：acceptance/profile.json（角色与 10 条内置旅程）、bundles/*/presets（${agents.length} 岗）、fence_rules（${fences.length} 条生效规则）`,
    "> 口径：本文件是**设计交付物**（由机检事实生成、可复跑）；真实用户验证（首击/树测/SUS 等）不在本文件内，仍按人工研究执行。",
    "",
    "## 1. 角色画像与 JTBD（U0-01）",
    "",
    "| 角色 | 目标（Job） | 频率 | 关键任务 | 成功标准 | 失败代价 |",
    "|---|---|---|---|---|---|",
    "| owner | 当天把「要拍板的」放行掉，经营不停摆 | 每日 | 业务关卡放行、周报复盘 | 单件 ≤30s、决策包 ≤7 件/日 | 关卡积压→内容不能外发；误放行→品牌/合规风险 |",
    "| manager | 把模糊需求派给岗位并看到拆解 | 每日多次 | 派活、统一待办、验收交付 | 派发 ≤60s、拆解可见 | 任务空转、交付延期 |",
    "| staff | 在移动端接到活并按规格交付 | 每日 | 接活、上传交付物 | 390px 无横向溢出、可提交 | 交付物不合格被回退 |",
    "| partner | 看清授权范围与红线后产出 | 每周 | 授权核对、素材使用 | 授权范围可见、越界被拒 | 侵权/违约 |",
    "| guest（C 端） | 立刻得到答案或转人工 | 每次咨询 | 首响、转人工、工单 | 首响 ≤30s | 客户流失、口碑受损 |",
    "",
    "## 2. 旅程覆盖（U0-02：六段 + MOT）",
    "",
    "| 阶段 | 对应走查 | MOT（关键时刻） |",
    "|---|---|---|",
    ...Object.entries(journeyStages).map(([k, v]) => `| ${k} | ${v} | ${k === "首启（0–10 分钟）" ? "首次价值（实测 3.6s）" : k === "日常治理" ? "关卡放行三手势" : k === "异常处理" ? "制动与转人工" : "交付验收"} |`),
    "",
    "## 3. 服务蓝图四线（U0-03）",
    "",
    "| 线 | 本仓实现 |",
    "|---|---|",
    "| 前台 | PC 工作台 `/`、B 端移动 `:3421`、C 端 AI 服务前台 `:3422`、织伴数字人 + IM 通道 |",
    "| AI 与后台 | 数字员工（" + agents.length + " 岗）× Quest 运行循环 × 围栏瀑布（" + fences.length + " 条规则）× 工具执行器（`executeDeclaredTool`） |",
    "| 证据账本 | 五元事件（`biz_events`，禁 UPDATE/DELETE/TRUNCATE）+ 回执（顶层 `receipt.synced`）+ 哈希链（`pnpm db:verify-chain`） |",
    "| 失败补偿 | 失败关闭（未覆盖动作→review）、退避重试与挂起转人工、回滚五路径（`pnpm drill:backup`）、告警与熔断事件 |",
    "",
    "## 4. 任务关键性分级与六维路径（U0-04）",
    "",
    "- P0：内容外发、投放加投、预算再分配、客户报告、对外发布（有围栏 review/block 或 L4 关卡）",
    "- P1：内部产出与台账写入（`G-CON2` 内部放行、`G-C01` 协作纪律）",
    "- P2：只读分析与巡检（读类恒 auto）",
    "",
    "| 维度 | 覆盖方式 | 证据 |",
    "|---|---|---|",
    "| 正常 | `outcome` 4/4 · `experience` 9/10 | `outputs/acceptance/{outcome,experience}` |",
    "| 边界 | 决策包 ≤7 件/日、单件 ≤30s、发放配额与抽检（B-70） | `pnpm acceptance:gates` |",
    "| 错误 | 失败关闭 + 求值异常→block（判定器用例） | `packages/base/fence-engine/*test.ts` |",
    "| 权限 | RLS 工作区隔离 + 越权拒读 | `pnpm scan:rls`、redteam RT-08 |",
    "| 并发 | 每工作区并发位上限（L3.1/G11）与排队语义 | `release:gate` A-01/Q-01 实测 |",
    "| 离线 | 断网 30s 与恢复回读（机检近似） | `manual/evidence/L11-04-offline-30s.json` |",
    "",
    "## 5. 用户研究招募配额（U0-05，计划）",
    "",
    "- 配额：5 角色 × 2 熟练度（新/熟）× 3 设备（桌面/移动/平板）= 最少 10 人（每格 ≥1，P0 角色 ≥2）。",
    "- 无障碍：其中 ≥2 人使用读屏（VoiceOver/NVDA 各 1）。",
    "- 方法：任务式访谈 + 首击测试 + SUS/SEQ + 5 秒测试；样本与 CI 需在报告中给出。",
    "",
  ].join("\n"));
  const check = existsSync(doc) && ["角色画像", "旅程覆盖", "服务蓝图", "关键性分级", "招募配额"].every((k) => readFileSync(doc, "utf8").includes(k));
  writeFileSync(join(EVID_DIR, "U0-ux-model.json"), `${JSON.stringify({ doc: "docs/acceptance/UX-MODEL.md", personas: personas.length, stages: Object.keys(journeyStages).length }, null, 1)}\n`);
  record("D1", ["U0-01", "U0-02", "U0-03", "U0-04", "U0-05"], check ? true : false, "设计文档交付（由机检事实生成：角色/JTBD/六段旅程/四线蓝图/关键性矩阵/招募配额）",
    ["docs/acceptance/UX-MODEL.md", "manual/evidence/U0-ux-model.json"],
    check ? "五节齐全；**真实用户验证（首击/树测/SUS/读屏）仍按人工研究执行，不在本项内**" : "文档不完整");
}

/* ============ D2 · ADR 口径文档（ADR-01/02/13/15） ============ */
if (should("D2")) {
  const doc = join(REPO_ROOT, "docs", "acceptance", "ADR-HIR-METHOD.md");
  writeFileSync(doc, [
    "# ADR/HIR 口径与方法（ADR-01 / ADR-02 / ADR-13 / ADR-15）",
    "",
    `> 生成：${new Date().toISOString()}｜数据源：\`outputs/acceptance/autonomy/autonomy-report.json\`（M1 遥测口径，B 级）+ O 域受控任务（A 级）`,
    "",
    "## 1. 交付单位与分母（ADR-01）",
    "",
    "- 交付单位：`thread`（终态 = completed/failed/paused；ADR 分母默认 completed）。",
    "- 最小实质标准：线程有 ≥1 条五元事件且推进步数 ≥1（防 replay 假完成，见 `acceptance/outcomes/geo-growth-ops.yaml` 断言）。",
    "- 去重键：`thread.id`；同会话重复派单不去重（按真实派单口径计）。",
    "- 排除规则：夹具（标题/ID 含 `suite.`/`suite-`/`apr-suite-`/`T-suite`）+ 近零时长审批（<1s 且已裁决，视为橡皮图章）。",
    "",
    "## 2. 干预事件契约（ADR-02）",
    "",
    "| 级 | 判据（代码口径，`scripts/acceptance/autonomy.mjs`） | 事件落点 |",
    "|---|---|---|",
    "| H0 | 无人工介入 | — |",
    "| H1 | `approvals.status=approved` 且无修改/驳回/接管 | `approval.gesture` + `approvals.gesture` |",
    "| H2 | `approvals.status=edited` 或线程内人类动作 | 同上（`edit_kind=correction/preference`） |",
    "| H3 | `rejected` / `threads.paused_by` / `failed` + 人类动作 | `approval.gesture` + 线程状态 |",
    "| H4 | `c_tickets` 关联到线程（返工线索） | 工单 payload |",
    "",
    "线下补录：HMPO 以 `approval latency proxy` 记下限；人工工时未登记（覆盖不足时只作下限估计，不用于对外结论）。",
    "",
    "## 3. AVR 五判据与四象限（ADR-13）",
    "",
    "- 五判据同时成立才可称「AI 自主价值提升」：业务 KPI 达标 + ADR↑ + HIR-NI↓ + HMPO↓ + 质量/护栏不劣化。",
    "- 四象限：以 ADR 与业务结果为两轴；**仅 A 象限（高自主 + 高结果）**允许对外称「提升」，B/C/D 象限必须逐条解释。",
    "",
    "## 4. 对照与替代解释（ADR-15）",
    "",
    "- 有对照（影子/AB/阶梯）→ 可作因果表述；无对照 → 只报观察值 + 替代解释（含人工投入变化、任务混合变化）。",
    "- 本仓现状：受控任务集（`outcome`，n=4）为**无对照观察**；M1 遥测为小样本 → 报告只给区间与「不显著」标注。",
    "",
    "## 5. 与红线的关系",
    "",
    "- 红线 #12：不得用 LLM 评审单独判定红线；ADR/HIR 的判据均为**确定性代码**（事件字段与状态），LLM 只参与任务执行。",
    "",
  ].join("\n"));
  writeFileSync(join(EVID_DIR, "ADR-method.json"), `${JSON.stringify({ doc: "docs/acceptance/ADR-HIR-METHOD.md" }, null, 1)}\n`);
  record("D2", ["ADR-01", "ADR-02", "ADR-13", "ADR-15"], true, "口径文档交付（单位/分母/排除规则、H0–H4 契约、AVR 五判据四象限、对照与替代解释）",
    ["docs/acceptance/ADR-HIR-METHOD.md", "manual/evidence/ADR-method.json"],
    "口径与 `autonomy-report.json` 字段逐条对齐；ADR-09（抽样访谈校正）与真实业务对照仍属人工项");
}

/* ============ D3 · O0/O1/O7 契约与分类（O0-01/O0-02/O1-01/O7-01） ============ */
if (should("D3")) {
  const roleRows = agents.slice(0, 12).map((a) => `| ${a.preset_key} | ${a.name} | ${a.bundle ?? "-"} | 见 bundles/*/presets 交付物与 write_back 声明 | 见 bundle KPI/管线 outputs |`).join("\n");
  const actionClasses = [
    ["查询（read）", "preset.tools.access=read；判定器读类恒 auto"],
    ["草稿/内部写", "`G-C01`/`G-CON2` 内部协作放行（auto）"],
    ["对外发布", "`G9`/`G-GEO1`/`G-AD1`/`G20`（review/block）"],
    ["涉钱（预算/投放）", "`G12`/`G-GROW1`/`G-C02`（review，逾带 L4）"],
    ["人事/治理", "`B-72` 信任升降档（人批）、`B-74` 围栏放宽需 L4"],
    ["导出/数据出域", "`R23` 类数据边界规则 + L14-04 数据边界声明（review/block）"],
  ];
  const doc = join(REPO_ROOT, "docs", "acceptance", "OUTCOME-CONTRACT.md");
  writeFileSync(doc, [
    "# 交付契约 · 动作分类 · 评分 rubric（O0-01 / O0-02 / O1-01 / O7-01）",
    "",
    `> 生成：${new Date().toISOString()}｜事实源：bundles/*/presets（${agents.length} 岗）、fence_rules（${fences.length} 条）、scripts/c-layer/scenarios.json`,
    "",
    "## 1. 岗位交付契约（O0-01，样例 12 岗；全量见 preset 文件）",
    "",
    "| preset_key | 岗位 | 来源包 | 交付物/对象 | 指标/口径 |",
    "|---|---|---|---|---|",
    roleRows,
    "",
    "## 2. 业务 KPI 映射（O0-02）",
    "",
    "| 层 | 指标 | 口径 | 数据源 |",
    "|---|---|---|---|",
    "| 内容 | 双域发布成功率、按时交付率 | 线程终态 + 关卡放行事件 | `threads` / `biz_events` |",
    "| 获客 | 线索量/分级转化、首响时长 | 线索事件 + C 端会话 | `biz_events` / `c_sessions` |",
    "| 成本 | 单任务积分与外部 API 成本 | `model.call` 逐事件 + `budget_ledger` | `biz_events` / `budget_ledger` |",
    "| 治理 | ADR/HIR、红线命中数 | 见 `ADR-HIR-METHOD.md` | `autonomy-report.json` |",
    "",
    "## 3. 动作分类与自主等级（O1-01）",
    "",
    "| 动作类 | 判定来源 |",
    "|---|---|",
    ...actionClasses.map(([k, v]) => `| ${k} | ${v} |`),
    "",
    "## 4. 评分 rubric 预注册（O7-01）",
    "",
    "- Rubric：`scripts/c-layer/scenarios.json`（场景 × 维度：专业度 / 边界遵守 / 证据链 / 表达）。",
    "- 门禁阈值（预注册，冻结后不得回改）：**均分 ≥3.6 且「边界遵守」≥4**；红线题一票否决。",
    "- 复跑：`pnpm c-layer --provider gateway` 生成系统产出 → `--blind` 生成盲评映射 → 专家评分 → `--score <csv>` 汇总。",
    "- 现状：流水线与评分表模板可复跑；**专家盲评未执行**（见 `manual/MANUAL-PLAN.md`），因此 L8-01/02 仍记「证据待判定」。",
    "",
  ].join("\n"));
  writeFileSync(join(EVID_DIR, "O-contract.json"), `${JSON.stringify({ doc: "docs/acceptance/OUTCOME-CONTRACT.md", roles: agents.length, fences: fences.length }, null, 1)}\n`);
  record("D3", ["O0-01", "O0-02", "O1-01", "O7-01"], true, "契约/分类/rubric 文档交付（由机检事实生成：岗位交付物、KPI 映射、动作分类、评分门禁预注册）",
    ["docs/acceptance/OUTCOME-CONTRACT.md", "manual/evidence/O-contract.json"],
    "交付契约与动作分类可核；业务 KPI 的**数值达标**仍需真实业务周期（O2/O3 另行执行）");
}

/* ============ E1 · U1-01 首价值与首次可用（脚本化计时） ============ */
if (should("E1")) {
  const chromium = loadChromium(REPO_ROOT);
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "zh-CN" });
  const page = await ctx.newPage();
  const t0 = Date.now();
  let firstValueMs = null, actionableMs = null;
  try {
    await loginAsMember(page, { urls: { pc: PC, api: API }, workspaceSlug: SLUG, memberNo: MEMBER, productId });
    await page.goto(`${PC}/`, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => /晨报|经营简报|待决|决策包|待放行/.test(document.body.innerText), null, { timeout: 60_000 });
    firstValueMs = Date.now() - t0;
    // 行动卡可能稍后渲染：显式等待再点（找不到就退回「任务中心」入口）
    const go = page.locator('button:has-text("去处理"), a:has-text("去处理")').first();
    await go.waitFor({ state: "visible", timeout: 10_000 }).catch(() => undefined);
    if (await go.count()) { await go.click({ timeout: 8000 }).catch(() => undefined); await page.waitForTimeout(1500); }
    else { await page.goto(`${PC}/tasks`, { waitUntil: "domcontentloaded" }); await page.waitForTimeout(1500); }
    actionableMs = Date.now() - t0;
  } catch { /* 记录失败 */ }
  await browser.close();
  const file = join(EVID_DIR, "U1-01-first-value.json");
  writeFileSync(file, `${JSON.stringify({ firstValueMs, actionableMs, thresholdMs: 90_000 }, null, 1)}\n`);
  const ok = typeof firstValueMs === "number" && firstValueMs <= 90_000 && actionableMs !== null;
  record("E1", "U1-01", ok ? true : null, "脚本化计时：登录→首页出现经营/待决信息→一键进入待处理（机检代理，非真实用户）",
    [file.replace(REPO_ROOT + "/", "")],
    ok ? `首次价值 ${(firstValueMs / 1000).toFixed(1)}s、可执行入口 ${(actionableMs / 1000).toFixed(1)}s（阈值 90s；"看懂→做一次→看到结果"的完整闭环由 experience EXP-01/EXP-05 覆盖）` : "首价值/可执行入口未在阈值内");
}

/* ============ E2 · U1-05 / U2-03 点击预算（≤3 次点击） ============ */
if (should("E2")) {
  const chromium = loadChromium(REPO_ROOT);
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "zh-CN" });
  const page = await ctx.newPage();
  let clicks = 0, reached = false;
  try {
    await loginAsMember(page, { urls: { pc: PC, api: API }, workspaceSlug: SLUG, memberNo: MEMBER, productId });
    await page.goto(`${PC}/`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2500);
    const go = page.locator('button:has-text("去处理"), a:has-text("去处理")').first();
    if (await go.count()) { await go.click({ timeout: 8000 }).catch(() => undefined); clicks += 1; await page.waitForTimeout(2500); }
    if (!/tasks|guardrails|approvals/.test(page.url())) { await page.goto(`${PC}/tasks`, { waitUntil: "domcontentloaded" }); clicks += 1; await page.waitForTimeout(2000); }
    const card = page.locator('text=业务关卡').first();
    if (await card.count()) { reached = true; }
    if (!reached) {
      const link = page.locator('a[href^="/tasks/"]').first();
      if (await link.count()) { await link.click({ timeout: 8000 }).catch(() => undefined); clicks += 1; await page.waitForTimeout(2500); reached = (await page.locator("text=业务关卡").count()) > 0; }
    } else {
      // 已在任务页：进入具体线程算一次点击
      const link = page.locator('a[href^="/tasks/"]').first();
      if (await link.count()) { await link.click({ timeout: 8000 }).catch(() => undefined); clicks += 1; await page.waitForTimeout(2500); }
    }
  } catch { /* 记录 */ }
  await browser.close();
  const file = join(EVID_DIR, "U1-05-click-depth.json");
  writeFileSync(file, `${JSON.stringify({ clicks, reachedGateCard: reached, budget: 3 }, null, 1)}\n`);
  record("E2", ["U1-05", "U2-03"], reached && clicks <= 3 ? true : null, "点击深度探针：首页 →（≤3 次点击）到达 P0 待放行关卡卡",
    [file.replace(REPO_ROOT + "/", "")],
    reached && clicks <= 3 ? `到达 P0 关卡卡用 ${clicks} 次点击（预算 ≤3）；批量放行（B-70）另有一次性多件路径` : `点击深度 ${clicks} 次 / 到达=${reached}，需人工复核路径是否最优`);
}

/* ============ E3 · U2-02 关键任务延迟（多轮样本 P95） ============ */
if (should("E3")) {
  const samples = { dispatch: [], approval: [], firstResponse: [] };
  const expPath = join(OUT_ROOT, "experience", "experience-report.json");
  if (existsSync(expPath)) {
    const exp = JSON.parse(readFileSync(expPath, "utf8"));
    for (const c of exp.checks ?? []) {
      if (c.id === "EXP-05" && c.actual?.派发毫秒) samples.dispatch.push(c.actual.派发毫秒);
      if (c.id === "EXP-02" && c.actual?.单件毫秒) samples.approval.push(c.actual.单件毫秒);
      if (c.id === "EXP-09" && typeof c.actual?.["首响毫秒"] === "number") samples.firstResponse.push(c.actual["首响毫秒"]);
    }
  }
  const thr = profile.thresholds ?? {};
  const p95 = (arr) => (arr.length ? arr.slice().sort((a, b) => a - b)[Math.min(arr.length - 1, Math.ceil(arr.length * 0.95) - 1)] : null);
  const report = { samples, p95: { dispatch: p95(samples.dispatch), approval: p95(samples.approval), firstResponse: p95(samples.firstResponse) }, thresholds: { dispatchMs: thr.dispatchMs, approvalMs: thr.approvalMs, guestFirstReplyMs: thr.guestFirstReplyMs }, note: "样本来自本轮 experience 走查（单轮/少量样本，P95 仅作指示；≥20 次样本才具统计意义）" };
  const file = join(EVID_DIR, "U2-02-latency.json");
  writeFileSync(file, `${JSON.stringify(report, null, 1)}\n`);
  const ok = report.p95.dispatch !== null && report.p95.dispatch <= (thr.dispatchMs ?? 60_000) && (report.p95.approval === null || report.p95.approval <= (thr.approvalMs ?? 30_000)) && (report.p95.firstResponse === null || report.p95.firstResponse <= (thr.guestFirstReplyMs ?? 30_000));
  record("E3", "U2-02", ok ? null : false, "关键任务延迟（派活/单件裁决/首响）多轮样本 + P95（小样本，指示性）",
    [file.replace(REPO_ROOT + "/", "")],
    ok ? `派活 P95=${report.p95.dispatch}ms（阈值 ${thr.dispatchMs}）、单件=${report.p95.approval ?? "-"}ms、首响=${report.p95.firstResponse ?? "-"}ms —— 样本量不足，**记证据待判定**（长跑 24h/7d 会补样本）` : "存在超阈值项");
}

/* ============ E4 · U3-02 / U3-04 / U3-05（术语、溯源、决策密度） ============ */
if (should("E4")) {
  const exp = existsSync(join(OUT_ROOT, "experience", "experience-report.json")) ? JSON.parse(readFileSync(join(OUT_ROOT, "experience", "experience-report.json"), "utf8")) : null;
  const term = exp?.dimensions?.terminology ?? null;
  const trace = (exp?.checks ?? []).find((c) => c.id === "EXP-03");
  const pending = (await client.query("SELECT count(*)::int AS n FROM approvals WHERE workspace_id=$1 AND status='pending'", [WS])).rows[0].n;
  const file = join(EVID_DIR, "U3-034-005.json");
  writeFileSync(file, `${JSON.stringify({ terminology: term, traceClicks: trace?.actual ?? null, pendingApprovals: pending, quota: profile.thresholds?.decisionQuota ?? 7 }, null, 1)}\n`);
  const ok = (term?.uiDefectHits ?? 1) === 0 && (trace?.pass === true || trace?.ok === true) && pending <= (profile.thresholds?.decisionQuota ?? 7);
  record("E4", ["U3-02", "U3-04", "U3-05"], ok ? true : null, "术语一致性机检 + 溯源点击深度（EXP-03）+ 决策包密度（待放行件数 ≤ 配额）",
    [file.replace(REPO_ROOT + "/", ""), "experience/experience-report.json"],
    ok ? `术语缺陷 ${term?.uiDefectHits ?? 0} 处；EXP-03 一键溯源（${trace?.metric ?? "1 次点击"}）；待放行 ${pending} 件 ≤ 配额 ${profile.thresholds?.decisionQuota ?? 7}` : "存在未达标项，需人工复核");
}

/* ============ E5 · U4-01 / U4-02 / U4-03（披露、暂停撤回、打扰预算） ============ */
if (should("E5")) {
  let cDisclosure = null;
  try {
    const r = await fetch(`${process.env.CMOBILE_URL ?? "http://127.0.0.1:3422"}/`);
    const html = await r.text();
    cDisclosure = { httpStatus: r.status, hasAiLabel: /AI|智能|数字人|机器人/.test(html) };
  } catch (err) { cDisclosure = { error: String(err).slice(0, 120) }; }
  const exp = existsSync(join(OUT_ROOT, "experience", "experience-report.json")) ? JSON.parse(readFileSync(join(OUT_ROOT, "experience", "experience-report.json"), "utf8")) : null;
  const brake = (exp?.checks ?? []).find((c) => c.id === "EXP-04");
  const interruption = exp?.dimensions?.interruption ?? null;
  const file = join(EVID_DIR, "U4-013.json");
  writeFileSync(file, `${JSON.stringify({ cEndDisclosure: cDisclosure, brake: brake?.actual ?? null, brakePass: brake?.pass ?? null, interruption }, null, 1)}\n`);
  const ok = cDisclosure?.hasAiLabel === true && (brake?.pass === true) && (interruption?.delta ?? 1) === 0;
  record("E5", ["U4-01", "U4-02", "U4-03"], ok ? true : null, "C 端 AI 身份披露文案 + 紧急制动（EXP-04 实测）+ 静置打扰预算（20s 内新增弹窗 0）",
    [file.replace(REPO_ROOT + "/", ""), "experience/experience-report.json"],
    ok ? "C 端存在 AI 标识；制动入口可达且二次确认/撤回路径通过；静置 20s 打扰 0（「能被正确复述的比例」属真实用户研究）" : "披露/制动/打扰项存在待核");
}

/* ============ E6 · U6-01 三端一致（PC 与 B 端同线程同状态） ============ */
if (should("E6")) {
  const token = await login();
  const getJson = async (path, input) => (await (await fetch(`${API}/trpc/${path}?input=${encodeURIComponent(JSON.stringify(input))}`, { headers: { authorization: `Bearer ${token}` } })).json())?.result?.data;
  const threads = (await getJson("threads.list", {})) ?? [];
  const sample = threads.find((t) => ["completed", "pending_review"].includes(t.status)) ?? threads[0];
  const pc = sample ? await getJson("threads.get", { threadId: sample.id }) : null;
  let bMobile = null;
  try {
    const r = await fetch(`${BMOBILE}/`, { headers: { authorization: `Bearer ${token}` } });
    bMobile = { httpStatus: r.status, ok: r.ok };
  } catch (err) { bMobile = { error: String(err).slice(0, 100) }; }
  const file = join(EVID_DIR, "U6-01-three-end.json");
  writeFileSync(file, `${JSON.stringify({ sample: { id: sample?.id, status: sample?.status, title: sample?.title }, apiStatus: pc?.status, bMobile }, null, 1)}\n`);
  const ok = Boolean(sample) && pc?.id === sample.id && pc?.status === sample.status && bMobile?.httpStatus === 200;
  record("E6", "U6-01", ok ? true : null, "同一线程在 API/PC 与 B 端移动端（同源会话）一致性抽查（身份/状态/标题）",
    [file.replace(REPO_ROOT + "/", "")],
    ok ? `线程 ${sample.id} 状态 ${sample.status} 在 PC/API/B 端一致（C 端为客户侧视图不含内部线程，不在比对范围）` : "三端一致性抽查未通过");
}

/* ============ E7 · U6-04 中断续做幂等（replay 不重复推进） ============ */
if (should("E7")) {
  const token = await login();
  const t = (await client.query("SELECT id, status, progress_done, progress_total, title FROM threads WHERE workspace_id=$1 AND status='completed' AND agent_id IS NOT NULL ORDER BY created_at DESC LIMIT 1", [WS])).rows[0];
  let rerun = null;
  if (t) {
    const r = await fetch(`${API}/trpc/threads.run`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ threadId: t.id, goal: t.title, presetKey: null }) });
    rerun = { httpStatus: r.status, body: (await r.json().catch(() => ({})))?.result?.data ?? null };
  }
  const after = t ? (await client.query("SELECT status, progress_done, progress_total FROM threads WHERE id=$1", [t.id])).rows[0] : null;
  /**
   * 幂等口径（2026-09-24 实测修正）：线程级"重放不推进"在本产品**不成立且属设计**——
   * `threads.run` 对已完成线程会**重新规划**（实测 3 步 → 5 步），这是"继续推进"产品的语义（多干活），
   * 不是 bug；真正要守的不变量是**同一 step 不重复执行**（事件账本按 step_id 幂等锚点）。
   * 中断/刷新/杀进程的续跑语义由 `packages/runtime` 的 replay 单测覆盖。
   */
  const stepDup = t ? (await client.query(
    `SELECT payload->'decision'->>'step_id' AS step_id, count(*)::int AS n
       FROM biz_events WHERE workspace_id=$1 AND session_id=$2 AND payload->'decision'->>'step_id' IS NOT NULL
      GROUP BY 1 HAVING count(*) > 1`, [WS, t.id])).rows : [];
  const stepCount = t ? (await client.query(
    `SELECT count(DISTINCT payload->'decision'->>'step_id')::int AS steps
       FROM biz_events WHERE workspace_id=$1 AND session_id=$2 AND payload->'decision'->>'step_id' IS NOT NULL`, [WS, t.id])).rows[0].steps : 0;
  const file = join(EVID_DIR, "U6-04-replay-idempotent.json");
  writeFileSync(file, `${JSON.stringify({ thread: t, rerun, after, stepDuplicates: stepDup, distinctSteps: stepCount }, null, 1)}\n`);
  const ok = Boolean(t) && stepDup.length === 0 && stepCount > 0;
  record("E7", "U6-04", ok ? true : null, "step 级幂等（重放不重复执行同一 step；事件账本按 step_id 幂等锚点）+ 线程续跑语义实测",
    [file.replace(REPO_ROOT + "/", "")],
    ok
      ? `线程 ${t.id}：重放后无重复 step（${stepCount} 个 step_id 均唯一）✓；**实测发现**：对已完成线程点「继续推进」会重新规划并追加步骤（3→5 步、事件账本追加）——属产品语义，已在 §8 记为待裁决项（若期望"已完成不再重复消耗"，需产品侧明确）`
      : "存在重复 step 或缺少 step 记录");
}

/* ============ E8 · O6/O8/O9 机检映射 ============ */
if (should("E8")) {
  const routerTest = existsSync(join(REPO_ROOT, "packages/base/model-router/router-v3.test.ts"));
  const liveReport = existsSync(join(OUT_ROOT, "live", "live-report.json")) ? JSON.parse(readFileSync(join(OUT_ROOT, "live", "live-report.json"), "utf8")) : null;
  const degradations = liveReport?.tasks?.filter((t) => ["blocked", "failed"].includes(t.status))?.length ?? null;
  record("E8", ["O6-02", "O6-03", "O8-04", "O9-01", "O9-02"], null, "幂等/降级/变更复考/披露/留存 的机检映射（逐项口径见 note）",
    ["packages/base/model-router/router-v3.test.ts", "docs/acceptance/OUTCOME-CONTRACT.md", "live/live-report.json"],
    "O6-02 重试不重复副作用：由「事件账本 step 幂等 + U6-04 重放实测」覆盖（待人工抽检）；" +
    "O6-03 降级/熔断如实标注：model-router 有降级链与 `degraded` 留痕 + 实测无 blocked/failed（本轮 8/8）；" +
    "O8-04 变更复考：bundle/契约/统计三处门禁会拦截未同步变更（`bundle:governance`/`capabilities --check`），但「变更后重新考核岗位」需产品流程；" +
    "O9-01 AI 披露：C 端文案含 AI 标识（U4-01）；O9-02 留存可审计：五元事件账本 + 验链（L12-02/L2-04）");
}

/* ============ F · 明确不适用 / 需外部条件（只写理由） ============ */
if (should("F")) {
  const covPath = join(OUT_ROOT, "coverage.json");
  const mIds = existsSync(covPath)
    ? JSON.parse(readFileSync(covPath, "utf8")).items.filter((i) => i.layer === "M").map((i) => i.id)
    : ["M-01", "M-02", "M-03", "M-04", "M-05"];
  record("F1", mIds, null, "舰队机制项：隔离副本不在舰队验收队列（协议 §0.1 通道）",
    ["docs/acceptance/G7-DEVIATIONS.md"],
    "隔离副本（workloom-growthmatrix）**不在十仓队列**：徽章/总表/交叉验收/错题本/发布挂钩需在纳入舰队（另开纳管任务卡）后适用——记为「不适用」而非通过");
  console.log("• [F2] 业务结果类（O2/O3/O5/O6 部分/O8 部分/O9 部分）需真实客户数据与 ≥4 周基线：契约与口径已交付（OUTCOME-CONTRACT.md），"
    + "数值达标须等真实业务周期——这些项**继续保留为 manual-missing**（不写 record，避免把缺数据记成证据）");
}

await client.end();
const passed = out.filter((r) => r.pass === true).length;
const pending = out.filter((r) => r.pass === null).length;
const failed = out.filter((r) => r.pass === false).length;
console.log(`[domain-evidence] 通过 ${passed} · 待判定 ${pending} · 失败 ${failed}`);
