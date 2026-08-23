/**
 * 工具共享上下文
 *
 * 所有 Phase 2 工具的共享依赖接口，解耦 Pi Extension API 和具体实现。
 */

import type { DuckDBEngine } from "../engine/duckdb.js";
import type { SecurityChecker } from "../security.js";
import type { PersistenceManager } from "../persistence.js";
import type { AppConfig } from "../config.js";
import type { DataDictionaryManager } from "../hooks/data-dictionary.js";
import type { QueryMemoryManager } from "../hooks/query-memory.js";
import type { TableCardStore } from "../table-cards/store.js";
import { maskPII } from "../pii-guard.js";

/** 工具运行时上下文 */
export interface ToolContext {
  engine: DuckDBEngine | null;
  security: SecurityChecker;
  persistence: PersistenceManager;
  cwd: string;
  config: AppConfig;
  dataDictionary: DataDictionaryManager;
  queryMemory: QueryMemoryManager;
  /** v0.10 A-3: 表卡片存储（可选，load_data 起草与 get_table_card 消费） */
  tableCards?: TableCardStore;
  /** v0.10 A-3/A-4: LLM 调用函数（可选，session_start 时从 ctx.model 初始化） */
  callLLM?: (prompt: string, systemPrompt?: string) => Promise<string>;
}

/** 工具注册参数 */
export interface ToolRegisterParams {
  /** 获取当前 runtime context 的回调 */
  getRuntime: () => ToolContext | null;
}

/**
 * 格式化 QueryResult 为可读文本
 *
 * 用于工具返回的 content 文本部分，保持简洁。
 */
export function formatQueryResult(result: {
  columns: Array<{ name: string }>;
  rows: unknown[][];
  totalRowCount: number;
  returnedRowCount: number;
  truncated: boolean;
  csvPath?: string;
  executionTimeMs?: number;
}): string {
  const parts: string[] = [];

  // 表格头
  const header = result.columns.map((c) => c.name).join(" | ");
  const separator = result.columns.map(() => "---").join("-+-");

  // 数据行（最多显示前 20 行）— 对每个单元格值做 PII 脱敏
  const displayRows = result.rows.slice(0, 20);
  const rows = displayRows.map((r) => r.map((v) => maskPII(String(v ?? "NULL")).masked).join(" | "));

  parts.push(header);
  parts.push(separator);
  parts.push(...rows);

  // 统计信息
  const stats: string[] = [];
  stats.push(`Rows: ${result.returnedRowCount}${result.totalRowCount !== result.returnedRowCount ? ` / ${result.totalRowCount}` : ""}`);
  if (result.truncated) stats.push("TRUNCATED");
  if (result.csvPath) stats.push(`Full result: ${result.csvPath}`);
  if (result.executionTimeMs) stats.push(`${result.executionTimeMs}ms`);

  parts.push(`\n[${stats.join(", ")}]`);

  return parts.join("\n");
}
