/**
 * Pi Data Agent — DuckDB 引擎
 *
 * 职责：
 * 1. 连接/初始化 DuckDB 实例（文件模式，支持持久化）
 * 2. 执行查询（只读）和命令（写操作）
 * 3. 大结果处理：COUNT → 预览 N 行 → 落盘 CSV
 * 4. Schema  introspection：表列表、表结构、样本数据
 * 5. WAL 事务安全 + 崩溃自恢复
 *
 * 验收标准：
 * - 创建 session.duckdb，执行 SELECT 1 返回正确结果
 * - 查询 1000+ 行只返回前 100 行 + 总行数 + 落盘路径
 * - 进程重启后重新连接，数据仍在
 */

import {
  DuckDBInstance,
  DuckDBConnection,
  DuckDBResultReader,
} from "@duckdb/node-api";
import { mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { createLogger } from "../utils/logger.js";
import { quoteSqlIdentifier } from "../utils/sql.js";
import type {
  QueryResult,
  ColumnInfo,
  TableOverview,
  DuckDBColumnType,
} from "../types.js";

/**
 * 规范化 DuckDB 类型名：去掉括号及之后的部分再转大写。
 * 例：DECIMAL(9,2) → DECIMAL、VARCHAR(10) → VARCHAR、Timestamp → TIMESTAMP
 */
export function normalizeDuckDBTypeName(duckdbType: string): string {
  const parenIndex = duckdbType.indexOf("(");
  const base = parenIndex >= 0 ? duckdbType.slice(0, parenIndex) : duckdbType;
  return base.trim().toUpperCase();
}

/** DuckDB 引擎配置 */
export interface DuckDBEngineConfig {
  /** 数据库文件路径 */
  dbPath: string;
  /** 大结果预览行数限制 */
  previewLimit: number;
  /** 查询结果落盘目录 */
  outputDir: string;
}

/** DuckDB 引擎 */
const logger = createLogger("duckdb");

export class DuckDBEngine {
  private config: DuckDBEngineConfig;
  private instance: DuckDBInstance | null = null;
  private connection: DuckDBConnection | null = null;
  private initialized = false;
  /** 互斥锁：确保同一时间只有一个查询使用 connection */
  private queryQueue: Promise<unknown> = Promise.resolve();

  constructor(config: DuckDBEngineConfig) {
    this.config = config;
  }

  /**
   * 串行执行：将操作排入队列，确保同一时间只有一个查询在 connection 上运行
   *
   * 这解决了单连接并发查询结果错乱的问题。
   */
  private runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.queryQueue.then(fn, fn); // 无论前一个成功/失败都继续
    // 更新队列为当前操作的结果（忽略错误，避免一个失败阻塞后续所有查询）
    this.queryQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  // ==========================================================================
  // 生命周期
  // ==========================================================================

  /** 初始化：创建目录、连接数据库、启用 WAL */
  async init(): Promise<void> {
    if (this.initialized) return;

    // 确保目录存在
    mkdirSync(dirname(this.config.dbPath), { recursive: true });
    mkdirSync(this.config.outputDir, { recursive: true });

    // 连接（文件已存在则复用，不存在则创建）
    this.instance = await DuckDBInstance.create(this.config.dbPath);
    this.connection = await this.instance.connect();

    // 设置 DuckDB home 目录到项目目录（避免沙箱中 ~/.duckdb 权限问题）
    const homeDir = dirname(this.config.dbPath);
    try {
      await this.connection.run(`SET home_directory = '${homeDir.replace(/'/g, "''")}'`);
    } catch {
      // 某些 DuckDB 版本可能不支持此设置，忽略
    }

    // DuckDB 文件模式天然持久化，无需显式 WAL 配置
    this.initialized = true;
    logger.debug(`Connected to ${this.config.dbPath}`);
  }

  /** 关闭连接 */
  async close(): Promise<void> {
    if (this.connection) {
      this.connection.disconnectSync();
      this.connection = null;
    }
    this.instance = null;
    this.initialized = false;
    logger.debug("Disconnected");
  }

  /** 重新连接（崩溃恢复） */
  async reconnect(): Promise<void> {
    // 等待队列中所有操作完成后再重连
    await this.queryQueue.catch(() => {});
    await this.close();
    await this.init();
  }

  /** 确保已初始化 */
  private ensureInitialized(): void {
    if (!this.initialized || !this.connection) {
      throw new Error("DuckDBEngine not initialized. Call init() first.");
    }
  }

  // ==========================================================================
  // 核心查询
  // ==========================================================================

  /**
   * 执行只读查询，返回完整结果（小结果集）
   *
   * 适用：已知结果行数较少的查询（如 COUNT、DESCRIBE）
   */
  async query(sql: string): Promise<QueryResult> {
    this.ensureInitialized();
    return this.runExclusive(async () => {
      const start = Date.now();

      const reader = await this.connection!.runAndReadAll(sql);
      const columns = this.extractColumns(reader);
      const rows = reader.getRowsJson();

      return {
        columns,
        rows,
        totalRowCount: rows.length,
        returnedRowCount: rows.length,
        truncated: false,
        executionTimeMs: Date.now() - start,
      };
    });
  }

  /**
   * 执行写操作（INSERT/UPDATE/CREATE 等）
   *
   * 返回影响行数（如适用）
   */
  async exec(sql: string): Promise<{ rowCount: number }> {
    this.ensureInitialized();
    return this.runExclusive(async () => {
      await this.connection!.run(sql);

      // DuckDB 不直接返回 affected rows，尝试用 changes() 获取
      try {
        const changes = await this.connection!.runAndReadAll("SELECT changes() AS cnt");
        const rows = changes.getRowsJson();
        const cnt = rows.length > 0 ? Number(rows[0][0]) : 0;
        return { rowCount: cnt };
      } catch {
        return { rowCount: 0 };
      }
    });
  }

  // ==========================================================================
  // 大结果处理
  // ==========================================================================

  /**
   * 执行查询并处理大结果集
   *
   * 流程：
   * 1. 先 COUNT(*) 获取总行数
   * 2. 如果 <= previewLimit，直接返回全部
   * 3. 如果 > previewLimit，只取前 N 行 + 落盘 CSV
   *
   * 返回：预览行 + 总行数 + 落盘路径（如有）
   */
  async executeQueryWithLimit(sql: string): Promise<QueryResult> {
    this.ensureInitialized();
    return this.runExclusive(async () => {
      const start = Date.now();

      // 1. 提取基础 SQL（去掉 LIMIT/OFFSET/ORDER BY 用于 COUNT）
      const countSql = this.buildCountSql(sql);

      const countResult = await this.connection!.runAndReadAll(countSql);
      const countRows = countResult.getRowsJson();
      const totalRowCount = countRows.length > 0 ? Number(countRows[0][0]) : 0;

      // 2. 小结果集：直接返回
      if (totalRowCount <= this.config.previewLimit) {
        const reader = await this.connection!.runAndReadAll(sql);
        const columns = this.extractColumns(reader);
        const rows = reader.getRowsJson();

        return {
          columns,
          rows,
          totalRowCount,
          returnedRowCount: rows.length,
          truncated: false,
          executionTimeMs: Date.now() - start,
        };
      }

      // 3. 大结果集：预览 + 落盘
      const previewSql = this.buildPreviewSql(sql, this.config.previewLimit);
      const previewReader = await this.connection!.runAndReadAll(previewSql);
      const columns = this.extractColumns(previewReader);
      const previewRows = previewReader.getRowsJson();

      // 落盘 CSV
      const csvPath = join(
        this.config.outputDir,
        `query_${Date.now()}.csv`
      );
      await this.exportToCsv(sql, csvPath);

      return {
        columns,
        rows: previewRows,
        totalRowCount,
        returnedRowCount: previewRows.length,
        truncated: true,
        csvPath,
        executionTimeMs: Date.now() - start,
      };
    });
  }

  /** 导出查询结果为 CSV */
  private async exportToCsv(sql: string, csvPath: string): Promise<void> {
    const exportSql = `COPY (${sql}) TO '${csvPath}' (HEADER, DELIMITER ',');`;
    await this.connection!.run(exportSql);
  }

  /** 构造 COUNT SQL */
  private buildCountSql(sql: string): string {
    const trimmed = sql.trim();
    // 简单包裹：如果已有 LIMIT，先去掉
    const withoutLimit = trimmed.replace(/\s+LIMIT\s+\d+(\s+OFFSET\s+\d+)?\s*;?\s*$/i, "");
    return `SELECT COUNT(*) FROM (${withoutLimit}) AS _count_subquery_`;
  }

  /** 构造预览 SQL（加 LIMIT） */
  private buildPreviewSql(sql: string, limit: number): string {
    const trimmed = sql.trim();
    // 如果已有 LIMIT 且更小，保留原 LIMIT
    const existingLimit = trimmed.match(/\s+LIMIT\s+(\d+)\s*;?\s*$/i);
    if (existingLimit) {
      const existing = parseInt(existingLimit[1], 10);
      if (existing <= limit) return trimmed;
    }
    // 去掉末尾分号，加 LIMIT
    const withoutSemi = trimmed.replace(/;\s*$/, "");
    return `${withoutSemi} LIMIT ${limit}`;
  }

  // ==========================================================================
  // Schema Introspection
  // ==========================================================================

  /** 获取所有表名 */
  async getTables(): Promise<string[]> {
    this.ensureInitialized();
    return this.runExclusive(async () => {
      const reader = await this.connection!.runAndReadAll(
        "SELECT table_name FROM information_schema.tables WHERE table_schema = 'main' ORDER BY table_name"
      );
      const rows = reader.getRowsJson();
      return rows.map((r) => String(r[0]));
    });
  }

  /** 获取表结构 */
  async getSchema(tableName: string): Promise<ColumnInfo[]> {
    this.ensureInitialized();
    return this.runExclusive(async () => {
      // 支持 schema.table 格式（如 sqlite attach 后的表）
      const parts = tableName.split(".");
      const pragmaArg = parts.length === 2
        ? `${this.quoteIdentifier(parts[0])}.${this.quoteIdentifier(parts[1])}`
        : this.quoteIdentifier(tableName);
      const reader = await this.connection!.runAndReadAll(
        `PRAGMA table_info(${pragmaArg})`
      );
      const rows = reader.getRowsJson();
      // PRAGMA table_info returns: cid, name, type, notnull, dflt_value, pk
      return rows.map((row) => ({
        name: String(row[1]),
        type: this.mapDuckDBType(String(row[2])),
        nullable: !row[3], // notnull is boolean
      }));
    });
  }

  /** 获取表样本数据 */
  async getSample(tableName: string, limit = 5): Promise<unknown[][]> {
    this.ensureInitialized();
    return this.runExclusive(async () => {
      const reader = await this.connection!.runAndReadAll(
        `SELECT * FROM ${this.quoteIdentifier(tableName)} LIMIT ${limit}`
      );
      return reader.getRowsJson();
    });
  }

  /**
   * 快速加载数据 — 不执行全表 COUNT(*)
   *
   * 显著快于 getTableOverview，适用于大文件加载场景：
   * - 用 PRAGMA table_info 获取列信息（毫秒级，读元数据）
   * - 用 SELECT * LIMIT N 获取样本同时估算总行数
   * - 不执行 SELECT COUNT(*)（避免全表扫描，对大文件节省数秒到数分钟）
   *
   * @param tableName 表名
   * @param sampleSize 采样行数（默认 100）
   * @returns TableOverview，rowCount 为 -1 表示"未统计精确值"
   */
  async loadTableFast(
    tableName: string,
    sampleSize: number = 100
  ): Promise<TableOverview> {
    this.ensureInitialized();
    return this.runExclusive(async () => {
      // 1. 获取列信息（PRAGMA 是元数据操作，极快）
      const columns = await this.getSchemaInternal(tableName);

      // 2. 使用 DuckDB 内置 estimated_size 快速获取行数
      //    注：DuckDB v1.5.x 中 estimated_size 直接返回 BIGINT 行数，无需额外 COUNT(*)
      //    对于旧版 DuckDB 若 estimated_size 不可用，回退到精确 COUNT(*)
      let rowCount = -1;
      let estimated = false;
      try {
        const result = await this.connection!.runAndReadAll(
          `SELECT estimated_size FROM duckdb_tables() WHERE table_name = '${tableName.replace(/'/g, "''")}'`
        );
        const rows = result.getRowsJson();
        if (rows.length > 0 && rows[0][0] != null && rows[0][0] !== 0) {
          // estimated_size 是可用的快速行数来源
          rowCount = typeof rows[0][0] === "bigint" ? Number(rows[0][0]) : parseInt(String(rows[0][0]), 10);
        } else {
          // 回退到精确 COUNT(*)
          const countResult = await this.connection!.runAndReadAll(
            `SELECT COUNT(*)::BIGINT FROM ${this.quoteIdentifier(tableName)}`
          );
          rowCount = Number(countResult.getRowsJson()[0][0]);
        }
      } catch {
        // 若 estimated_size 不可用，回退到精确 COUNT(*)
        try {
          const countResult = await this.connection!.runAndReadAll(
            `SELECT COUNT(*)::BIGINT FROM ${this.quoteIdentifier(tableName)}`
          );
          rowCount = Number(countResult.getRowsJson()[0][0]);
        } catch {
          // 完全失败则保持 -1
        }
      }

      return {
        name: tableName,
        rowCount,
        columnCount: columns.length,
        columns,
        rowCountEstimated: estimated,
      } as TableOverview & { rowCountEstimated: boolean };
    });
  }

  /** 获取表概览（行数、列数、列信息） */
  async getTableOverview(tableName: string): Promise<TableOverview> {
    this.ensureInitialized();
    return this.runExclusive(async () => {
      const schema = await this.getSchemaInternal(tableName);
      const countResult = await this.connection!.runAndReadAll(
        `SELECT COUNT(*) FROM ${this.quoteIdentifier(tableName)}`
      );

      const countRows = countResult.getRowsJson();
      const rowCount = countRows.length > 0 ? Number(countRows[0][0]) : 0;

      return {
        name: tableName,
        rowCount,
        columnCount: schema.length,
        columns: schema,
      };
    });
  }

  /** getSchema 的内部实现（不加锁，由调用方加锁） */
  private async getSchemaInternal(tableName: string): Promise<ColumnInfo[]> {
    // 支持 schema.table 格式（如 sqlite attach 后的表）
    const parts = tableName.split(".");
    const pragmaArg = parts.length === 2
      ? `${this.quoteIdentifier(parts[0])}.${this.quoteIdentifier(parts[1])}`
      : this.quoteIdentifier(tableName);
    const reader = await this.connection!.runAndReadAll(
      `PRAGMA table_info(${pragmaArg})`
    );
    const rows = reader.getRowsJson();
    return rows.map((row) => ({
      name: String(row[1]),
      type: this.mapDuckDBType(String(row[2])),
      nullable: !row[3],
    }));
  }

  // ==========================================================================
  // 辅助方法
  // ==========================================================================

  /** 从 ResultReader 提取列信息 */
  private extractColumns(reader: DuckDBResultReader): ColumnInfo[] {
    const columns: ColumnInfo[] = [];
    const columnNames = reader.columnNames();
    const columnTypes = reader.columnTypes();

    for (let i = 0; i < columnNames.length; i++) {
      columns.push({
        name: columnNames[i],
        type: this.mapDuckDBType(columnTypes[i].toString()),
        nullable: true, // DuckDB DESCRIBE 不直接返回 nullable，默认 true
      });
    }

    return columns;
  }

  /** 映射 DuckDB 类型到我们的类型 */
  private mapDuckDBType(duckdbType: string): DuckDBColumnType {
    // 带精度/参数的类型（如 DECIMAL(9,2)、VARCHAR(10)）先规范化为裸类型名再查表
    const upper = normalizeDuckDBTypeName(duckdbType);

    // 直接映射
    const directMap: Record<string, DuckDBColumnType> = {
      BOOLEAN: "BOOLEAN",
      TINYINT: "TINYINT",
      SMALLINT: "SMALLINT",
      INTEGER: "INTEGER",
      BIGINT: "BIGINT",
      UTINYINT: "UTINYINT",
      USMALLINT: "USMALLINT",
      UINTEGER: "UINTEGER",
      UBIGINT: "UBIGINT",
      FLOAT: "FLOAT",
      DOUBLE: "DOUBLE",
      DECIMAL: "DECIMAL",
      VARCHAR: "VARCHAR",
      DATE: "DATE",
      TIME: "TIME",
      TIMESTAMP: "TIMESTAMP",
      TIMESTAMP_S: "TIMESTAMP_S",
      TIMESTAMP_MS: "TIMESTAMP_MS",
      TIMESTAMP_NS: "TIMESTAMP_NS",
      INTERVAL: "INTERVAL",
      BLOB: "BLOB",
      UUID: "UUID",
      JSON: "JSON",
    };

    if (directMap[upper]) return directMap[upper];

    // 复合类型前缀匹配
    if (upper.startsWith("ARRAY")) return "ARRAY";
    if (upper.startsWith("LIST")) return "LIST";
    if (upper.startsWith("MAP")) return "MAP";
    if (upper.startsWith("STRUCT")) return "STRUCT";
    if (upper.startsWith("UNION")) return "UNION";

    // 常见别名
    if (upper === "INT") return "INTEGER";
    if (upper === "INT8") return "BIGINT";
    if (upper === "INT4") return "INTEGER";
    if (upper === "INT2") return "SMALLINT";
    if (upper === "INT1") return "TINYINT";
    if (upper === "STRING") return "VARCHAR";
    if (upper === "TEXT") return "VARCHAR";
    if (upper === "DATETIME") return "TIMESTAMP";
    if (upper === "NUMERIC") return "DECIMAL";

    // 未知类型，保守返回 VARCHAR
    console.warn(`[DuckDBEngine] Unknown DuckDB type: ${duckdbType}, defaulting to VARCHAR`);
    return "VARCHAR";
  }

  /**
   * 安全地引用标识符（R-1 收敛：实现见 utils/sql.ts 的 quoteSqlIdentifier）。
   * 语义由"白名单正则 + 抛异常"统一为 `""` 转义（DuckDB 标准，可承载含引号/
   * 连字符等合法名称），保留控制字符（NUL/CR/LF）拒绝防护。
   */
  quoteIdentifier(name: string): string {
    return quoteSqlIdentifier(name);
  }
}

/** 创建默认引擎（基于当前 cwd） */
export function createDefaultEngine(cwd?: string): DuckDBEngine {
  const resolvedCwd = cwd ?? process.cwd();
  return new DuckDBEngine({
    dbPath: join(resolvedCwd, ".pi-data-agent", "session.duckdb"),
    previewLimit: 100,
    outputDir: join(resolvedCwd, ".pi-data-agent", "output"),
  });
}
