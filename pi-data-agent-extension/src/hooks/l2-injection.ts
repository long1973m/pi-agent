/**
 * v0.13 L2 — 语义附注即时注入（可信分析官 · 阶段一）
 *
 * 按 v0.10 spec §9.1 已定稿设计落地（触发四条件 / 已交付清单 / 预算），内容三类：
 * 1.【表卡片】summary + 边界（含 stale 提示）
 * 2.【指标口径】user_intent 命中指标名 → 附定义（SQL 涉及该指标时必须遵守）
 * 3.【字段警示】SQL 触及 uncertain 状态列 → 附可信度警示
 *
 * 设计要点（v0.13 spec §0.2 决策 3 / §3.2）：
 * - 注入点在 query_data 工具内部（执行成功后拼接在结果前），不拦截、不改写
 * - "已交付清单"为 session 级内存 Set，键内嵌表 fingerprint —— 结构变化（fingerprint 变）
 *   时键自然失配 → 自动重新交付，无需显式重置；pi 未提供扩展可见的 compaction 事件，
 *   会话压缩后的重复附注按"宁可重复、不可缺失"接受（v0.13 spec §0.3 核验结论）
 * - 历史样例不在此注入：L0 Query Memory（before_agent_start）已每轮注入相关问答，
 *   L2 再附注会重复投喂（v0.13 spec 变更记录 v0.13.1）
 * - 本模块纯函数集合 + 状态类；运行时装配见 buildSemanticNoteFromRuntime
 */

import { computeTableSchemaFingerprint } from "../table-cards/store.js";
import { listActiveMetricDefinitions } from "../metrics/metric-definitions.js";
import type { ColumnInfo } from "../types.js";

/** 附注预算（≈200 token，按 4 字符/token 近似，与 NAV_CHAR_BUDGET 同法） */
export const L2_CHAR_BUDGET = 800;

/** 单轮最多覆盖表数（v0.10 §9.1） */
export const L2_MAX_TABLES = 2;

/** 单次附注指标条数上限 */
export const L2_METRIC_LIMIT = 2;

/** 单表边界条数上限 */
export const L2_BOUNDARIES_LIMIT = 2;

/** 单表 uncertain 警示列数上限 */
export const L2_UNCERTAIN_LIMIT = 3;

/** 指标名命中 user_intent 的最小长度（避免单字符误命中） */
const METRIC_NAME_MIN_LENGTH = 2;

// ============================================================================
// 已交付清单（L2-1）
// ============================================================================

/** 表卡片已交付键（fingerprint 内嵌：结构变化 → 键失配 → 自动重投递） */
export function tableCardKey(table: string, fingerprint: string | null): string {
  return `tableCard:${table}@${fingerprint ?? "unknown"}`;
}

/** 指标已交付键 */
export function metricKey(metricId: string): string {
  return `metric:${metricId}`;
}

/** uncertain 警示已交付键 */
export function uncertainKey(table: string, fingerprint: string | null): string {
  return `uncertain:${table}@${fingerprint ?? "unknown"}`;
}

/**
 * 已交付清单（session 级内存）。
 *
 * 生命周期：
 * - 写入：L2 附注发生时；get_table_card 成功返回时（L2-4）
 * - 重置：新会话自然为空（runtime 在 session_start 重建）；fingerprint 变化通过
 *   键内嵌自动失效；compaction 无扩展可见事件，不做重置（见文件头说明）
 */
export class L2DeliveredState {
  private seen = new Set<string>();

  has(key: string): boolean {
    return this.seen.has(key);
  }

  mark(key: string): void {
    this.seen.add(key);
  }

  /** 当前已交付条数（诊断用） */
  get size(): number {
    return this.seen.size;
  }
}

// ============================================================================
// SQL 表名提取
// ============================================================================

/**
 * 从 SQL 中提取全部 FROM/JOIN 目标表名（去重、取标识符末段、剥 schema 前缀）。
 * 词法提取 + 与已登记表名精确匹配的用法见 buildSemanticNoteFromRuntime；
 * 不解析 SQL AST，子查询 FROM ( 不产生匹配。
 */
export function extractSqlTableNames(sql: string): string[] {
  const names: string[] = [];
  const re = /\b(?:from|join)\s+`?"?([a-zA-Z_][\w$]*(?:\.[a-zA-Z_][\w$]*)*)`?"?/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(sql)) !== null) {
    const segments = match[1].split(".");
    const name = segments[segments.length - 1];
    if (name && !names.includes(name)) names.push(name);
  }
  return names;
}

// ============================================================================
// 附注装配（纯函数）
// ============================================================================

/** 单表卡片投影（来自 TableCardStore，缺卡片为 null） */
export interface L2CardInfo {
  summary?: string;
  boundaries?: string[];
  stale?: boolean;
}

/** 单表知识输入 */
export interface L2TableKnowledge {
  table: string;
  /** 表 schema 指纹（getSchema 失败时为 null，键退化为 @unknown） */
  fingerprint: string | null;
  card?: L2CardInfo | null;
  /** SQL 触及的 uncertain 状态列名 */
  uncertainColumns?: string[];
}

/** 指标定义投影（来自 listActiveMetricDefinitions） */
export interface L2MetricInfo {
  id: string;
  name: string;
  definition: string;
}

export interface L2NoteInput {
  sql: string;
  userIntent: string;
  tables: L2TableKnowledge[];
  metrics: L2MetricInfo[];
  /** 已交付判定（来自 L2DeliveredState.has） */
  delivered: (key: string) => boolean;
}

export interface L2NoteResult {
  text: string;
  /** 实际进入附注的键（未装进预算的键不返回，下次仍可交付） */
  keys: string[];
}

/**
 * 装配语义附注。触发四条件中 ①③④ 在本函数内判定（②知识存在由调用方收集输入体现）；
 * 无任何可注入内容返回 null。逐行装填、超预算整行放弃（不做半句截断）。
 */
export function buildL2Note(input: L2NoteInput): L2NoteResult | null {
  const items: Array<{ line: string; key?: string }> = [];
  const tables = input.tables.slice(0, L2_MAX_TABLES);

  // 1. 表卡片
  for (const t of tables) {
    const card = t.card;
    if (!card) continue;
    const summary = card.summary?.trim() ?? "";
    const boundaries = (card.boundaries ?? []).map((b) => b.trim()).filter(Boolean);
    if (!summary && boundaries.length === 0) continue; // 骨架卡无内容可注入
    const key = tableCardKey(t.table, t.fingerprint);
    if (input.delivered(key)) continue;
    const parts: string[] = [];
    if (summary) parts.push(summary);
    if (boundaries.length > 0) {
      parts.push(`边界: ${boundaries.slice(0, L2_BOUNDARIES_LIMIT).join("；")}`);
    }
    if (card.stale) parts.push("卡片已过期，建议 get_table_card 复核");
    items.push({ line: `【表卡片】${t.table}: ${parts.join("；")}`, key });
  }

  // 2. 指标口径（user_intent 命中指标名）
  const intentLower = input.userIntent.toLowerCase();
  const hitMetrics = input.metrics
    .filter((m) => m.name.trim().length >= METRIC_NAME_MIN_LENGTH && intentLower.includes(m.name.trim().toLowerCase()))
    .slice(0, L2_METRIC_LIMIT);
  for (const m of hitMetrics) {
    const key = metricKey(m.id);
    if (input.delivered(key)) continue;
    items.push({
      line: `【指标口径】${m.name} = ${m.definition.replace(/\n+/g, " ")}（SQL 涉及该指标时必须遵守）`,
      key,
    });
  }

  // 3. uncertain 字段警示
  for (const t of tables) {
    const cols = (t.uncertainColumns ?? []).map((c) => c.trim()).filter(Boolean);
    if (cols.length === 0) continue;
    const key = uncertainKey(t.table, t.fingerprint);
    if (input.delivered(key)) continue;
    items.push({
      line: `【字段警示】${t.table} 字段 ${cols.slice(0, L2_UNCERTAIN_LIMIT).join("、")} 语义未确认（uncertain），相关分析结果可信度受限`,
      key,
    });
  }

  if (items.length === 0) return null;

  const header = "📋 语义附注（自动注入，无需回复）";
  let text = header;
  const keys: string[] = [];
  for (const item of items) {
    const candidate = `${text}\n${item.line}`;
    if (candidate.length > L2_CHAR_BUDGET) continue;
    text = candidate;
    if (item.key) keys.push(item.key);
  }

  if (keys.length === 0) return null;
  return { text, keys };
}

// ============================================================================
// 运行时装配（L2-2：query_data 调用）
// ============================================================================

/** buildSemanticNoteFromRuntime 所需的最小 runtime 面（ToolContext 结构子集） */
interface L2RuntimeLike {
  engine: { getSchema(tableName: string): Promise<ColumnInfo[]> } | null;
  tableCards?: { get(tableName: string): { summary: string; boundaries: string[]; stale: boolean } | null } | undefined;
  persistence: { loadMergedDataDictionary(): Map<string, { columns: Array<{ name: string; status: string }> }> };
  config: { projectConfigDir: string };
  l2State?: L2DeliveredState;
}

/**
 * 从 runtime 收集知识并装配附注（触发条件 ②：知识存在由此处收集结果体现）。
 * 任一知识源失败均静默跳过，不影响查询主流程；无 l2State / 无表名 / 无内容 → null。
 */
export async function buildSemanticNoteFromRuntime(
  rt: L2RuntimeLike,
  sql: string,
  userIntent: string,
): Promise<L2NoteResult | null> {
  if (!rt.engine || !rt.l2State) return null;

  const tableNames = extractSqlTableNames(sql).slice(0, L2_MAX_TABLES);
  if (tableNames.length === 0) return null;

  const tables: L2TableKnowledge[] = [];
  for (const table of tableNames) {
    let fingerprint: string | null = null;
    try {
      fingerprint = computeTableSchemaFingerprint(table, await rt.engine.getSchema(table));
    } catch {
      fingerprint = null;
    }

    let card: L2CardInfo | null = null;
    try {
      card = rt.tableCards?.get(table) ?? null;
    } catch {
      card = null;
    }

    let uncertainColumns: string[] = [];
    try {
      const dict = rt.persistence.loadMergedDataDictionary().get(table);
      if (dict) {
        const sqlLower = sql.toLowerCase();
        uncertainColumns = dict.columns
          .filter((c) => c.status === "uncertain" && sqlLower.includes(c.name.toLowerCase()))
          .map((c) => c.name);
      }
    } catch {
      // 字典缺失不阻断
    }

    tables.push({ table, fingerprint, card, uncertainColumns });
  }

  let metrics: L2MetricInfo[] = [];
  try {
    metrics = listActiveMetricDefinitions(rt.config.projectConfigDir).map((m) => ({
      id: m.id,
      name: m.name,
      definition: m.definition,
    }));
  } catch {
    metrics = [];
  }

  const state = rt.l2State;
  return buildL2Note({ sql, userIntent, tables, metrics, delivered: (k) => state.has(k) });
}
