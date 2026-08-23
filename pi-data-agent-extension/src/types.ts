/**
 * Pi Data Agent — 共享类型定义
 *
 * 涵盖：查询结果、列信息、安全层、数据字典、查询记忆、主动反问、错误恢复、工具执行
 */

// ============================================================================
// 基础类型
// ============================================================================

/** DuckDB 支持的列类型子集 */
export type DuckDBColumnType =
  | "BOOLEAN"
  | "TINYINT"
  | "SMALLINT"
  | "INTEGER"
  | "BIGINT"
  | "UTINYINT"
  | "USMALLINT"
  | "UINTEGER"
  | "UBIGINT"
  | "FLOAT"
  | "DOUBLE"
  | "DECIMAL"
  | "VARCHAR"
  | "DATE"
  | "TIME"
  | "TIMESTAMP"
  | "TIMESTAMP_S"
  | "TIMESTAMP_MS"
  | "TIMESTAMP_NS"
  | "INTERVAL"
  | "BLOB"
  | "UUID"
  | "JSON"
  | "ARRAY"
  | "LIST"
  | "MAP"
  | "STRUCT"
  | "UNION";

/** 列信息 */
export interface ColumnInfo {
  name: string;
  type: DuckDBColumnType;
  nullable: boolean;
  /** 列的语义描述（来自数据字典） */
  description?: string;
  /** 数据字典验证状态 */
  dictionaryStatus?: "validated" | "ai-guessed" | "unknown";
}

/** 查询结果 */
export interface QueryResult {
  /** 列定义 */
  columns: ColumnInfo[];
  /** 数据行（原生类型） */
  rows: unknown[][];
  /** 总行数（含未返回的） */
  totalRowCount: number;
  /** 实际返回行数 */
  returnedRowCount: number;
  /** 是否被截断 */
  truncated: boolean;
  /** 截断时落盘的 CSV 路径 */
  csvPath?: string;
  /** 执行时间（毫秒） */
  executionTimeMs?: number;
  /** 不确定性警告（如字段未确认） */
  uncertaintyWarnings?: string[];
}

// ============================================================================
// 安全层
// ============================================================================

/** 安全层配置 */
export interface SecurityConfig {
  /** 当前工作目录 */
  cwd: string;
  /** 允许访问的路径白名单（绝对路径） */
  allowedPaths: string[];
  /** 是否自动确认写操作 */
  autoConfirmWrite: boolean;
  /** 危险 SQL 黑名单正则列表 */
  dangerousSqlPatterns: RegExp[];
  /** 越界路径是否拦截 */
  blockOutOfBoundsPath: boolean;
}

/** 安全检查动作 */
export type SecurityAction = "allow" | "block" | "confirm";

/** 安全检查结果 */
export interface SecurityCheckResult {
  action: SecurityAction;
  /** action=block 时的原因 */
  reason?: string;
  /** action=confirm 时的提示信息 */
  confirmMessage?: string;
  /** 被检测到的危险模式 */
  matchedPattern?: string;
}

// ============================================================================
// 数据字典
// ============================================================================

/** 列语义状态 */
export type ColumnSemanticStatus =
  | "ai-guessed"
  | "user-confirmed"
  | "user-corrected"
  | "uncertain";

/** 列语义描述 */
export interface ColumnSemantic {
  /** 列名 */
  name: string;
  /** DuckDB 类型 */
  type: DuckDBColumnType;
  /** 推断的语义含义 */
  inferredMeaning: string;
  /** 用户修正后的语义含义（优先使用） */
  userMeaning?: string;
  /** 样本值 */
  sampleValues?: string[];
  /** 列级语义状态 */
  status: ColumnSemanticStatus;
  /** 确认/修正时间（ISO 8601） */
  confirmedAt?: string;
  /** 是否经过用户确认（向后兼容） */
  validated?: boolean;
  /** AI 建议别名列表 */
  aliases?: string[];
  /** AI 推断结果详情 */
  suggestion?: {
    /** 置信度分数 0-1 */
    confidence: number;
    /** 置信度等级 */
    confidenceLevel: "high" | "medium" | "low";
    /** 推断依据列表 */
    evidence: string[];
    /** 不确定点列表 */
    uncertainties: string[];
    /** 使用的模型版本 */
    modelVersion: string;
    /** 推断生成时间 */
    generatedAt: string;
    /** 推断时的 Schema fingerprint */
    sourceSchemaRevision: string;
  };
  /** 用户审核记录 */
  review?: {
    /** 审核动作 */
    action: "confirmed" | "corrected" | "uncertain";
    /** 审核时间 */
    reviewedAt: string;
    /** 用户修正后的含义（仅 corrected 时有值） */
    originalSuggestion?: string;
  };
}

/** 数据字典条目 */
export interface DataDictionaryEntry {
  /** 表名 */
  tableName: string;
  /** 列语义定义 */
  columns: ColumnSemantic[];
  /** 样本数据（前 N 行） */
  sampleRows?: unknown[][];
  /** 生成时间 */
  generatedAt: string;
  /** 验证状态 */
  status: "validated" | "ai-guessed" | "user-corrected" | "unknown";
  /** 验证者（用户或 AI） */
  validatedBy?: "user" | "ai";
  /** 验证时间 */
  validatedAt?: string;
  /** Schema fingerprint: MD5 of DESCRIBE result (column names + types + row count) */
  schemaFingerprint?: string;
}

/** 数据字典（按表名索引） */
export type DataDictionary = Map<string, DataDictionaryEntry>;

/** 字典推断请求模式 */
type DictionaryInferenceMode = "empty-only" | "selected" | "force";

/** 字典推断结果 */
interface DictionarySuggestion {
  table: string;
  column: string;
  suggestedDescription: string;
  suggestedAliases: string[];
  status: "ai-guessed" | "uncertain";
  confidence: number;
  confidenceLevel: "high" | "medium" | "low";
  evidence: string[];
  uncertainties: string[];
  modelVersion: string;
  generatedAt: string;
  sourceSchemaRevision: string;
}

/** 表级推断上下文（发送给模型） */
interface TableInferenceContext {
  tableName: string;
  columns: Array<{
    name: string;
    type: string;
    nullable: boolean;
    sampleValues: string[];
    nullRatio: number;
    uniqueCount: number;
    min?: string | number;
    max?: string | number;
    dbComment?: string;
    currentDescription?: string;
    currentStatus?: string;
    isPrimaryKey?: boolean;
    isForeignKey?: boolean;
  }>;
  tableComment?: string;
  rowCount: number;
  relatedTables?: string[];
  knownCalibers?: string[];
}

/** 字典推断缓存条目 */
interface DictionaryInferenceCacheEntry {
  table: string;
  column: string;
  schemaRevision: string;
  suggestion: DictionarySuggestion;
  cachedAt: string;
}

export {
  DictionaryInferenceMode,
  DictionarySuggestion,
  TableInferenceContext,
  DictionaryInferenceCacheEntry,
};

// ============================================================================
// 查询记忆
// ============================================================================

/** 单条查询记忆 */
export interface QueryMemoryEntry {
  /** 唯一 ID */
  id: string;
  /** 自然语言查询 */
  naturalLanguageQuery: string;
  /** 执行的 SQL */
  sql: string;
  /** 涉及的数据集指纹 */
  datasetFingerprint: string;
  /** 查询时间 */
  timestamp: string;
  /** 使用次数（用于频次加权） */
  useCount: number;
  /** 是否成功 */
  success: boolean;
  /** 结果摘要 */
  resultSummary?: string;
  /** 备注 */
  notes?: string;
  /** 状态 */
  status?: string;
  /** v0.10 A-5: 用户手动固定——不参与容量淘汰，注入 L0 导航层"用户的高频/固定分析" */
  pinned?: boolean;
}

/** 失败查询分类 */
export type FailureCategory =
  | "syntax_error"
  | "not_found"
  | "permission"
  | "timeout"
  | "unknown";

/** 失败查询条目（独立于成功查询记忆） */
export interface FailedQueryEntry {
  /** 唯一 ID */
  id: string;
  /** 自然语言查询 */
  naturalLanguageQuery: string;
  /** 执行的 SQL */
  sql: string;
  /** 涉及的数据集指纹 */
  datasetFingerprint: string;
  /** 失败时间 */
  timestamp: string;
  /** 错误分类 */
  failureCategory: FailureCategory;
  /** 错误信息 */
  errorMessage: string;
}

/** 查询记忆集合 */
export interface QueryMemory {
  /** 最大保留条数 */
  maxEntries: number;
  /** 记忆条目 */
  entries: QueryMemoryEntry[];
}

// ============================================================================
// 主动反问（Clarification）
// ============================================================================

/** 选项 */
export interface ClarificationOption {
  /** 选项 ID */
  id: string;
  /** 展示标签 */
  label: string;
  /** 此选项隐含的口径假设 */
  impliedAssumption: string;
}

/** 主动反问结构 */
export interface Clarification {
  /** 问题 */
  question: string;
  /** 为什么需要反问（上下文） */
  why: string;
  /** 选项（2-4 个） */
  options: ClarificationOption[];
  /** 是否允许自由文本输入 */
  allowFreeText: boolean;
  /** 用户跳过时的默认选项 ID */
  defaultIfSkip: string;
}

/** 用户回答 */
export interface ClarificationAnswer {
  /** 选择的选项 ID，或自由文本 */
  value: string;
  /** 是否使用了默认值 */
  isDefault: boolean;
  /** 使用的口径假设 */
  appliedAssumption: string;
}

// ============================================================================
// 错误恢复
// ============================================================================

/** 错误恢复配置 */
export interface ErrorRecoveryConfig {
  /** 最大重试次数 */
  maxRetries: number;
  /** 连续相同错误停止阈值 */
  maxConsecutiveSameError: number;
  /** 是否通知用户每次重试 */
  notifyOnRetry: boolean;
}

/** 工具执行结果 */
export interface ToolExecutionResult<T = unknown> {
  /** 是否成功 */
  success: boolean;
  /** 结果数据 */
  data?: T;
  /** 错误信息 */
  error?: string;
  /** 重试次数 */
  retryCount?: number;
  /** 调试上下文（最终失败时提供） */
  debugContext?: {
    sql?: string;
    schema?: ColumnInfo[];
    sampleRows?: unknown[][];
    attemptedFixes?: string[];
  };
}

// ============================================================================
// DuckDB 引擎
// ============================================================================

/** 表概览 */
export interface TableOverview {
  name: string;
  rowCount: number;
  columnCount: number;
  columns: ColumnInfo[];
  /** 数据来源（如 CSV 路径） */
  source?: string;
}

/** 列统计 */
export interface ColumnStats {
  name: string;
  type: DuckDBColumnType;
  nullCount: number;
  nullRatio: number;
  uniqueCount: number;
  /** 最小值（数值/日期列） */
  min?: number | string;
  /** 最大值（数值/日期列） */
  max?: number | string;
  /** 平均值（数值列） */
  avg?: number;
  /** 高频值 TOP N */
  topValues?: Array<{ value: unknown; count: number }>;
}

/** 表统计摘要 */
export interface TableSummary {
  tableName: string;
  rowCount: number;
  columnStats: ColumnStats[];
}

// ============================================================================
// 口径记忆（Caliber / agent.md）
// ============================================================================

/** 单条口径条目 */
export interface CaliberEntry {
  /** 唯一 ID（基于 question 的 hash） */
  id: string;
  /** 原始问题（作为口径标题） */
  question: string;
  /** 用户选择的定义 */
  definition: string;
  /** 用户选择的选项 impliedAssumption */
  appliedAssumption: string;
  /** 确认时间 */
  confirmedAt: string;
  /** 状态 */
  status: "confirmed" | "superseded";
}

// ============================================================================
// 持久化
// ============================================================================

/** 持久化层级 */
export type PersistenceLevel = "global" | "project" | "session";

/** 可持久化数据 */
export interface PersistableData {
  /** 数据字典 */
  dataDictionary?: DataDictionaryEntry[];
  /** 查询记忆 */
  queryMemory?: QueryMemory;
  /** 用户配置 */
  config?: Record<string, unknown>;
}
