/**
 * Pi Data Agent Dashboard — 类型定义
 */

/** Dashboard 配置 */
export interface DashboardConfig {
  /** 服务端口（默认 3456） */
  port?: number;
  /** 项目目录 */
  projectDir: string;
  /** 是否自动打开浏览器（默认 true） */
  openBrowser?: boolean;
  /** 绑定地址（固定 127.0.0.1） */
  host?: "127.0.0.1";
}

/** Dashboard 实例句柄 */
export interface DashboardHandle {
  /** 访问 URL */
  url: string;
  /** 实际端口 */
  port: number;
  /** 写令牌（启动时从 dashboard-token 文件加载或生成，见 lifecycle.ts） */
  writeToken: string;
  /** 停止服务 */
  stop: () => Promise<void>;
}

/** API 统一成功响应 */
export interface ApiSuccessResponse<T = unknown> {
  data: T;
  meta: {
    requestId: string;
  };
}

/** API 统一错误响应 */
export interface ApiErrorResponse {
  error: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
  };
  meta: {
    requestId: string;
  };
}

/** Revision 包装的存储项（用于字典和口径的乐观并发控制） */
export interface RevisionedData<T> {
  /** 数据内容 */
  data: T;
  /** 版本号（每次写入递增） */
  revision: number;
  /** 最后更新时间 */
  updatedAt: string;
}

/** 分页请求参数 */
export interface PaginationParams {
  page?: number;
  size?: number;
}

/** 分页响应 */
export interface PaginatedResponse<T> {
  items: T[];
  total: number;
  page: number;
  size: number;
  totalPages: number;
}

/** 报告类型 */
export type ReportType = "session" | "analysis";

/** 分析报告模式 */
export type AnalysisReportMode = "executive" | "detailed";

/** 报告摘要 */
export interface ReportSummary {
  id: string;
  title: string;
  summary: string;
  createdAt: string;
  file: string;
  datasets: string[];
  charts: ChartSummary[];
  /** 报告类型 */
  type?: ReportType;
  /** 报告模式（仅 analysis 报告） */
  reportMode?: AnalysisReportMode;
  /** 来源 Session ID（仅 analysis 报告） */
  sourceSessionId?: string;
  /** 来源 Session Report ID（仅 analysis 报告） */
  sourceSessionReportId?: string;
  /** 证据覆盖率（仅 analysis 报告） */
  evidenceCoverage?: number;
  /** 证据包 JSON 路径（仅 analysis 报告） */
  evidencePath?: string;
  /** 关联的正式报告 ID 列表（仅 session 报告） */
  analysisReportIds?: string[];
}

/** 图表摘要 */
export interface ChartSummary {
  id: string;
  title: string;
  generatedAt: string;
  sourceReport: string;
  sourceReportId: string;
  dataset?: string;
  /** 缩略图 URL 或 data URI */
  thumbnailUrl?: string;
}

/** 数据集列表项 */
export interface DatasetItem {
  name: string;
  rowCount: number;
  columnCount: number;
}

/** 列统计信息 */
export interface ColumnStatsInfo {
  name: string;
  type: string;
  nullCount: number;
  nullRatio: number;
  uniqueCount: number;
  /** full | approximate | sample */
  calculationMode: "full" | "approximate" | "sample";
  min?: number | string;
  max?: number | string;
  avg?: number;
  topValues?: Array<{ value: unknown; count: number }>;
}

/** SQL 历史条目 */
export interface SqlHistoryEntry {
  id: string;
  naturalLanguageQuery: string;
  sql: string;
  timestamp: string;
  useCount: number;
  success: boolean;
  resultSummary?: string;
  notes?: string;
  /** v0.10 A-5: 用户手动固定（不参与容量淘汰，注入 L0 导航层） */
  pinned?: boolean;
  /** active | outdated | failed */
  status: "active" | "outdated" | "failed";
}

/** 口径条目（基于 CaliberEntry 扩展） */
export interface MetricEntry {
  id: string;
  name: string;
  /** 计算规则 */
  definition: string;
  datasets: string[];
  status: "user-confirmed" | "superseded";
  source: "user";
  revision: number;
  updatedAt: string;
  archived: boolean;
  /** v0.10 A-6: 备注（选填） */
  notes?: string;
  /** 原始问题（用于溯源） */
  question?: string;
  /** 用户选择的前提假设 */
  appliedAssumption?: string;
  /** v0.10 A-6: 旧口径迁移标记——true 时为只读"历史口径"，不参与常规 CRUD 与 L0 指标注入 */
  legacyCaliber?: boolean;
}