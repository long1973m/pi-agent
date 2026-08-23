/**
 * Task 4 — 报告质量门槛检查
 *
 * Spec §7 质量门槛：
 * 1. 引用完整性：所有 evidenceRefs、chartRefs 必须在 Evidence Package 中存在
 * 2. 数字来源：关键数字必须能在 Evidence Package 中找到
 * 3. 结论覆盖：每条执行摘要至少关联一个 findingRef
 * 4. 推测标识：hypothesis 必须在 limitations 中明确标注
 * 5. 口径一致性：使用生成时的数据状态
 * 6. 限制保留：Evidence Package 中高优先级 limitation 不得被模型删除
 * 7. 证据覆盖率计算
 */

import type { AnalysisReportDraft } from "./report-draft-schema.js";
import type { EvidencePackage } from "../evidence/types.js";
import { calculateEvidenceCoverage } from "../evidence/evidence-validator.js";

// ============================================================================
// 质量门槛结果
// ============================================================================

export interface QualityGateResult {
  /** 是否通过全部检查 */
  passed: boolean;
  /** 证据覆盖率 0-1 */
  coverage: number;
  /** 阻断性错误（任一存在即不通过） */
  errors: string[];
  /** 非阻断性警告 */
  warnings: string[];
}

// ============================================================================
// 核心函数
// ============================================================================

/**
 * 运行报告质量门槛检查（Spec §7）
 *
 * 检查项：
 * 1. 引用完整性：所有 evidenceRefs、chartRefs 必须在 Evidence Package 中存在
 * 2. 数字来源：关键数字必须能在 Evidence Package 中找到
 * 3. 结论覆盖：每条执行摘要至少关联一个 findingRef
 * 4. 推测标识：hypothesis 必须在 limitations 中明确标注
 * 5. 口径一致性：使用生成时的数据状态
 * 6. 限制保留：Evidence Package 中高优先级 limitation 不得被模型删除
 * 7. 证据覆盖率计算
 */
export function runQualityGate(
  draft: AnalysisReportDraft,
  evidence: EvidencePackage
): QualityGateResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  // 构建引用索引
  const existingFindingIds = new Set(evidence.findings.map((f) => f.id));
  const existingChartIds = new Set(evidence.charts.map((c) => c.id));
  const existingQueryIds = new Set(evidence.queries.map((q) => q.id));
  const existingMetricIds = new Set(evidence.metrics.map((m) => m.id));

  // 收集所有被引用的 ID（用于数字来源检查）
  const allReferencedEvidenceIds = new Set<string>();
  const allReferencedChartIds = new Set<string>();

  // -----------------------------------------------------------------------
  // 检查 1：引用完整性
  // -----------------------------------------------------------------------

  // 检查 executiveSummary 的 findingRefs
  for (let i = 0; i < draft.executiveSummary.length; i++) {
    const item = draft.executiveSummary[i];
    for (const ref of item.findingRefs) {
      allReferencedEvidenceIds.add(ref);
      if (!existingFindingIds.has(ref)) {
        errors.push(
          `executiveSummary[${i}] references non-existent finding: "${ref}"`
        );
      }
    }
  }

  // 检查 sections 的 evidenceRefs 和 chartRefs
  for (let i = 0; i < draft.sections.length; i++) {
    const section = draft.sections[i];

    for (const ref of section.evidenceRefs) {
      allReferencedEvidenceIds.add(ref);
      // evidenceRefs 可以引用 query、metric 或 finding
      if (
        !existingFindingIds.has(ref) &&
        !existingQueryIds.has(ref) &&
        !existingMetricIds.has(ref)
      ) {
        errors.push(
          `sections[${i}] ("${section.heading}") references non-existent evidence: "${ref}"`
        );
      }
    }

    for (const ref of section.chartRefs) {
      allReferencedChartIds.add(ref);
      if (!existingChartIds.has(ref)) {
        errors.push(
          `sections[${i}] ("${section.heading}") references non-existent chart: "${ref}"`
        );
      }
    }
  }

  // 检查 recommendations 的 findingRefs
  for (let i = 0; i < draft.recommendations.length; i++) {
    const rec = draft.recommendations[i];
    for (const ref of rec.findingRefs) {
      allReferencedEvidenceIds.add(ref);
      if (!existingFindingIds.has(ref)) {
        errors.push(
          `recommendations[${i}] references non-existent finding: "${ref}"`
        );
      }
    }
  }

  // -----------------------------------------------------------------------
  // 检查 2：数字来源
  // -----------------------------------------------------------------------
  // 报告中如果出现具体数字但没有引用任何证据，给出 error（Spec §7.2）
  const hasNumericContent = checkForNumericContent(draft);
  const hasEvidenceReferences =
    allReferencedEvidenceIds.size > 0 || allReferencedChartIds.size > 0;

  if (hasNumericContent && !hasEvidenceReferences) {
    errors.push(
      "Report contains numeric data but has no evidence references. " +
      "All key numbers must be traceable to Evidence Package (Spec §7.2)."
    );
  }

  // -----------------------------------------------------------------------
  // 检查 3：结论覆盖
  // -----------------------------------------------------------------------
  for (let i = 0; i < draft.executiveSummary.length; i++) {
    const item = draft.executiveSummary[i];
    if (item.findingRefs.length === 0) {
      // 当 evidence package 中有 findings 时，每条执行摘要应至少关联一个
      if (evidence.findings.length > 0) {
        errors.push(
          `executiveSummary[${i}] has no findingRefs. ` +
          `Each executive summary point must reference at least one finding (Spec §7.2).`
        );
      }
    }
  }

  // -----------------------------------------------------------------------
  // 检查 4：推测标识
  // -----------------------------------------------------------------------
  const hypothesisSections = draft.sections.filter(
    (s) => s.interpretationType === "hypothesis"
  );

  if (hypothesisSections.length > 0) {
    // 检查 hypothesis 是否在 draft.limitations 中被标注
    const limitationsText = draft.limitations.join(" ").toLowerCase();
    for (const section of hypothesisSections) {
      const sectionKeywords = extractKeywords(section.conclusion);
      const isMentionedInLimitations = sectionKeywords.some(
        (kw) => limitationsText.includes(kw.toLowerCase())
      );

      if (!isMentionedInLimitations) {
        errors.push(
          `Section "${section.heading}" is marked as hypothesis but not mentioned in limitations. ` +
          `Hypotheses must be listed in the limitations section (Spec §7.2).`
        );
      }
    }
  }

  // -----------------------------------------------------------------------
  // 检查 5：口径一致性
  // -----------------------------------------------------------------------
  // 验证 draft 中的数据集范围与 Evidence Package 一致
  // 这是一个 soft check：如果 draft.scope 提到了不在 evidence.scope.datasets 中的数据集，给出警告
  if (draft.scope && evidence.scope.datasets.length > 0) {
    for (const ds of evidence.scope.datasets) {
      // 如果 evidence 中明确包含某个数据集，但 draft scope 完全没有提到，发出警告
      if (!draft.scope.toLowerCase().includes(ds.toLowerCase())) {
        warnings.push(
          `Dataset "${ds}" is in Evidence Package scope but not mentioned in report scope. ` +
          `Verify data scope consistency.`
        );
      }
    }
  }

  // -----------------------------------------------------------------------
  // 检查 6：限制保留
  // -----------------------------------------------------------------------
  const highSeverityLimitations = evidence.limitations.filter(
    (l) => l.severity === "high"
  );

  if (highSeverityLimitations.length > 0) {
    const limitationsText = draft.limitations.join(" ").toLowerCase();
    for (const limitation of highSeverityLimitations) {
      const keywords = extractKeywords(limitation.description);
      const isPreserved = keywords.some(
        (kw) => limitationsText.includes(kw.toLowerCase())
      );

      if (!isPreserved) {
        errors.push(
          `High-severity limitation "${limitation.description.slice(0, 100)}" ` +
          `from Evidence Package is not reflected in report limitations. ` +
          `Critical limitations must be preserved.`
        );
      }
    }
  }

  // -----------------------------------------------------------------------
  // 检查 7：证据覆盖率（Spec §7.2）
  // coverage = 1.0 → 可发布
  // coverage < 1.0 → 不得标记为正式报告（error 级）
  // -----------------------------------------------------------------------
  const coverage = calculateEvidenceCoverage(evidence);

  if (coverage < 1.0 && evidence.findings.length > 0) {
    errors.push(
      `Evidence coverage is ${(coverage * 100).toFixed(0)}%. ` +
      `Spec §7.2 requires 100% coverage for all core findings. ` +
      `${Math.round((1 - coverage) * evidence.findings.length)} finding(s) lack valid evidence references.`
    );
  }

  return {
    passed: errors.length === 0,
    coverage,
    errors,
    warnings,
  };
}

// ============================================================================
// 辅助函数
// ============================================================================

/**
 * 检查 draft 文本中是否包含数字内容
 */
function checkForNumericContent(draft: AnalysisReportDraft): boolean {
  const numericPattern = /\d+\.?\d*\s*(%|万元|亿元|元|个|件|条|人|次|倍)/;
  const numericPattern2 = /\d+\.?\d*%/;

  const textParts: string[] = [
    draft.title,
    draft.background,
    draft.scope,
    ...draft.executiveSummary.map((e) => e.text),
    ...draft.sections.map((s) => s.conclusion + " " + (s.interpretation ?? "")),
    ...draft.recommendations.map((r) => r.action + " " + r.rationale),
  ];

  return textParts.some(
    (text) => numericPattern.test(text) || numericPattern2.test(text)
  );
}

/**
 * 从文本中提取关键词（用于模糊匹配检查）
 *
 * 过滤掉常见停用词，保留有意义的词汇。
 */
function extractKeywords(text: string): string[] {
  if (!text || text.trim().length === 0) return [];

  // 简单中文关键词提取：过滤短词和停用词
  const stopWords = new Set([
    "the", "a", "an", "is", "are", "was", "were", "be", "been", "being",
    "have", "has", "had", "do", "does", "did", "will", "would", "could",
    "should", "may", "might", "can", "shall", "of", "in", "to", "for",
    "with", "on", "at", "by", "from", "as", "into", "through", "during",
    "before", "after", "above", "below", "between", "out", "off", "over",
    "under", "again", "further", "then", "once", "and", "but", "or",
    "nor", "not", "so", "yet", "both", "each", "few", "more", "most",
    "other", "some", "such", "no", "only", "own", "same", "than", "too",
    "very", "just", "because", "if", "when", "where", "how", "what",
    "which", "who", "whom", "this", "that", "these", "those", "it",
    "its", "的", "了", "在", "是", "和", "与", "或", "不", "也",
    "都", "而", "及", "等", "被", "把", "从", "到", "对", "于",
  ]);

  // 英文：按单词分词（>=3 字符）
  const englishWords = text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 3 && !stopWords.has(w));

  // 提取数字模式（用于匹配如 "2024"、"3.5" 等）
  const numbers = text.match(/\d+\.?\d*/g) ?? [];

  return [...new Set([...englishWords, ...numbers])];
}
