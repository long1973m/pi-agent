/**
 * v0.9 A-5 — 数据体检卡（load_data 成功后主动画像）
 *
 * 基于一条 `SUMMARIZE <table>`（DuckDB 原生，含 null_percentage / approx_unique）
 * + 少量补充查询（疑似主键重复检测），规则生成 ≤3 条建议问题。
 *
 * 接入点：load_data execute 成功后 best-effort 调用——
 * - content 文本追加紧凑体检卡（人话，≤8 行）
 * - details 附结构化 dataProfile
 *
 * 防护：
 * - 估算行数 > 100 万时只做 SUMMARIZE（跳过逐列补充查询），降级为基础信息
 * - 单步失败由调用方整体 try/catch 静默跳过，不影响加载主流程
 */

import { normalizeDuckDBTypeName, type DuckDBEngine } from "../engine/duckdb.js";

/** 缺失率阈值：>30% 需关注 */
const MISSING_ATTENTION_THRESHOLD = 30;
/** 缺失率阈值：>80% 严重 */
const MISSING_SEVERE_THRESHOLD = 80;
/** 低基数列范围（疑似分类维度）：approx_unique ∈ [2, 20] */
const LOW_CARDINALITY_MIN = 2;
const LOW_CARDINALITY_MAX = 20;
/** 大表阈值：估算行数超过时跳过逐列补充查询 */
const LARGE_TABLE_ROW_THRESHOLD = 1_000_000;
/** 疑似主键列名模式 */
const PK_NAME_PATTERN = /^id$|_id$/i;
/** 金额类列名模式（用于生成排名问句） */
const AMOUNT_NAME_PATTERN = /(amount|revenue|sales|price|total|cost|fee|金额|销售额|收入|费用|价格)/i;

/** 数值类型集合（用于识别数值列） */
const NUMERIC_TYPES = new Set([
  "TINYINT", "SMALLINT", "INTEGER", "BIGINT",
  "UTINYINT", "USMALLINT", "UINTEGER", "UBIGINT",
  "FLOAT", "DOUBLE", "DECIMAL",
]);

/** 时间类型前缀（用于识别时间列） */
function isTimeType(type: string): boolean {
  const upper = type.toUpperCase();
  return upper === "DATE" || upper.startsWith("TIMESTAMP");
}

/** 是否数值列（带精度的类型如 DECIMAL(9,2) 先规范化为 DECIMAL 再匹配） */
function isNumericType(type: string): boolean {
  return NUMERIC_TYPES.has(normalizeDuckDBTypeName(type));
}

/** 结构化画像 */
export interface TableProfile {
  tableName: string;
  rowCount: number;
  columnCount: number;
  /** 缺失率 >30%（需关注） */
  missingColumns: Array<{ name: string; nullPercentage: number }>;
  /** 缺失率 >80%（严重） */
  severeMissingColumns: Array<{ name: string; nullPercentage: number }>;
  /** 低基数列（approx_unique ∈ [2,20]，候选维度） */
  lowCardinalityColumns: Array<{ name: string; approxUnique: number }>;
  /** 恒定列（approx_unique = 1，无区分度） */
  constantColumns: string[];
  /** 时间列跨度（第一个时间列） */
  timeSpan?: { column: string; type: string; min: string; max: string };
  /** 疑似主键重复（COUNT − COUNT(DISTINCT) > 0） */
  primaryKeySuspicion: Array<{ column: string; duplicateCount: number }>;
  /** 大表降级模式（只做 SUMMARIZE） */
  degraded: boolean;
  /** 规则生成的建议问题（≤3 条） */
  suggestedQuestions: string[];
}

/** SUMMARIZE 单列解析结果 */
interface SummaryRow {
  columnName: string;
  columnType: string;
  min: string | null;
  max: string | null;
  approxUnique: number | null;
  nullPercentage: number | null;
}

/** 安全数值转换（DuckDB 可能返回字符串/BigInt/null） */
function toNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** 解析 SUMMARIZE 结果行（列序：column_name..null_percentage） */
function parseSummaryRows(rows: unknown[][]): SummaryRow[] {
  return rows.map((r) => ({
    columnName: String(r[0]),
    columnType: String(r[1] ?? ""),
    min: r[2] === null || r[2] === undefined ? null : String(r[2]),
    max: r[3] === null || r[3] === undefined ? null : String(r[3]),
    approxUnique: toNumber(r[4]),
    nullPercentage: toNumber(r[11]),
  }));
}

/**
 * 对表做数据画像。
 *
 * @param engine DuckDB 引擎
 * @param tableName 表名
 * @param opts.estimatedRowCount 估算行数（loadTableFast 已算过时传入，避免重复 COUNT）
 */
export async function profileTable(
  engine: DuckDBEngine,
  tableName: string,
  opts?: { estimatedRowCount?: number }
): Promise<TableProfile> {
  const quoted = engine.quoteIdentifier(tableName);

  // 1. SUMMARIZE（一次拿到缺失率 / approx_unique / min-max / 类型）
  const summaryResult = await engine.query(`SUMMARIZE ${quoted}`);
  const summary = parseSummaryRows(summaryResult.rows);
  if (summary.length === 0) {
    throw new Error(`Table ${tableName} has no columns to profile.`);
  }

  // 2. 行数：优先用调用方提供的估算值
  let rowCount: number;
  if (opts?.estimatedRowCount !== undefined && opts.estimatedRowCount >= 0) {
    rowCount = opts.estimatedRowCount;
  } else {
    const countResult = await engine.query(`SELECT COUNT(*)::BIGINT FROM ${quoted}`);
    rowCount = Number(countResult.rows[0]?.[0] ?? 0);
  }

  // 3. 大表降级：只做 SUMMARIZE
  const degraded = rowCount > LARGE_TABLE_ROW_THRESHOLD;

  // 4. 缺失率 / 低基数 / 恒定列 / 时间跨度（全部来自 SUMMARIZE）
  const missingColumns: TableProfile["missingColumns"] = [];
  const severeMissingColumns: TableProfile["severeMissingColumns"] = [];
  const lowCardinalityColumns: TableProfile["lowCardinalityColumns"] = [];
  const constantColumns: string[] = [];
  let timeSpan: TableProfile["timeSpan"];

  for (const col of summary) {
    const nullPct = col.nullPercentage ?? 0;
    if (nullPct > MISSING_SEVERE_THRESHOLD) {
      severeMissingColumns.push({ name: col.columnName, nullPercentage: nullPct });
    } else if (nullPct > MISSING_ATTENTION_THRESHOLD) {
      missingColumns.push({ name: col.columnName, nullPercentage: nullPct });
    }

    if (col.approxUnique !== null) {
      if (col.approxUnique === 1) {
        constantColumns.push(col.columnName);
      } else if (col.approxUnique >= LOW_CARDINALITY_MIN && col.approxUnique <= LOW_CARDINALITY_MAX) {
        lowCardinalityColumns.push({ name: col.columnName, approxUnique: col.approxUnique });
      }
    }

    if (!timeSpan && isTimeType(col.columnType)) {
      timeSpan = {
        column: col.columnName,
        type: col.columnType,
        min: col.min ?? "unknown",
        max: col.max ?? "unknown",
      };
    }
  }

  // 5. 疑似主键重复（补充查询；大表跳过）
  const primaryKeySuspicion: TableProfile["primaryKeySuspicion"] = [];
  if (!degraded) {
    const idColumns = summary
      .filter((c) => PK_NAME_PATTERN.test(c.columnName))
      .slice(0, 4); // 上限防护：最多检查 4 列
    if (idColumns.length > 0) {
      // 单次扫描同时计算各列 DISTINCT 数
      const selectParts = idColumns.map(
        (c) => `COUNT(DISTINCT ${engine.quoteIdentifier(c.columnName)})::BIGINT`
      );
      const sql = `SELECT COUNT(*)::BIGINT AS _total_, ${selectParts.join(", ")} FROM ${quoted}`;
      const dupResult = await engine.query(sql);
      const row = dupResult.rows[0] ?? [];
      const total = toNumber(row[0]) ?? 0;
      for (let i = 0; i < idColumns.length; i++) {
        const distinct = toNumber(row[i + 1]);
        if (distinct === null) continue;
        const duplicateCount = total - distinct;
        if (duplicateCount > 0) {
          primaryKeySuspicion.push({ column: idColumns[i].columnName, duplicateCount });
        }
      }
    }
  }

  // 6. 建议问题（规则生成，≤3 条）
  const suggestedQuestions = generateSuggestedQuestions(summary, timeSpan);

  return {
    tableName,
    rowCount,
    columnCount: summary.length,
    missingColumns,
    severeMissingColumns,
    lowCardinalityColumns,
    constantColumns,
    timeSpan,
    primaryKeySuspicion,
    degraded,
    suggestedQuestions,
  };
}

/**
 * 规则生成建议问题（最多 3 条）：
 * - 有时间列 → 趋势问句
 * - 有低基数分类列 + 数值列 → 分布 / Top N 问句
 * - 有金额类数值列 → 排名问句
 */
export function generateSuggestedQuestions(
  summary: SummaryRow[],
  timeSpan?: TableProfile["timeSpan"]
): string[] {
  const questions: string[] = [];

  // 1. 时间趋势
  if (timeSpan) {
    questions.push(`「${timeSpan.column} 随时间的变化趋势是怎样的？（按天/按月统计）」`);
  }

  // 2. 分类维度 × 数值列 → Top N 分布（排除疑似主键列——主键不是有用的分析维度）
  const numericColumns = summary.filter((c) => isNumericType(c.columnType));
  const dim = summary.find((c) =>
    !PK_NAME_PATTERN.test(c.columnName)
    && c.approxUnique !== null && c.approxUnique >= LOW_CARDINALITY_MIN && c.approxUnique <= LOW_CARDINALITY_MAX
  );
  if (dim && numericColumns.length > 0) {
    questions.push(`「按 ${dim.columnName} 分组统计 ${numericColumns[0].columnName}，哪个分组最多？」`);
  }

  // 3. 金额类排名
  const amountCol = numericColumns.find((c) => AMOUNT_NAME_PATTERN.test(c.columnName));
  if (amountCol) {
    questions.push(`「${amountCol.columnName} 最高 / 最低的记录有哪些？」`);
  }

  return questions.slice(0, 3);
}

/**
 * 格式化紧凑体检卡文本（人话，≤8 行），追加到 load_data 的 content。
 */
export function formatProfileCard(profile: TableProfile): string {
  const lines: string[] = [];

  // 基础信息
  const rowCountDisplay = profile.rowCount >= 0 ? `${profile.rowCount}` : "unknown";
  const degradedNote = profile.degraded ? "（大表，仅基础体检）" : "";
  lines.push(`📊 数据体检 ${profile.tableName}：${rowCountDisplay} 行 × ${profile.columnCount} 列${degradedNote}`);

  // 缺失率
  const fmtPct = (v: number) => `${v.toFixed(1)}%`;
  const missingParts: string[] = [];
  if (profile.missingColumns.length > 0) {
    missingParts.push(`需关注：${profile.missingColumns.map((c) => `${c.name} ${fmtPct(c.nullPercentage)}`).join("、")}`);
  }
  if (profile.severeMissingColumns.length > 0) {
    missingParts.push(`严重：${profile.severeMissingColumns.map((c) => `${c.name} ${fmtPct(c.nullPercentage)}`).join("、")}`);
  }
  if (missingParts.length > 0) {
    lines.push(`⚠️ 缺失率 ${missingParts.join("｜")}`);
  }

  // 时间跨度
  if (profile.timeSpan) {
    lines.push(`🕐 时间跨度：${profile.timeSpan.column} ${profile.timeSpan.min} ~ ${profile.timeSpan.max}`);
  }

  // 疑似主键重复
  if (profile.primaryKeySuspicion.length > 0) {
    lines.push(`🔑 疑似主键重复：${profile.primaryKeySuspicion.map((p) => `${p.column}（${p.duplicateCount} 个重复值）`).join("、")}`);
  }

  // 候选维度 / 恒定列
  const dimParts: string[] = [];
  if (profile.lowCardinalityColumns.length > 0) {
    dimParts.push(`候选维度：${profile.lowCardinalityColumns.slice(0, 5).map((c) => `${c.name}(${c.approxUnique})`).join("、")}`);
  }
  if (profile.constantColumns.length > 0) {
    dimParts.push(`恒定列（无区分度）：${profile.constantColumns.slice(0, 5).join("、")}`);
  }
  if (dimParts.length > 0) {
    lines.push(`🧩 ${dimParts.join("｜")}`);
  }

  // 建议问题（每条一行，与上方合计 ≤8 行）
  for (const q of profile.suggestedQuestions) {
    lines.push(`💡 可以问我：${q}`);
  }

  return lines.join("\n");
}
