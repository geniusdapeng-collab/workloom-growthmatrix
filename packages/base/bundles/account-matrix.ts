/**
 * bundles/account-matrix —— 账号矩阵编排（ACT-B-07 / ADD-P-11）
 *
 * 背景：多账号矩阵的纪律不能只写在文档里——账号分层（品牌/门店/员工 IP/达人/用户 UGC/
 * 私域/信源/海外）、单账号日上限、同设备/同网络防关联（G16）必须能被排期器确定性执行。
 *
 * 纪律：
 *  - 行业无关：层级语义、上限与窗口全部由行业包的 `library/account-matrix.yml` 声明；
 *  - 严格校验：账号 id 唯一、层级/平台/owner 必须显式、同层同平台官方号不得重复；
 *  - 排期为纯函数：同输入必得同输出，冲突带规则号（G16 / 日上限）供围栏与战报引用；
 *  - 只读：不写库、不触网，调用方负责把冲突交给围栏与发布执行器。
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";

export interface AccountLayer {
  key: string;
  label: string;
  /** 内容职责（人类可读） */
  duty: string;
  /** 目标（T1–T8 口径） */
  target: string;
  /** 风控纪律（围栏号/频率上限等） */
  discipline: string;
}

export interface AccountEntry {
  id: string;
  layer: string;
  platform: string;
  handle: string;
  ownerPreset: string;
  deviceGroup: string;
  networkGroup: string;
  /** 单账号日发布上限（0 = 未声明，按 1 处理） */
  dailyLimit: number;
  /** 允许发布的本地时间窗（HH:MM-HH:MM，可多条） */
  windows: string[];
}

export interface AccountMatrixDoc {
  version: string;
  layers: AccountLayer[];
  accounts: AccountEntry[];
}

export interface ScheduleSlot {
  id: string;
  accountId: string;
  /** ISO 时间（本地时区已在调用方归一） */
  at: string;
}

export interface ScheduleConflict {
  slotId: string;
  rule: "G16" | "daily-limit" | "window" | "unknown-account";
  reason: string;
}

export interface SchedulePlan {
  accepted: ScheduleSlot[];
  conflicts: ScheduleConflict[];
}

interface RawDoc {
  version?: string;
  layers?: Array<Record<string, unknown>>;
  accounts?: Array<Record<string, unknown>>;
}

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

/** 读取并解析账号矩阵（文件不存在 → 抛错） */
export function loadAccountMatrix(bundleDir: string): AccountMatrixDoc {
  const file = join(bundleDir, "library", "account-matrix.yml");
  if (!existsSync(file)) throw new Error(`account-matrix.yml 不存在：${file}`);
  const raw = YAML.parse(readFileSync(file, "utf8")) as RawDoc;
  const layers: AccountLayer[] = (raw.layers ?? []).map((l) => ({
    key: str(l.key),
    label: str(l.label),
    duty: str(l.duty),
    target: str(l.target),
    discipline: str(l.discipline),
  }));
  const accounts: AccountEntry[] = (raw.accounts ?? []).map((a) => ({
    id: str(a.id),
    layer: str(a.layer),
    platform: str(a.platform),
    handle: str(a.handle),
    ownerPreset: str(a.owner_preset),
    deviceGroup: str(a.device_group),
    networkGroup: str(a.network_group),
    dailyLimit: Number(a.daily_limit ?? 1),
    windows: Array.isArray(a.windows) ? a.windows.map((w) => str(w)).filter(Boolean) : [],
  }));
  if (accounts.length === 0) throw new Error(`account-matrix.yml 未声明任何账号：${file}`);
  const doc: AccountMatrixDoc = { version: str(raw.version) || "unknown", layers, accounts };
  const issues = validateAccountMatrix(doc);
  if (issues.length > 0) throw new Error(`账号矩阵存在 ${issues.length} 处问题：${issues.join("；")}`);
  return doc;
}

/** 结构校验（返回全部问题，供门禁一次性报全） */
export function validateAccountMatrix(doc: AccountMatrixDoc): string[] {
  const issues: string[] = [];
  const layerKeys = new Set(doc.layers.map((l) => l.key));
  if (doc.layers.length === 0) issues.push("未声明任何账号层级");
  const seen = new Set<string>();
  const officialByPlatform = new Set<string>();
  for (const a of doc.accounts) {
    if (!a.id) issues.push("存在缺 id 的账号");
    if (seen.has(a.id)) issues.push(`账号 id 重复：${a.id}`);
    seen.add(a.id);
    if (!layerKeys.has(a.layer)) issues.push(`${a.id} 引用未声明层级 ${a.layer || "(空)"}`);
    for (const [field, value] of [["platform", a.platform], ["handle", a.handle], ["ownerPreset", a.ownerPreset], ["deviceGroup", a.deviceGroup], ["networkGroup", a.networkGroup]] as const) {
      if (!value) issues.push(`${a.id} 缺字段 ${field}`);
    }
    if (!Number.isFinite(a.dailyLimit) || a.dailyLimit < 1) issues.push(`${a.id} 的 daily_limit 非法（${a.dailyLimit}）`);
    if (a.layer === "l1_brand") {
      const key = `${a.layer}:${a.platform}`;
      if (officialByPlatform.has(key)) issues.push(`同平台品牌官方号重复：${a.platform}`);
      officialByPlatform.add(key);
    }
  }
  return issues;
}

const hourOf = (iso: string): string => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return `${String(d.getHours()).padStart(2, "0")}:00`;
};

const dayOf = (iso: string): string => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toISOString().slice(0, 10);
};

const inWindow = (iso: string, windows: string[]): boolean => {
  if (windows.length === 0) return true;
  const d = new Date(iso);
  const minutes = d.getHours() * 60 + d.getMinutes();
  return windows.some((w) => {
    const m = /^(\d{2}):(\d{2})-(\d{2}):(\d{2})$/.exec(w);
    if (!m) return false;
    const start = Number(m[1]) * 60 + Number(m[2]);
    const end = Number(m[3]) * 60 + Number(m[4]);
    return start <= end ? minutes >= start && minutes <= end : minutes >= start || minutes <= end;
  });
};

/**
 * 协同排期（确定性）：
 *  - 未知账号 → unknown-account；
 *  - 同 device_group 或 network_group 的账号在同一小时发布 → G16（防关联）；
 *  - 单账号超日上限 → daily-limit；
 *  - 落在声明窗口外 → window。
 * 冲突不抛出，交由调用方按围栏等级处理（G16 为 block）。
 */
export function planAccountSchedule(doc: AccountMatrixDoc, slots: ScheduleSlot[]): SchedulePlan {
  const byId = new Map(doc.accounts.map((a) => [a.id, a]));
  const daily = new Map<string, number>();
  const occupancy = new Map<string, string>(); // `${group}|${day}|${hour}` → accountId
  const accepted: ScheduleSlot[] = [];
  const conflicts: ScheduleConflict[] = [];

  for (const slot of [...slots].sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id))) {
    const account = byId.get(slot.accountId);
    if (!account) {
      conflicts.push({ slotId: slot.id, rule: "unknown-account", reason: `账号 ${slot.accountId} 不在矩阵` });
      continue;
    }
    if (!inWindow(slot.at, account.windows)) {
      conflicts.push({ slotId: slot.id, rule: "window", reason: `${account.id} 的 ${hourOf(slot.at)} 不在发布窗口（${account.windows.join(" / ")}）` });
      continue;
    }
    const dayKey = `${account.id}|${dayOf(slot.at)}`;
    const used = daily.get(dayKey) ?? 0;
    if (used + 1 > account.dailyLimit) {
      conflicts.push({ slotId: slot.id, rule: "daily-limit", reason: `${account.id} 日上限 ${account.dailyLimit} 已用完` });
      continue;
    }
    const hour = hourOf(slot.at);
    const groupKeys = [
      account.deviceGroup ? `${account.deviceGroup}|${dayOf(slot.at)}|${hour}` : "",
      account.networkGroup ? `${account.networkGroup}|${dayOf(slot.at)}|${hour}` : "",
    ].filter(Boolean);
    const clash = groupKeys.find((k) => occupancy.has(k) && occupancy.get(k) !== account.id);
    if (clash) {
      const other = occupancy.get(clash);
      conflicts.push({
        slotId: slot.id, rule: "G16",
        reason: `${account.id} 与 ${other} 共享${clash.startsWith(account.deviceGroup) ? "设备组" : "网络组"}且同一小时发布（防关联）`,
      });
      continue;
    }
    for (const k of groupKeys) occupancy.set(k, account.id);
    daily.set(dayKey, used + 1);
    accepted.push(slot);
  }
  return { accepted, conflicts };
}

/** 分层统计（战报与编制周报引用） */
export function summarizeAccountMatrix(doc: AccountMatrixDoc): Array<{ layer: string; label: string; accounts: number; dailyCapacity: number }> {
  return doc.layers.map((l) => {
    const rows = doc.accounts.filter((a) => a.layer === l.key);
    return {
      layer: l.key,
      label: l.label,
      accounts: rows.length,
      dailyCapacity: rows.reduce((sum, a) => sum + a.dailyLimit, 0),
    };
  });
}
