/**
 * 字典推断 — 收集推断上下文
 *
 * 职责：为指定表收集 AI 推断所需的上下文信息（发送给模型之前）。
 * 包括 schema、统计信息、脱敏样本值、数据库注释、已确认字段含义。
 */

import type { DuckDBEngine } from "../../engine/duckdb.js";
import type { DataDictionaryEntry, TableInferenceContext, DictionaryInferenceMode, ColumnInfo } from "../../types.js";
import { maskPIIArray } from "../../pii-guard.js";

export interface CollectContextParams {
  tableName: string;
  engine: DuckDBEngine;
  dictionaryEntry: DataDictionaryEntry | undefined;
  mode: DictionaryInferenceMode;
  selectedColumns?: string[];
}

/** 支持 MIN/MAX 的类型集合（数值 + 日期） */
const MIN_MAX_TYPES = new Set([
  "TINYINT", "SMALLINT", "INTEGER", "BIGINT",
  "UTINYINT", "USMALLINT", "UINTEGER", "UBIGINT",
  "FLOAT", "DOUBLE", "DECIMAL",
  "DATE", "TIME", "TIMESTAMP", "TIMESTAMP_S", "TIMESTAMP_MS", "TIMESTAMP_NS",
]);

/** 用户已锁定的状态（不可被自动推断覆盖） */
const LOCKED_STATUSES = new Set(["user-confirmed", "user-corrected"]);

/**
 * 收集表级推断上下文
 *
 * 规则：
 * - 收集 schema（列名、类型、nullable）
 * - 收集统计信息（nullRatio、uniqueCount、min、max）
 * - 收集脱敏样本值（最多 5 个）
 * - 收集数据库注释（如果有）
 * - 根据 mode 筛选需要推断的列：
 *   - empty-only: 只收集 description 为空的列
 *   - selected: 只收集 selectedColumns 中的列
 *   - force: 收集所有列
 * - 不覆盖 user-confirmed 或 user-corrected 的列（force 模式除外也只收集不覆盖）
 * - 收集同表已确认字段含义作为上下文
 */
export async function collectInferenceContext(
  params: CollectContextParams
): Promise<TableInferenceContext> {
  const { tableName, engine, dictionaryEntry, mode, selectedColumns } = params;

  // 1. 获取 schema 和行数
  const [schema, overview] = await Promise.all([
    engine.getSchema(tableName),
    engine.getTableOverview(tableName),
  ]);
  const rowCount = overview.rowCount;

  // 2. 获取样本数据
  let sampleRows: unknown[][] = [];
  if (rowCount > 0) {
    sampleRows = await engine.getSample(tableName, 5);
  }

  // 3. 获取主键和外键信息
  const [primaryKeySet, foreignKeySet] = await Promise.all([
    getPrimaryKeyColumns(engine, tableName),
    getForeignKeyColumns(engine, tableName),
  ]);

  // 3.5 获取列注释（DuckDB 系统表）
  const columnComments = await getColumnComments(engine, tableName);

  // 4. 构建 colName -> index 映射（用于从样本行提取对应列的值）
  const colIndexMap = new Map<string, number>();
  for (let i = 0; i < schema.length; i++) {
    colIndexMap.set(schema[i].name, i);
  }

  // 5. 根据 mode 筛选目标列
  const targetColumns = filterTargetColumns(schema, dictionaryEntry, mode, selectedColumns);

  // 6. 收集统计信息（批量查询，失败时降级为默认值）
  const statsMap = await collectColumnStats(engine, tableName, targetColumns, rowCount);

  // 7. 收集同表已确认字段含义作为 knownCalibers
  const knownCalibers = extractKnownCalibers(dictionaryEntry);

  // 8. 组装 TableInferenceContext
  const columns = targetColumns.map((col) => {
    const colIdx = colIndexMap.get(col.name);
    const rawValues = colIdx !== undefined
      ? sampleRows
          .slice(0, 5)
          .map((row) => String(row[colIdx] ?? ""))
          .filter((v) => v !== "")
      : [];

    // PII 脱敏
    const { masked: sampleValues } = maskPIIArray(rawValues);

    const stats = statsMap.get(col.name);
    const existing = dictionaryEntry?.columns.find((c) => c.name === col.name);

    return {
      name: col.name,
      type: col.type as string,
      nullable: col.nullable,
      sampleValues,
      nullRatio: stats?.nullRatio ?? 0,
      uniqueCount: stats?.uniqueCount ?? 0,
      min: stats?.min,
      max: stats?.max,
      currentDescription: existing?.inferredMeaning,
      currentStatus: existing?.status,
      isPrimaryKey: primaryKeySet.has(col.name),
      isForeignKey: foreignKeySet.has(col.name),
      dbComment: columnComments.get(col.name),
    };
  });

  return {
    tableName,
    columns,
    rowCount,
    knownCalibers: knownCalibers.length > 0 ? knownCalibers : undefined,
  };
}

// ============================================================================
// 内部辅助函数
// ============================================================================

/**
 * 根据 mode 筛选需要推断的列
 *
 * - empty-only: inferredMeaning 为空（或为默认的 "未知语义（请确认）"）且 status 不是 user-confirmed/user-corrected
 * - selected: selectedColumns 中的列（且不是锁定状态）
 * - force: 所有列
 */
function filterTargetColumns(
  schema: ColumnInfo[],
  dictionaryEntry: DataDictionaryEntry | undefined,
  mode: DictionaryInferenceMode,
  selectedColumns?: string[]
): ColumnInfo[] {
  const selectedSet = selectedColumns ? new Set(selectedColumns) : null;
  const existingCols = new Map<string, { status: string; inferredMeaning: string }>();
  if (dictionaryEntry) {
    for (const col of dictionaryEntry.columns) {
      existingCols.set(col.name, {
        status: col.status,
        inferredMeaning: col.inferredMeaning,
      });
    }
  }

  return schema.filter((col) => {
    const existing = existingCols.get(col.name);

    switch (mode) {
      case "empty-only": {
        // 跳过用户已锁定的列
        if (existing && LOCKED_STATUSES.has(existing.status)) return false;
        // 跳过已有非空推断含义的列
        if (existing && existing.inferredMeaning && existing.inferredMeaning !== "未知语义（请确认）") {
          return false;
        }
        return true;
      }
      case "selected": {
        if (!selectedSet || !selectedSet.has(col.name)) return false;
        // 跳过用户已锁定的列
        if (existing && LOCKED_STATUSES.has(existing.status)) return false;
        return true;
      }
      case "force": {
        // force 模式收集所有列（包括锁定的，但在返回的上下文中标记 currentStatus）
        return true;
      }
    }
  });
}

/** 列统计信息 */
interface ColumnStatsInfo {
  nullRatio: number;
  uniqueCount: number;
  min?: string | number;
  max?: string | number;
}

/**
 * 批量收集列统计信息
 *
 * 使用两条 DuckDB SQL：
 * 1. nullRatio + uniqueCount（所有目标列，一条聚合查询）
 * 2. min + max（仅数值/日期类型列，一条聚合查询）
 */
async function collectColumnStats(
  engine: DuckDBEngine,
  tableName: string,
  targetColumns: ColumnInfo[],
  rowCount: number
): Promise<Map<string, ColumnStatsInfo>> {
  const result = new Map<string, ColumnStatsInfo>();

  if (targetColumns.length === 0 || rowCount === 0) {
    for (const col of targetColumns) {
      result.set(col.name, { nullRatio: 0, uniqueCount: 0 });
    }
    return result;
  }

  const quoted = (name: string) => engine.quoteIdentifier(name);
  const tName = quoted(tableName);

  // 查询 1: nullRatio + uniqueCount（所有列）
  try {
    const nullUniqueSelects = targetColumns.map(
      (col) =>
        `COUNT(*) FILTER (WHERE ${quoted(col.name)} IS NULL) AS "${col.name}__null", ` +
        `COUNT(DISTINCT ${quoted(col.name)}) AS "${col.name}__unique"`
    );
    const sql1 = `SELECT ${nullUniqueSelects.join(", ")} FROM ${tName}`;
    const res1 = await engine.query(sql1);

    if (res1.rows.length > 0) {
      const row = res1.rows[0];
      const colNameMap = new Map<string, number>();
      for (let i = 0; i < res1.columns.length; i++) {
        colNameMap.set(res1.columns[i].name, i);
      }

      for (const col of targetColumns) {
        const nullIdx = colNameMap.get(`${col.name}__null`);
        const uniqueIdx = colNameMap.get(`${col.name}__unique`);
        const nullCount = nullIdx !== undefined ? Number(row[nullIdx] ?? 0) : 0;
        const uniqueCount = uniqueIdx !== undefined ? Number(row[uniqueIdx] ?? 0) : 0;
        result.set(col.name, {
          nullRatio: rowCount > 0 ? nullCount / rowCount : 0,
          uniqueCount,
        });
      }
    }
  } catch (err) {
    console.warn(`[collectInferenceContext] Failed to collect null/unique stats for ${tableName}:`, err);
    // 降级：所有列使用默认值
    for (const col of targetColumns) {
      result.set(col.name, { nullRatio: 0, uniqueCount: 0 });
    }
  }

  // 查询 2: min + max（仅数值/日期类型列）
  const minMaxCols = targetColumns.filter((col) => MIN_MAX_TYPES.has(col.type));
  if (minMaxCols.length > 0) {
    try {
      const minMaxSelects = minMaxCols.map(
        (col) =>
          `MIN(${quoted(col.name)}) AS "${col.name}__min", ` +
          `MAX(${quoted(col.name)}) AS "${col.name}__max"`
      );
      const sql2 = `SELECT ${minMaxSelects.join(", ")} FROM ${tName}`;
      const res2 = await engine.query(sql2);

      if (res2.rows.length > 0) {
        const row = res2.rows[0];
        const colNameMap = new Map<string, number>();
        for (let i = 0; i < res2.columns.length; i++) {
          colNameMap.set(res2.columns[i].name, i);
        }

        for (const col of minMaxCols) {
          const minIdx = colNameMap.get(`${col.name}__min`);
          const maxIdx = colNameMap.get(`${col.name}__max`);
          const minVal = minIdx !== undefined ? row[minIdx] : undefined;
          const maxVal = maxIdx !== undefined ? row[maxIdx] : undefined;

          const existing = result.get(col.name);
          if (existing) {
            // 只在值非 null 时设置（空表时 MIN/MAX 返回 null）
            if (minVal !== null && minVal !== undefined) existing.min = minVal as string | number;
            if (maxVal !== null && maxVal !== undefined) existing.max = maxVal as string | number;
          }
        }
      }
    } catch (err) {
      console.warn(`[collectInferenceContext] Failed to collect min/max stats for ${tableName}:`, err);
      // min/max 失败不影响主流程，已有 nullRatio/uniqueCount
    }
  }

  // 确保所有目标列都有条目
  for (const col of targetColumns) {
    if (!result.has(col.name)) {
      result.set(col.name, { nullRatio: 0, uniqueCount: 0 });
    }
  }

  return result;
}

/**
 * 获取表的主键列名集合
 *
 * 通过 PRAGMA table_info 获取，pk 列 > 0 表示是主键。
 */
async function getPrimaryKeyColumns(
  engine: DuckDBEngine,
  tableName: string
): Promise<Set<string>> {
  const pkSet = new Set<string>();
  try {
    const tName = engine.quoteIdentifier(tableName);
    const res = await engine.query(`PRAGMA table_info(${tName})`);
    for (const row of res.rows) {
      // PRAGMA table_info: cid, name, type, notnull, dflt_value, pk
      const pk = Number(row[5]);
      if (pk > 0) {
        pkSet.add(String(row[1]));
      }
    }
  } catch (err) {
    console.warn(`[collectInferenceContext] Failed to get PK info for ${tableName}:`, err);
  }
  return pkSet;
}

/**
 * 获取表的外键列名集合
 *
 * 通过 PRAGMA foreign_key_list 获取，row[3] 是源列名。
 */
async function getForeignKeyColumns(
  engine: DuckDBEngine,
  tableName: string
): Promise<Set<string>> {
  const fkSet = new Set<string>();
  try {
    const tName = engine.quoteIdentifier(tableName);
    const res = await engine.query(`PRAGMA foreign_key_list(${tName})`);
    for (const row of res.rows) {
      // PRAGMA foreign_key_list: id, seq, table, from, to, on_update, on_delete, match
      const fromCol = String(row[3]);
      if (fromCol) {
        fkSet.add(fromCol);
      }
    }
  } catch (err) {
    // foreign_key_list 在没有外键时可能返回空结果或报错，静默处理
  }
  return fkSet;
}

/**
 * 从 DuckDB 系统表获取列注释
 *
 * DuckDB 存储 column comment 在 duckdb_columns() 系统表中
 * 字段: comment（可能为 NULL）
 */
async function getColumnComments(
  engine: DuckDBEngine,
  tableName: string
): Promise<Map<string, string>> {
  const comments = new Map<string, string>();
  try {
    // 解析 schema.table
    const parts = tableName.split(".");
    const schemaName = parts.length > 1 ? parts[0] : "main";
    const tblName = parts.length > 1 ? parts[1] : tableName;

    const sql = `
      SELECT column_name, comment
      FROM duckdb_columns()
      WHERE schema_name = '${schemaName.replace(/'/g, "''")}'
        AND table_name = '${tblName.replace(/'/g, "''")}'
        AND comment IS NOT NULL
    `;
    const res = await engine.query(sql);
    for (const row of res.rows) {
      const colName = String(row[0]);
      const comment = row[1] !== null ? String(row[1]) : undefined;
      if (comment) {
        comments.set(colName, comment);
      }
    }
  } catch (err) {
    // 系统表查询失败静默处理（旧版 DuckDB 可能不支持）
    console.warn(`[collectInferenceContext] Failed to get column comments for ${tableName}:`, err);
  }
  return comments;
}

/**
 * 从现有字典提取已确认字段含义（作为 knownCalibers 上下文）
 *
 * 格式: ["column_name: 含义", ...]
 */
function extractKnownCalibers(dictionaryEntry: DataDictionaryEntry | undefined): string[] {
  if (!dictionaryEntry) return [];

  const calibers: string[] = [];
  for (const col of dictionaryEntry.columns) {
    if (col.status === "user-confirmed" || col.status === "user-corrected") {
      const meaning = col.userMeaning ?? col.inferredMeaning;
      if (meaning) {
        calibers.push(`${col.name}: ${meaning}`);
      }
    }
  }
  return calibers;
}