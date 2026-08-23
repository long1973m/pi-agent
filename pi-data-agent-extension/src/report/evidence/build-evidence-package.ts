/**
 * Task 2 — Evidence Package 构建
 *
 * 从 Session transcript 中提取结构化证据，组装为 EvidencePackage。
 * 严格遵守 Spec §5 规则：
 * 1. 优先读取结构化工具调用结果，不从 Agent 自然语言回答中反推数字
 * 2. 图表必须关联其原始查询或结果
 * 3. 每个量化 Finding 至少有一个 resultRef 或 chartRef
 * 4. 百分比必须保留分子、分母或计算来源
 * 5. 时间比较必须保留两个时间窗口
 * 6. 无法确认来源的结论移入 hypothesis 或 limitations
 * 7. 不得重新执行查询——只从 transcript 中提取
 */

import type { EvidencePackage, ReportMode, QueryEvidence, ChartEvidence, MetricSnapshot, DictionarySnapshot, Limitation } from "./types.js";
import type { DataDictionaryEntry } from "../../types.js";
import type { SessionEntry } from "../session-transcript.js";
import { getSessionTranscript, mergeToolResults } from "../session-transcript.js";

// ============================================================================
// 参数类型
// ============================================================================

export interface BuildEvidenceParams {
  /** Session entries（从 ctx.sessionManager.getBranch() 获取） */
  sessionEntries: SessionEntry[];
  /** 当前 session ID */
  sessionId: string;
  /** 用户的分析问题（第一条用户消息） */
  question: string;
  /** 报告模式 */
  reportMode: ReportMode;
  /** 数据字典快照 */
  dictionaryEntries: DataDictionaryEntry[];
  /** 口径列表 */
  calibers: Array<{ id: string; question: string; definition: string; confirmedAt: string }>;
  /** 查询记忆（成功的查询） */
  queryMemory: Array<{
    id: string;
    naturalLanguageQuery: string;
    sql: string;
    timestamp: string;
    resultSummary?: string;
  }>;
  /** reports 目录路径（用于查找内联图表） */
  reportsDir: string;
}

// ============================================================================
// 内部辅助类型
// ============================================================================

/** 从 transcript 中提取的工具调用原始数据 */
interface RawQueryData {
  toolCallId: string;
  naturalLanguageQuery: string;
  sql: string;
  success: boolean;
  isError: boolean;
  resultSummary: string;
  /** details 中的结构化信息 */
  details?: Record<string, unknown>;
  /** 关联的表名 */
  dataset?: string;
  /** 执行时间 */
  executionTimeMs?: number;
  /** 列信息 */
  columns: Array<{ name: string; type: string }>;
  /** 总行数 */
  rowCount: number;
  /** 是否被截断 */
  truncated?: boolean;
  /** 不确定性警告 */
  uncertaintyWarnings?: string[];
  /** 字典状态 */
  dictionaryStatus?: string;
  /** 时间戳 */
  generatedAt: string;
}

interface RawVisualize {
  toolCallId: string;
  chartType: string;
  title?: string;
  sql?: string;
  success: boolean;
  pngPath?: string;
  dataset?: string;
  generatedAt: string;
  description?: string;
  /** 关联的 query_data toolCallId */
  sourceToolCallId?: string;
}

interface RawShowImage {
  toolCallId: string;
  filePath: string;
  format: string;
  success: boolean;
}

// ============================================================================
// 结果摘要长度限制
// ============================================================================

/** resultSummary 最大字符数 */
const MAX_RESULT_SUMMARY_LENGTH = 2000;

// ============================================================================
// 核心函数
// ============================================================================

/**
 * 构建 Evidence Package
 *
 * 实现步骤：
 * 1. 从 transcript 提取所有 query_data 工具调用及其结果
 * 2. 从 transcript 提取所有 visualize 工具调用及其结果（图表）
 * 3. 从 transcript 提取 show_image 调用
 * 4. 过滤只保留成功的查询（isError !== true）
 * 5. 提取数据集列表（从 query 的 SQL 和 visualize 的 dataset）
 * 6. 构建 QueryEvidence 列表
 * 7. 构建 ChartEvidence 列表（关联 sourceQueryId）
 * 8. 构建 DictionarySnapshot（从传入的 dictionaryEntries）
 * 9. 构建 MetricSnapshot（从传入的 calibers）
 * 10. 识别 Limitation（从字典中 uncertain 字段、查询失败、数据截断）
 * 11. FindingEvidence 暂时留空（由模型在 Task 3 中生成）
 * 12. 组装并返回 EvidencePackage
 */
export function buildEvidencePackage(params: BuildEvidenceParams): EvidencePackage {
  const {
    sessionEntries,
    sessionId,
    question,
    reportMode,
    dictionaryEntries,
    calibers,
    queryMemory,
    reportsDir,
  } = params;

  // Step 1-3: 从 transcript 提取工具调用
  const transcript = mergeToolResults(getSessionTranscript(sessionEntries));
  const rawQueries = extractQueryDataCalls(transcript);
  const rawCharts = extractVisualizeCalls(transcript);
  const rawImages = extractShowImageCalls(transcript);

  // Step 4: 过滤成功的查询
  const successfulQueries = rawQueries.filter((q) => q.success && !q.isError);

  // Step 5: 提取数据集列表
  const datasets = extractDatasets(successfulQueries, rawCharts, queryMemory);

  // Step 6: 构建 QueryEvidence 列表
  const queries = buildQueryEvidenceList(successfulQueries, queryMemory);

  // Step 7: 构建 ChartEvidence 列表（关联 sourceQueryId）
  const charts = buildChartEvidenceList(rawCharts, rawImages, queries, reportsDir);

  // Step 8: 构建 DictionarySnapshot
  const dictionary = buildDictionarySnapshots(dictionaryEntries);

  // Step 9: 构建 MetricSnapshot
  const metrics = buildMetricSnapshots(calibers);

  // Step 10: 识别 Limitation
  const limitations = buildLimitations(
    successfulQueries,
    rawQueries.filter((q) => !q.success || q.isError),
    dictionaryEntries,
  );

  // Step 11: FindingEvidence 留空（Task 3 由模型生成）

  // Step 12: 组装 EvidencePackage
  return {
    version: 1,
    sessionId,
    question,
    reportMode,
    scope: {
      datasets,
      filters: [],
    },
    metrics,
    findings: [],
    charts,
    queries,
    dictionary,
    limitations,
    generatedAt: new Date().toISOString(),
  };
}

// ============================================================================
// transcript 解析：提取工具调用
// ============================================================================

/**
 * 从 merged transcript 中提取所有 query_data 工具调用
 */
function extractQueryDataCalls(transcript: ReturnType<typeof mergeToolResults>): RawQueryData[] {
  const results: RawQueryData[] = [];

  for (const msg of transcript) {
    if (msg.role !== "assistant" || !msg.toolCalls) continue;

    for (const tc of msg.toolCalls) {
      if (tc.name !== "query_data") continue;

      // 解析参数
      let sql = "";
      let naturalLanguageQuery = "";
      let dataset: string | undefined;

      try {
        // argsSummary 是截断后的 JSON 字符串
        const args = parseToolArgs(tc.argsSummary);
        sql = String(args.sql ?? "");
        naturalLanguageQuery = String(args.user_intent ?? "");
        dataset = args.table_name ? String(args.table_name) : undefined;
      } catch {
        // JSON 解析失败，尝试从 resultSummary 提取
      }

      // 从 SQL 中提取表名作为 dataset 备选
      if (!dataset && sql) {
        const tables = extractTableNamesFromSql(sql);
        if (tables.length > 0) {
          dataset = tables[0];
        }
      }

      results.push({
        toolCallId: tc.id,
        naturalLanguageQuery,
        sql,
        success: !tc.isError,
        isError: tc.isError,
        resultSummary: tc.resultSummary,
        dataset,
        columns: [],
        rowCount: 0,
        generatedAt: msg.timestamp,
      });
    }
  }

  // 回填 details 信息（从 toolResult 的 details 中提取）
  // 注意：mergeToolResults 只回填了 resultSummary 和 isError
  // 实际的 details 信息需要从原始 transcript 的 toolResult 消息中提取
  // 这里我们通过扫描后续 toolResult 来补充结构化信息
  for (const result of results) {
    const correspondingResult = transcript.find(
      (m) => m.role === "toolResult" && m.toolCallId === result.toolCallId
    );
    if (correspondingResult) {
      // 从 resultSummary 中提取行数信息（因为 details 不直接暴露）
      result.rowCount = extractRowCountFromSummary(correspondingResult.content);
      // 从 resultSummary 中提取列信息（列名 + 类型）
      result.columns = extractColumnsFromSummary(correspondingResult.content);
    }
  }

  return results;
}

/**
 * 从 merged transcript 中提取所有 visualize 工具调用
 */
function extractVisualizeCalls(transcript: ReturnType<typeof mergeToolResults>): RawVisualize[] {
  const results: RawVisualize[] = [];

  for (const msg of transcript) {
    if (msg.role !== "assistant" || !msg.toolCalls) continue;

    for (const tc of msg.toolCalls) {
      if (tc.name !== "visualize") continue;

      let sql = "";
      let chartType = "";
      let title: string | undefined;

      try {
        const args = parseToolArgs(tc.argsSummary);
        sql = String(args.sql ?? "");
        chartType = String(args.chart_type ?? "unknown");
        title = args.title ? String(args.title) : undefined;
      } catch {
        // 解析失败
      }

      // 从 SQL 提取表名
      let dataset: string | undefined;
      if (sql) {
        const tables = extractTableNamesFromSql(sql);
        if (tables.length > 0) {
          dataset = tables[0];
        }
      }

      // 从 resultSummary 提取 pngPath
      let pngPath: string | undefined;
      let success = !tc.isError;

      if (tc.resultSummary) {
        const pathMatch = tc.resultSummary.match(/PNG:\s*(\S+)/);
        if (pathMatch) {
          pngPath = pathMatch[1];
        }
      }

      results.push({
        toolCallId: tc.id,
        chartType,
        title,
        sql,
        success,
        pngPath,
        dataset,
        generatedAt: msg.timestamp,
      });
    }
  }

  return results;
}

/**
 * 从 merged transcript 中提取所有 show_image 工具调用
 */
function extractShowImageCalls(transcript: ReturnType<typeof mergeToolResults>): RawShowImage[] {
  const results: RawShowImage[] = [];

  for (const msg of transcript) {
    if (msg.role !== "assistant" || !msg.toolCalls) continue;

    for (const tc of msg.toolCalls) {
      if (tc.name !== "show_image") continue;

      let filePath = "";
      let format = "unknown";

      try {
        const args = parseToolArgs(tc.argsSummary);
        filePath = String(args.file_path ?? "");
      } catch {
        // 解析失败
      }

      // 从 resultSummary 中提取路径和格式
      if (tc.resultSummary) {
        const pathMatch = tc.resultSummary.match(/Image:\s*(\S+)/);
        if (pathMatch) filePath = pathMatch[1];

        const formatMatch = tc.resultSummary.match(/Format:\s*(\S+)/);
        if (formatMatch) format = formatMatch[1];
      }

      results.push({
        toolCallId: tc.id,
        filePath,
        format,
        success: !tc.isError,
      });
    }
  }

  return results;
}

// ============================================================================
// 构建 Evidence 子模块
// ============================================================================

/**
 * 提取数据集列表
 */
function extractDatasets(
  queries: RawQueryData[],
  charts: RawVisualize[],
  queryMemory: BuildEvidenceParams["queryMemory"],
): string[] {
  const datasetSet = new Set<string>();

  // 从成功的查询中提取
  for (const q of queries) {
    if (q.dataset) datasetSet.add(q.dataset);
  }

  // 从图表中提取
  for (const c of charts) {
    if (c.dataset) datasetSet.add(c.dataset);
  }

  // 从查询记忆中提取（通过 SQL 的 FROM 子句）
  for (const mem of queryMemory) {
    const tables = extractTableNamesFromSql(mem.sql);
    for (const t of tables) datasetSet.add(t);
  }

  return Array.from(datasetSet);
}

/**
 * 构建 QueryEvidence 列表
 *
 * 将提取的 query_data 调用转换为 QueryEvidence。
 * 补充来自 queryMemory 的摘要（如果 transcript 中信息不足）。
 */
function buildQueryEvidenceList(
  queries: RawQueryData[],
  queryMemory: BuildEvidenceParams["queryMemory"],
): QueryEvidence[] {
  return queries.map((q, index) => {
    // 尝试从 queryMemory 中匹配更完整的摘要
    const memoryMatch = queryMemory.find(
      (m) => normalizeSql(m.sql) === normalizeSql(q.sql)
    );

    const resultSummary = buildResultSummary(q, memoryMatch);

    return {
      id: `query-${index + 1}`,
      naturalLanguageQuery: q.naturalLanguageQuery || "(extracted from transcript)",
      sql: q.sql,
      success: q.success,
      dataset: q.dataset,
      executionTimeMs: q.executionTimeMs,
      columns: q.columns,
      rowCount: q.rowCount,
      resultSummary,
      referencedByFinding: false,
    };
  });
}

/**
 * 构建 resultSummary
 */
function buildResultSummary(
  q: RawQueryData,
  memoryMatch?: BuildEvidenceParams["queryMemory"][number],
): string {
  let summary = q.resultSummary;

  // 如果 transcript 中 resultSummary 为空但 queryMemory 有摘要，使用 memory 的
  if ((!summary || summary.trim().length === 0) && memoryMatch?.resultSummary) {
    summary = memoryMatch.resultSummary;
  }

  // 标注截断状态
  if (q.truncated) {
    summary = `[TRUNCATED] ${summary}`;
  }

  // 标注不确定性警告
  if (q.uncertaintyWarnings && q.uncertaintyWarnings.length > 0) {
    summary += `\n\nUncertainty warnings:\n${q.uncertaintyWarnings.map((w) => `  - ${w}`).join("\n")}`;
  }

  // 截断到最大长度
  if (summary.length > MAX_RESULT_SUMMARY_LENGTH) {
    summary = summary.slice(0, MAX_RESULT_SUMMARY_LENGTH) + "\n... (truncated for evidence package)";
  }

  return summary;
}

/**
 * 构建 ChartEvidence 列表
 *
 * 关联 sourceQueryId：查找图表 SQL 对应的 query_data 调用。
 */
function buildChartEvidenceList(
  charts: RawVisualize[],
  images: RawShowImage[],
  queries: QueryEvidence[],
  reportsDir: string,
): ChartEvidence[] {
  return charts
    .filter((c) => c.success)
    .map((c, index) => {
      // 尝试关联到 query_data
      let sourceQueryId: string | undefined;

      if (c.sql) {
        const normalizedChartSql = normalizeSql(c.sql);
        const matchedQuery = queries.find(
          (q) => normalizeSql(q.sql) === normalizedChartSql
        );
        if (matchedQuery) {
          sourceQueryId = matchedQuery.id;
        }
      }

      // 构建描述
      const description = buildChartDescription(c);

      return {
        id: `chart-${index + 1}`,
        title: c.title || `Chart ${index + 1}`,
        chartType: c.chartType,
        generatedAt: c.generatedAt,
        dataset: c.dataset,
        sourceQueryId,
        description,
        filePath: c.pngPath,
      };
    });
}

/**
 * 构建图表描述
 */
function buildChartDescription(c: RawVisualize): string {
  const parts: string[] = [];
  if (c.chartType) parts.push(`Type: ${c.chartType}`);
  if (c.dataset) parts.push(`Dataset: ${c.dataset}`);
  return parts.join(", ");
}

/**
 * 构建 DictionarySnapshot 列表
 */
function buildDictionarySnapshots(entries: DataDictionaryEntry[]): DictionarySnapshot[] {
  return entries.map((entry) => ({
    table: entry.tableName,
    columns: entry.columns.map((col) => ({
      name: col.name,
      type: col.type,
      meaning: col.userMeaning ?? col.inferredMeaning,
      status: col.status,
      aliases: col.aliases,
      confidence: col.suggestion?.confidenceLevel,
    })),
  }));
}

/**
 * 构建 MetricSnapshot 列表
 */
function buildMetricSnapshots(
  calibers: BuildEvidenceParams["calibers"],
): MetricSnapshot[] {
  return calibers.map((c) => ({
    id: c.id,
    name: c.question,
    definition: c.definition,
    datasets: [], // datasets 由外层 scope 提供
    confirmedAt: c.confirmedAt,
  }));
}

/**
 * 识别 Limitation
 *
 * 来源：
 * 1. 字典中 uncertain 状态的列
 * 2. 查询失败记录
 * 3. 数据截断声明
 */
function buildLimitations(
  successfulQueries: RawQueryData[],
  failedQueries: RawQueryData[],
  dictionaryEntries: DataDictionaryEntry[],
): Limitation[] {
  const limitations: Limitation[] = [];
  let counter = 0;

  // 1. 字典中 uncertain 列
  for (const entry of dictionaryEntries) {
    const uncertainCols = entry.columns.filter((col) => col.status === "uncertain");
    for (const col of uncertainCols) {
      counter++;
      limitations.push({
        id: `limit-dict-${counter}`,
        description: `Column "${col.name}" in table "${entry.tableName}" has uncertain semantics (AI-inferred: "${col.inferredMeaning}"). Analysis using this column may be inaccurate.`,
        severity: "medium",
        source: `dictionary:${entry.tableName}.${col.name}`,
      });
    }
  }

  // 2. 查询失败
  for (const q of failedQueries) {
    counter++;
    limitations.push({
      id: `limit-failed-query-${counter}`,
      description: `Query failed: "${q.naturalLanguageQuery}". SQL: ${q.sql.slice(0, 200)}. Error in result: ${q.resultSummary.slice(0, 200)}`,
      severity: "medium",
      source: `transcript:query_data:${q.toolCallId}`,
    });
  }

  // 3. 数据截断
  for (const q of successfulQueries) {
    if (q.truncated) {
      counter++;
      limitations.push({
        id: `limit-truncation-${counter}`,
        description: `Query result was truncated. Only partial data is available as evidence. Full dataset was exported but not included in the evidence package. SQL: ${q.sql.slice(0, 200)}`,
        severity: "low",
        source: `transcript:query_data:${q.toolCallId}`,
      });
    }

    // 不确定性警告也作为 limitation
    if (q.uncertaintyWarnings && q.uncertaintyWarnings.length > 0) {
      counter++;
      limitations.push({
        id: `limit-uncertainty-${counter}`,
        description: q.uncertaintyWarnings.join("; "),
        severity: q.dictionaryStatus === "ai-guessed" ? "medium" : "low",
        source: `transcript:query_data:${q.toolCallId}`,
      });
    }
  }

  return limitations;
}

// ============================================================================
// 辅助函数
// ============================================================================

/**
 * 尝试解析 tool args（处理截断的 JSON）
 */
function parseToolArgs(argsSummary: string): Record<string, unknown> {
  try {
    return JSON.parse(argsSummary);
  } catch {
    // 尝试修复截断的 JSON：补全闭合括号
    let fixed = argsSummary.trim();
    const openBraces = (fixed.match(/{/g) || []).length;
    const closeBraces = (fixed.match(/}/g) || []).length;
    if (openBraces > closeBraces) {
      fixed += "}".repeat(openBraces - closeBraces);
    }
    try {
      return JSON.parse(fixed);
    } catch {
      return {};
    }
  }
}

/**
 * 从结果摘要中提取行数
 */
function extractRowCountFromSummary(content: string): number {
  // 尝试匹配 "Rows: N" 模式
  const rowsMatch = content.match(/Rows:\s*(\d+)/);
  if (rowsMatch) return parseInt(rowsMatch[1], 10);

  // 尝试匹配 "N rows" 模式
  const nRowsMatch = content.match(/(\d+)\s+rows?/i);
  if (nRowsMatch) return parseInt(nRowsMatch[1], 10);

  // 尝试匹配 "totalRowCount: N" 模式
  const totalMatch = content.match(/totalRowCount["\s:]+(\d+)/);
  if (totalMatch) return parseInt(totalMatch[1], 10);

  return 0;
}

/**
 * 从结果摘要中提取列信息
 *
 * query_data 的结果文本格式通常包含：
 * - "Columns: name1 (type1), name2 (type2), ..." 模式
 * - 或表格头部 "| name1 | name2 |" 模式
 * - 或 "Schema:" 后跟列定义
 *
 * @returns 列名和类型数组
 */
function extractColumnsFromSummary(content: string): Array<{ name: string; type: string }> {
  const columns: Array<{ name: string; type: string }> = [];

  // 模式 1: "Columns: col1 (INTEGER), col2 (VARCHAR)"
  const columnsMatch = content.match(/Columns:\s*([^\n]+)/i);
  if (columnsMatch) {
    const colsStr = columnsMatch[1];
    const colPattern = /(\w+)\s*\(([^)]+)\)/g;
    let m: RegExpExecArray | null;
    while ((m = colPattern.exec(colsStr)) !== null) {
      columns.push({ name: m[1], type: m[2] });
    }
    if (columns.length > 0) return columns;
  }

  // 模式 2: "| col1 | col2 |" 表格头部（第一行）
  const lines = content.split("\n");
  for (const line of lines) {
    const tableMatch = line.match(/^\|\s*([^|]+(?:\|[^|]+)*)\s*\|$/);
    if (tableMatch && line.includes("|")) {
      const cells = line.split("|").map((c) => c.trim()).filter((c) => c.length > 0);
      // 检查是否是分隔行（如 |---|---|）
      if (cells.every((c) => /^[-:]+$/.test(c))) continue;
      // 如果是表头，直接返回列名（类型未知）
      return cells.map((name) => ({ name, type: "unknown" }));
    }
  }

  // 模式 3: "Schema:" 后跟列定义
  const schemaIdx = lines.findIndex((l) => /schema/i.test(l));
  if (schemaIdx >= 0 && schemaIdx + 1 < lines.length) {
    const schemaLine = lines[schemaIdx + 1];
    const colPattern = /(\w+)\s*[:\s]\s*(\w+)/g;
    let m: RegExpExecArray | null;
    while ((m = colPattern.exec(schemaLine)) !== null) {
      columns.push({ name: m[1], type: m[2] });
    }
    if (columns.length > 0) return columns;
  }

  return columns;
}

/**
 * 从 SQL 中提取表名（FROM / JOIN 子句）
 */
function extractTableNamesFromSql(sql: string): string[] {
  let cleaned = sql.replace(/'[^']*'/g, "''");
  cleaned = cleaned.replace(/--[^\n]*/g, "");
  cleaned = cleaned.replace(/\/\*[\s\S]*?\*\//g, "");

  const tables: string[] = [];
  const regex = /\b(?:FROM|JOIN)\s+([a-zA-Z_][a-zA-Z0-9_]*(?:\.[a-zA-Z_][a-zA-Z0-9_]*)?)/gi;
  let m: RegExpExecArray | null;
  while ((m = regex.exec(cleaned)) !== null) {
    tables.push(m[1]);
  }
  return [...new Set(tables)];
}

/**
 * SQL 标准化（用于比较）：去除多余空白、统一大小写
 */
function normalizeSql(sql: string): string {
  return sql
    .replace(/\s+/g, " ")
    .replace(/;+\s*$/, "")
    .trim()
    .toLowerCase();
}
