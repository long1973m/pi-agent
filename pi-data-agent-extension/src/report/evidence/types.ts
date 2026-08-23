/**
 * Evidence Package 类型定义
 *
 * Evidence Package 是正式报告的唯一事实输入。
 * 从 Session transcript 中提取结构化证据（查询结果、图表、口径、字典），
 * 避免模型从冗长聊天记录中自由总结。
 */

// ============================================================================
// 报告模式
// ============================================================================

/** 报告模式 */
export type ReportMode = "executive" | "detailed";

// ============================================================================
// 证据包
// ============================================================================

/** 证据包 */
export interface EvidencePackage {
  version: 1;
  sessionId: string;
  question: string;
  reportMode: ReportMode;
  scope: {
    datasets: string[];
    dateRange?: { start: string; end: string };
    filters: Array<{ field: string; operator: string; value: unknown }>;
  };
  metrics: MetricSnapshot[];
  findings: FindingEvidence[];
  charts: ChartEvidence[];
  queries: QueryEvidence[];
  dictionary: DictionarySnapshot[];
  limitations: Limitation[];
  generatedAt: string;
}

// ============================================================================
// 指标快照
// ============================================================================

/** 指标快照 */
export interface MetricSnapshot {
  id: string;
  name: string;
  definition: string;
  datasets: string[];
  confirmedAt: string;
}

// ============================================================================
// 发现证据
// ============================================================================

/** 发现证据 */
export interface FindingEvidence {
  id: string;
  statement: string;
  evidenceType: "direct" | "derived" | "hypothesis";
  resultRefs: string[];
  chartRefs: string[];
  queryRefs: string[];
  metricRefs: string[];
  confidence: "high" | "medium" | "low";
  caveats: string[];
}

// ============================================================================
// 图表证据
// ============================================================================

/** 图表证据 */
export interface ChartEvidence {
  id: string;
  title: string;
  chartType: string;
  generatedAt: string;
  dataset?: string;
  sourceQueryId?: string;
  description?: string;
  /** 内联 base64 或文件路径 */
  dataUrl?: string;
  filePath?: string;
}

// ============================================================================
// 查询证据
// ============================================================================

/** 查询证据 */
export interface QueryEvidence {
  id: string;
  naturalLanguageQuery: string;
  sql: string;
  success: boolean;
  dataset?: string;
  executionTimeMs?: number;
  columns: Array<{ name: string; type: string }>;
  rowCount: number;
  /** 用于报告的摘要结果（截断到合理长度） */
  resultSummary: string;
  /** 是否被 Finding 引用 */
  referencedByFinding?: boolean;
}

// ============================================================================
// 字典快照
// ============================================================================

/** 字典快照 */
export interface DictionarySnapshot {
  table: string;
  columns: Array<{
    name: string;
    type: string;
    meaning: string;
    status: string;
    aliases?: string[];
    confidence?: string;
  }>;
}

// ============================================================================
// 限制
// ============================================================================

/** 限制 */
export interface Limitation {
  id: string;
  description: string;
  severity: "high" | "medium" | "low";
  source: string;
}
