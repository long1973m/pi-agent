/**
 * Dashboard — 数据集 Reader
 *
 * 通过 DuckDB 只读连接提供：
 * 1. 表列表
 * 2. 数据预览（前 N 行）
 * 3. Schema 信息
 * 4. 列统计（full / approximate / sample）
 */

import type { DuckDBEngine } from "../../engine/duckdb.js";
import type { DatasetItem, ColumnStatsInfo } from "../types.js";
import { PREVIEW_DEFAULT_ROWS, PREVIEW_MAX_ROWS, STATS_TIMEOUT_MS, STATS_MAX_COLUMNS } from "../config.js";
import { quoteSqlIdentifier } from "../../utils/sql.js";

/**
 * 数据集 Reader
 */
export class DatasetReader {
  private engine: DuckDBEngine | null;

  constructor(engine: DuckDBEngine | null) {
    this.engine = engine;
  }

  /**
   * 获取数据集列表
   */
  async listDatasets(): Promise<DatasetItem[]> {
    if (!this.engine) throw new Error("DuckDB 引擎未初始化");

    const tables = await this.engine.getTables();
    const items: DatasetItem[] = [];

    for (const tableName of tables) {
      try {
        const overview = await this.engine.getTableOverview(tableName);
        items.push({
          name: tableName,
          rowCount: overview.rowCount,
          columnCount: overview.columnCount,
        });
      } catch {
        items.push({ name: tableName, rowCount: -1, columnCount: -1 });
      }
    }

    return items;
  }

  /**
   * 获取数据预览
   */
  async preview(tableName: string, rows: number = PREVIEW_DEFAULT_ROWS): Promise<{
    columns: Array<{ name: string; type: string }>;
    rows: unknown[][];
    totalRowCount: number;
    requestedRows: number;
    returnedRows: number;
    calculationMode: "full";
  }> {
    if (!this.engine) throw new Error("DuckDB 引擎未初始化");

    // 表名安全：只允许已索引的表
    const tables = await this.engine.getTables();
    if (!tables.includes(tableName)) {
      throw new Error(`表 "${tableName}" 不存在`);
    }

    // 限制行数
    const safeRows = Math.min(Math.max(1, rows), PREVIEW_MAX_ROWS);

    // 获取 schema
    const schema = await this.engine.getSchema(tableName);

    // 执行预览查询（使用安全引用）
    const escapedTable = this.escapeIdentifier(tableName);
    const result = await this.engine.query(
      `SELECT * FROM ${escapedTable} LIMIT ${safeRows}`
    );

    // 获取总行数
    let totalRowCount = -1;
    try {
      const countResult = await this.engine.query(
        `SELECT COUNT(*) AS cnt FROM ${escapedTable}`
      );
      if (countResult.rows.length > 0) {
        totalRowCount = Number(countResult.rows[0][0]) || 0;
      }
    } catch {
      // count 失败不阻塞
    }

    return {
      columns: schema.map((col) => ({ name: col.name, type: col.type })),
      rows: result.rows,
      totalRowCount,
      requestedRows: safeRows,
      returnedRows: result.rows.length,
      calculationMode: "full",
    };
  }

  /**
   * 获取表 Schema
   */
  async getSchema(tableName: string): Promise<Array<{ name: string; type: string; nullable: boolean }>> {
    if (!this.engine) throw new Error("DuckDB 引擎未初始化");

    const tables = await this.engine.getTables();
    if (!tables.includes(tableName)) {
      throw new Error(`表 "${tableName}" 不存在`);
    }

    const schema = await this.engine.getSchema(tableName);
    return schema.map((col) => ({
      name: col.name,
      type: col.type,
      nullable: col.nullable,
    }));
  }

  /**
   * 获取列统计
   */
  async getStats(
    tableName: string,
    mode: "auto" | "full" | "approximate" | "sample" = "auto",
  ): Promise<{
    tableName: string;
    stats: ColumnStatsInfo[];
    calculationMode: "full" | "approximate" | "sample";
    timedOut: boolean;
  }> {
    if (!this.engine) throw new Error("DuckDB 引擎未初始化");

    const tables = await this.engine.getTables();
    if (!tables.includes(tableName)) {
      throw new Error(`表 "${tableName}" 不存在`);
    }

    const schema = await this.engine.getSchema(tableName);

    // 超过 STATS_MAX_COLUMNS 时提示选择列
    if (schema.length > STATS_MAX_COLUMNS) {
      throw new Error(
        `表 "${tableName}" 有 ${schema.length} 列，超过最大列数 ${STATS_MAX_COLUMNS}。请选择部分列查看统计。`
      );
    }

    const escapedTable = this.escapeIdentifier(tableName);
    let calculationMode: "full" | "approximate" | "sample" = "full";
    let timedOut = false;

    const stats: ColumnStatsInfo[] = [];

    // 尝试带超时的统计计算
    try {
      const result = await this.withTimeout(
        this.computeStats(this.engine, escapedTable, schema, mode),
        STATS_TIMEOUT_MS
      );
      stats.push(...result);
    } catch (err) {
      if (err instanceof TimeoutError) {
        timedOut = true;
        // 降级为样本统计
        calculationMode = "sample";
        try {
          const sampleResult = await this.computeStats(
            this.engine,
            escapedTable,
            schema,
            "sample"
          );
          stats.push(...sampleResult);
        } catch {
          // 样本统计也失败，返回空统计
        }
      } else {
        throw err;
      }
    }

    return { tableName, stats, calculationMode, timedOut };
  }

  // =========================================================================
  // Private
  // =========================================================================

  private async computeStats(
    engine: DuckDBEngine,
    escapedTable: string,
    schema: Array<{ name: string; type: string; nullable: boolean }>,
    mode: string,
  ): Promise<ColumnStatsInfo[]> {
    const stats: ColumnStatsInfo[] = [];

    for (const col of schema) {
      const colName = this.escapeIdentifier(col.name);
      const numericTypes = new Set([
        "INTEGER", "BIGINT", "SMALLINT", "TINYINT", "UBIGINT", "UINTEGER",
        "USMALLINT", "UTINYINT", "FLOAT", "DOUBLE", "DECIMAL",
      ]);

      try {
        let calcMode: "full" | "approximate" | "sample" = "full";

        if (mode === "sample") {
          calcMode = "sample";
        }

        // 构建统计 SQL
        let sql: string;
        if (numericTypes.has(col.type)) {
          if (mode === "approximate" || mode === "auto") {
            sql = `SELECT
              COUNT(*) AS total,
              SUM(CASE WHEN ${colName} IS NULL THEN 1 ELSE 0 END) AS null_count,
              APPROX_COUNT_DISTINCT(${colName}) AS unique_count,
              MIN(${colName}) AS min_val,
              MAX(${colName}) AS max_val,
              AVG(${colName}) AS avg_val
            FROM ${escapedTable}`;
            calcMode = "approximate";
          } else if (mode === "sample") {
            const sampleTable = `(SELECT * FROM ${escapedTable} USING SAMPLE 10000)`;
            sql = `SELECT
              COUNT(*) AS total,
              SUM(CASE WHEN ${colName} IS NULL THEN 1 ELSE 0 END) AS null_count,
              COUNT(DISTINCT ${colName}) AS unique_count,
              MIN(${colName}) AS min_val,
              MAX(${colName}) AS max_val,
              AVG(${colName}) AS avg_val
            FROM ${sampleTable} AS _sample`;
          } else {
            sql = `SELECT
              COUNT(*) AS total,
              SUM(CASE WHEN ${colName} IS NULL THEN 1 ELSE 0 END) AS null_count,
              COUNT(DISTINCT ${colName}) AS unique_count,
              MIN(${colName}) AS min_val,
              MAX(${colName}) AS max_val,
              AVG(${colName}) AS avg_val
            FROM ${escapedTable}`;
          }
        } else {
          if (mode === "sample") {
            const sampleTable = `(SELECT * FROM ${escapedTable} USING SAMPLE 10000)`;
            sql = `SELECT
              COUNT(*) AS total,
              SUM(CASE WHEN ${colName} IS NULL THEN 1 ELSE 0 END) AS null_count,
              COUNT(DISTINCT ${colName}) AS unique_count
            FROM ${sampleTable} AS _sample`;
          } else {
            sql = `SELECT
              COUNT(*) AS total,
              SUM(CASE WHEN ${colName} IS NULL THEN 1 ELSE 0 END) AS null_count,
              APPROX_COUNT_DISTINCT(${colName}) AS unique_count
            FROM ${escapedTable}`;
            calcMode = "approximate";
          }
        }

        const result = await engine.query(sql);
        if (result.rows.length > 0) {
          const row = result.rows[0];
          const total = Number(row[0]) || 0;
          const nullCount = Number(row[1]) || 0;

          const stat: ColumnStatsInfo = {
            name: col.name,
            type: col.type,
            nullCount,
            nullRatio: total > 0 ? nullCount / total : 0,
            uniqueCount: Number(row[2]) || 0,
            calculationMode: calcMode,
          };

          if (numericTypes.has(col.type) && row.length >= 6) {
            stat.min = row[3] as number;
            stat.max = row[4] as number;
            stat.avg = typeof row[5] === "number" ? Math.round(row[5] * 100) / 100 : undefined;
          }

          stats.push(stat);
        }
      } catch (err) {
        // 单列统计失败不阻塞其他列
        console.warn(`[DatasetReader] Stats failed for ${col.name}:`, err);
        stats.push({
          name: col.name,
          type: col.type,
          nullCount: 0,
          nullRatio: 0,
          uniqueCount: -1,
          calculationMode: "full",
        });
      }
    }

    return stats;
  }

  /** DuckDB 标识符安全引用（R-1 收敛：实现见 utils/sql.ts 的 quoteSqlIdentifier） */
  private escapeIdentifier(name: string): string {
    return quoteSqlIdentifier(name);
  }

  /** 带超时的 Promise 包装 */
  private async withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
    return Promise.race([
      promise,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new TimeoutError(`操作超时 (${ms}ms)`)), ms)
      ),
    ]);
  }
}

class TimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TimeoutError";
  }
}
