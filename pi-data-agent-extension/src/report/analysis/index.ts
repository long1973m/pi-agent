/**
 * Analysis Report 模块
 *
 * 导出分析报告生成、渲染、schema 校验和质量门槛检查的公开 API。
 */

export { generateAnalysisReport } from "./generate-analysis-report.js";
export type {
  GenerateAnalysisReportParams,
  GenerateAnalysisReportResult,
} from "./generate-analysis-report.js";

export { renderAnalysisReport } from "./render-analysis-report.js";
export type {
  RenderAnalysisReportParams,
  RenderAnalysisReportResult,
} from "./render-analysis-report.js";

export { validateReportDraft, attemptSchemaRepair } from "./report-draft-schema.js";
export type {
  AnalysisReportDraft,
  ExecutiveSummaryItem,
  AnalysisSection,
  Recommendation,
} from "./report-draft-schema.js";

export { runQualityGate } from "./report-quality-gate.js";
export type { QualityGateResult } from "./report-quality-gate.js";
