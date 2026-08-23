/**
 * 字典推断 — 置信度规则修正（Spec §10.4）
 *
 * 职责：不直接使用模型自报的 confidence 分数，而是结合外部证据
 * 重新计算置信度等级，确保评估客观可信。
 */

import type { DictionarySuggestion } from "../../types.js";

/** 列级额外信息（来自统计和上下文收集） */
export interface ColumnEvidenceInfo {
  dbComment?: string;
  samplePatterns?: string[];
  sqlUsageCount?: number;
}

/**
 * 服务端置信度规则修正
 *
 * 规则：
 * 1. 基础分 = 模型自报 confidence
 * 2. 加分项：
 *    - 有数据库注释 (+0.2)
 *    - samplePatterns 包含稳定模式 (+0.1)
 *    - sqlUsageCount >= 3 (+0.1)
 * 3. 减分项：
 *    - evidence 为空 (-0.2)
 *    - uncertainties 非空 (-0.1)
 * 4. 映射到等级：>= 0.7 → high, >= 0.4 → medium, < 0.4 → low
 * 5. 映射到 status：high/medium → ai-guessed, low → uncertain
 * 6. clamp 到 [0, 1]
 */
export function applyConfidenceRules(
  suggestion: DictionarySuggestion,
  columnInfo?: ColumnEvidenceInfo
): DictionarySuggestion {
  let score = suggestion.confidence;

  // 加分项
  if (columnInfo?.dbComment && columnInfo.dbComment.trim() !== "") {
    score += 0.2;
  }
  if (columnInfo?.samplePatterns && columnInfo.samplePatterns.length > 0) {
    score += 0.1;
  }
  if (columnInfo?.sqlUsageCount !== undefined && columnInfo.sqlUsageCount >= 3) {
    score += 0.1;
  }

  // 减分项
  if (!suggestion.evidence || suggestion.evidence.length === 0) {
    score -= 0.2;
  }
  if (suggestion.uncertainties && suggestion.uncertainties.length > 0) {
    score -= 0.1;
  }

  // clamp 到 [0, 1]
  score = Math.max(0, Math.min(1, score));

  // 映射到等级
  let confidenceLevel: "high" | "medium" | "low";
  if (score >= 0.7) {
    confidenceLevel = "high";
  } else if (score >= 0.4) {
    confidenceLevel = "medium";
  } else {
    confidenceLevel = "low";
  }

  // 映射到 status
  const status: "ai-guessed" | "uncertain" =
    confidenceLevel === "low" ? "uncertain" : "ai-guessed";

  return {
    ...suggestion,
    confidence: Math.round(score * 1000) / 1000, // 保留 3 位小数
    confidenceLevel,
    status,
  };
}