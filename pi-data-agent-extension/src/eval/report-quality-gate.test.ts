/**
 * v0.7 Task 11 — 质量门槛专项测试
 *
 * 测试 runQualityGate 的 7 项检查（Spec §7）
 * 运行: npx tsx src/eval/report-quality-gate.test.ts
 */

import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { runQualityGate } from "../report/analysis/report-quality-gate.js";
import type { EvidencePackage } from "../report/evidence/types.js";
import type { AnalysisReportDraft } from "../report/analysis/report-draft-schema.js";

// ============================================================================
// Mock 构造工具
// ============================================================================

function createEvidence(overrides?: Partial<EvidencePackage>): EvidencePackage {
  return {
    version: 1,
    sessionId: "sess-qg",
    question: "测试问题",
    reportMode: "detailed",
    scope: { datasets: ["sales_daily"], filters: [] },
    metrics: [],
    findings: [],
    charts: [],
    queries: [
      {
        id: "query-1",
        naturalLanguageQuery: "查询",
        sql: "SELECT * FROM sales_daily",
        success: true,
        dataset: "sales_daily",
        columns: [],
        rowCount: 10,
        resultSummary: "10 rows",
      },
    ],
    dictionary: [],
    limitations: [],
    generatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function createDraft(overrides?: Partial<AnalysisReportDraft>): AnalysisReportDraft {
  return {
    title: "测试报告",
    executiveSummary: [{ text: "核心结论", findingRefs: [] }],
    background: "",
    scope: "sales_daily",
    sections: [],
    recommendations: [],
    limitations: [],
    ...overrides,
  };
}

// ============================================================================
// 检查 1: 引用完整性 — 引用不存在的 ID → error
// ============================================================================

describe("检查 1: 引用完整性", () => {
  it("executiveSummary 引用不存在的 finding → error", () => {
    const evidence = createEvidence();
    const draft = createDraft({
      executiveSummary: [{ text: "摘要", findingRefs: ["nonexistent-finding"] }],
    });
    const result = runQualityGate(draft, evidence);
    assert.strictEqual(result.passed, false);
    assert.ok(result.errors.some((e) => e.includes("non-existent finding")));
  });

  it("sections 引用不存在的 chart → error", () => {
    const evidence = createEvidence();
    const draft = createDraft({
      sections: [{ heading: "测试", conclusion: "结论", evidenceRefs: [], chartRefs: ["nonexistent-chart"] }],
    });
    const result = runQualityGate(draft, evidence);
    assert.strictEqual(result.passed, false);
    assert.ok(result.errors.some((e) => e.includes("non-existent chart")));
  });

  it("sections 引用不存在的 evidence → error", () => {
    const evidence = createEvidence();
    const draft = createDraft({
      sections: [{ heading: "测试", conclusion: "结论", evidenceRefs: ["nonexistent-evidence"], chartRefs: [] }],
    });
    const result = runQualityGate(draft, evidence);
    assert.strictEqual(result.passed, false);
    assert.ok(result.errors.some((e) => e.includes("non-existent evidence")));
  });

  it("recommendations 引用不存在的 finding → error", () => {
    const evidence = createEvidence();
    const draft = createDraft({
      recommendations: [{ action: "行动", priority: "high", rationale: "原因", findingRefs: ["nonexistent-finding"] }],
    });
    const result = runQualityGate(draft, evidence);
    assert.strictEqual(result.passed, false);
    assert.ok(result.errors.some((e) => e.includes("non-existent finding")));
  });

  it("所有引用合法时无引用完整性 error", () => {
    const evidence = createEvidence({
      findings: [
        { id: "finding-1", statement: "结论", evidenceType: "direct", resultRefs: ["query-1"], chartRefs: [], queryRefs: ["query-1"], metricRefs: [], confidence: "high", caveats: [] },
      ],
    });
    const draft = createDraft({
      executiveSummary: [{ text: "摘要", findingRefs: ["finding-1"] }],
      sections: [{ heading: "测试", conclusion: "结论", evidenceRefs: ["query-1"], chartRefs: [] }],
      recommendations: [{ action: "行动", priority: "high", rationale: "原因", findingRefs: ["finding-1"] }],
    });
    const result = runQualityGate(draft, evidence);
    const refErrors = result.errors.filter((e) => e.includes("non-existent"));
    assert.strictEqual(refErrors.length, 0);
  });
});

// ============================================================================
// 检查 2: 数字来源 — 有数字但无引用 → error
// ============================================================================

describe("检查 2: 数字来源", () => {
  it("报告含数字但无任何证据引用 → error", () => {
    const evidence = createEvidence();
    const draft = createDraft({
      executiveSummary: [{ text: "销售额增长15%，达到150万元。", findingRefs: [] }],
      scope: "sales_daily",
    });
    const result = runQualityGate(draft, evidence);
    assert.strictEqual(result.passed, false);
    assert.ok(result.errors.some((e) => e.includes("numeric data") || e.includes("evidence references")));
  });

  it("报告含数字且有证据引用 → 无此 error", () => {
    const evidence = createEvidence({
      findings: [
        { id: "f-1", statement: "销售额增长15%", evidenceType: "direct", resultRefs: ["query-1"], chartRefs: [], queryRefs: ["query-1"], metricRefs: [], confidence: "high", caveats: [] },
      ],
    });
    const draft = createDraft({
      executiveSummary: [{ text: "销售额增长15%，达到150万元。", findingRefs: ["f-1"] }],
    });
    const result = runQualityGate(draft, evidence);
    const numericErrors = result.errors.filter((e) => e.includes("numeric data") || e.includes("evidence references"));
    assert.strictEqual(numericErrors.length, 0);
  });

  it("报告无数字时无此 error", () => {
    const evidence = createEvidence();
    const draft = createDraft({
      executiveSummary: [{ text: "整体趋势良好，需要持续关注。", findingRefs: [] }],
    });
    const result = runQualityGate(draft, evidence);
    const numericErrors = result.errors.filter((e) => e.includes("numeric data") || e.includes("evidence references"));
    assert.strictEqual(numericErrors.length, 0);
  });
});

// ============================================================================
// 检查 3: 结论覆盖 — 摘要无 findingRef → error
// ============================================================================

describe("检查 3: 结论覆盖", () => {
  it("有 findings 时执行摘要无 findingRefs → error", () => {
    const evidence = createEvidence({
      findings: [
        { id: "f-1", statement: "结论1", evidenceType: "direct", resultRefs: [], chartRefs: [], queryRefs: [], metricRefs: [], confidence: "high", caveats: [] },
      ],
    });
    const draft = createDraft({
      executiveSummary: [{ text: "摘要但无引用", findingRefs: [] }],
    });
    const result = runQualityGate(draft, evidence);
    assert.strictEqual(result.passed, false);
    assert.ok(result.errors.some((e) => e.includes("findingRefs")));
  });

  it("无 findings 时执行摘要无 findingRefs → 无此 error", () => {
    const evidence = createEvidence({ findings: [] });
    const draft = createDraft({
      executiveSummary: [{ text: "摘要", findingRefs: [] }],
    });
    const result = runQualityGate(draft, evidence);
    const coverageErrors = result.errors.filter((e) => e.includes("findingRefs"));
    assert.strictEqual(coverageErrors.length, 0);
  });

  it("有 findings 且执行摘要有 findingRefs → 无此 error", () => {
    const evidence = createEvidence({
      findings: [
        { id: "f-1", statement: "结论", evidenceType: "direct", resultRefs: [], chartRefs: [], queryRefs: [], metricRefs: [], confidence: "high", caveats: [] },
      ],
    });
    const draft = createDraft({
      executiveSummary: [{ text: "摘要", findingRefs: ["f-1"] }],
    });
    const result = runQualityGate(draft, evidence);
    const coverageErrors = result.errors.filter((e) => e.includes("findingRefs"));
    assert.strictEqual(coverageErrors.length, 0);
  });
});

// ============================================================================
// 检查 4: 推测标识 — hypothesis 不在 limitations 中 → error
// ============================================================================

describe("检查 4: 推测标识", () => {
  it("hypothesis section 未在 limitations 中提及 → error", () => {
    const evidence = createEvidence();
    const draft = createDraft({
      sections: [
        { heading: "增长原因", conclusion: "增长可能由促销活动驱动", evidenceRefs: [], chartRefs: [], interpretationType: "hypothesis" },
      ],
      limitations: ["数据仅30天"],
    });
    const result = runQualityGate(draft, evidence);
    assert.strictEqual(result.passed, false);
    assert.ok(result.errors.some((e) => e.includes("hypothesis") && e.includes("limitations")));
  });

  it("hypothesis section 在 limitations 中提及 → 无此 error", () => {
    const evidence = createEvidence();
    const draft = createDraft({
      sections: [
        {
          heading: "Growth Reason",
          conclusion: "Growth driven by promotion campaign",
          evidenceRefs: [],
          chartRefs: [],
          interpretationType: "hypothesis",
        },
      ],
      limitations: ["Growth driven by promotion campaign is not verified"],
    });
    const result = runQualityGate(draft, evidence);
    const hypErrors = result.errors.filter((e) => e.includes("hypothesis") && e.includes("limitations"));
    assert.strictEqual(hypErrors.length, 0);
  });

  it("非 hypothesis section 不触发此检查", () => {
    const evidence = createEvidence();
    const draft = createDraft({
      sections: [
        { heading: "销售趋势", conclusion: "销售额上升15%", evidenceRefs: ["query-1"], chartRefs: [], interpretationType: "supported" },
      ],
      limitations: [],
    });
    const result = runQualityGate(draft, evidence);
    const hypErrors = result.errors.filter((e) => e.includes("hypothesis") && e.includes("limitations"));
    assert.strictEqual(hypErrors.length, 0);
  });
});

// ============================================================================
// 检查 5: 口径一致性 — scope 不匹配 → warning
// ============================================================================

describe("检查 5: 口径一致性", () => {
  it("evidence 中有数据集但 draft scope 未提及 → warning", () => {
    const evidence = createEvidence({
      scope: { datasets: ["sales_daily", "users"], filters: [] },
    });
    const draft = createDraft({
      scope: "仅 sales_daily",
    });
    const result = runQualityGate(draft, evidence);
    assert.ok(result.warnings.some((w) => w.includes("users") && w.includes("scope")));
  });

  it("draft scope 提及了所有数据集 → 无此 warning", () => {
    const evidence = createEvidence({
      scope: { datasets: ["sales_daily"], filters: [] },
    });
    const draft = createDraft({
      scope: "数据范围：sales_daily 表",
    });
    const result = runQualityGate(draft, evidence);
    const scopeWarnings = result.warnings.filter((w) => w.includes("scope"));
    assert.strictEqual(scopeWarnings.length, 0);
  });

  it("evidence 无数据集时不触发此检查", () => {
    const evidence = createEvidence({
      scope: { datasets: [], filters: [] },
    });
    const draft = createDraft({ scope: "无数据集" });
    const result = runQualityGate(draft, evidence);
    const scopeWarnings = result.warnings.filter((w) => w.includes("scope") && w.includes("Evidence Package"));
    assert.strictEqual(scopeWarnings.length, 0);
  });
});

// ============================================================================
// 检查 6: 限制保留 — 删除 high limitation → error
// ============================================================================

describe("检查 6: 限制保留", () => {
  it("high severity limitation 未在 draft limitations 中保留 → error", () => {
    const evidence = createEvidence({
      limitations: [
        { id: "limit-1", description: "关键字段 status 语义不确定，分析结果可能不准确", severity: "high", source: "dictionary:sales_daily.status" },
      ],
    });
    const draft = createDraft({
      limitations: ["数据仅30天"],
    });
    const result = runQualityGate(draft, evidence);
    assert.strictEqual(result.passed, false);
    assert.ok(result.errors.some((e) => e.includes("High-severity limitation")));
  });

  it("high severity limitation 在 draft limitations 中保留 → 无此 error", () => {
    const evidence = createEvidence({
      limitations: [
        { id: "limit-1", description: "关键字段 status 语义不确定，分析结果可能不准确", severity: "high", source: "dictionary:sales_daily.status" },
      ],
    });
    const draft = createDraft({
      limitations: ["字段 status 语义不确定，分析结果可能不准确"],
    });
    const result = runQualityGate(draft, evidence);
    const limitErrors = result.errors.filter((e) => e.includes("High-severity limitation"));
    assert.strictEqual(limitErrors.length, 0);
  });

  it("medium severity limitation 不触发 error", () => {
    const evidence = createEvidence({
      limitations: [
        { id: "limit-1", description: "部分数据截断", severity: "medium", source: "transcript" },
      ],
    });
    const draft = createDraft({ limitations: [] });
    const result = runQualityGate(draft, evidence);
    const highLimitErrors = result.errors.filter((e) => e.includes("High-severity limitation"));
    assert.strictEqual(highLimitErrors.length, 0);
  });
});

// ============================================================================
// 检查 7: 覆盖率计算 — 验证分数正确
// ============================================================================

describe("检查 7: 覆盖率计算", () => {
  it("覆盖率 100% 时无低覆盖率 warning", () => {
    const evidence = createEvidence({
      findings: [
        { id: "f-1", statement: "结论", evidenceType: "direct", resultRefs: ["query-1"], chartRefs: [], queryRefs: ["query-1"], metricRefs: [], confidence: "high", caveats: [] },
      ],
    });
    const draft = createDraft();
    const result = runQualityGate(draft, evidence);
    assert.strictEqual(result.coverage, 1.0);
    const covWarnings = result.warnings.filter((w) => w.includes("Evidence coverage"));
    assert.strictEqual(covWarnings.length, 0);
    const covErrors = result.errors.filter((e) => e.includes("Evidence coverage"));
    assert.strictEqual(covErrors.length, 0);
  });

  it("覆盖率低于 50% 且有 findings → error", () => {
    const evidence = createEvidence({
      findings: [
        { id: "f-1", statement: "有证据", evidenceType: "direct", resultRefs: ["query-1"], chartRefs: [], queryRefs: ["query-1"], metricRefs: [], confidence: "high", caveats: [] },
        { id: "f-2", statement: "无证据", evidenceType: "direct", resultRefs: [], chartRefs: [], queryRefs: [], metricRefs: [], confidence: "medium", caveats: [] },
        { id: "f-3", statement: "也无证据", evidenceType: "direct", resultRefs: [], chartRefs: [], queryRefs: [], metricRefs: [], confidence: "medium", caveats: [] },
      ],
    });
    const draft = createDraft();
    const result = runQualityGate(draft, evidence);
    assert.ok(result.coverage < 0.5);
    assert.strictEqual(result.passed, false);
    assert.ok(result.errors.some((e) => e.includes("Evidence coverage")));
  });

  it("无 findings 时覆盖率 = 0，无 coverage error", () => {
    const evidence = createEvidence({ findings: [] });
    const draft = createDraft();
    const result = runQualityGate(draft, evidence);
    assert.strictEqual(result.coverage, 0);
    const covWarnings = result.warnings.filter((w) => w.includes("Evidence coverage"));
    assert.strictEqual(covWarnings.length, 0);
    const covErrors = result.errors.filter((e) => e.includes("Evidence coverage"));
    assert.strictEqual(covErrors.length, 0);
  });

  it("coverage 字段在返回值中精确返回", () => {
    const evidence = createEvidence({
      findings: [
        { id: "f-1", statement: "结论", evidenceType: "direct", resultRefs: [], chartRefs: [], queryRefs: [], metricRefs: [], confidence: "high", caveats: [] },
      ],
    });
    const draft = createDraft();
    const result = runQualityGate(draft, evidence);
    assert.strictEqual(result.coverage, 0);
    assert.strictEqual(result.passed, false);
    assert.ok(result.errors.some((e) => e.includes("Evidence coverage")));
  });
});

// ============================================================================
// 综合测试：完全合规的 draft+evidence 通过所有检查
// ============================================================================

describe("综合: 完全合规的 draft+evidence", () => {
  it("所有检查通过，passed=true", () => {
    const evidence = createEvidence({
      findings: [
        { id: "f-1", statement: "销售额增长15%", evidenceType: "direct", resultRefs: ["query-1"], chartRefs: [], queryRefs: ["query-1"], metricRefs: [], confidence: "high", caveats: [] },
      ],
    });
    const draft = createDraft({
      executiveSummary: [{ text: "销售额增长15%，达到150万元。", findingRefs: ["f-1"] }],
      sections: [
        { heading: "销售趋势", conclusion: "销售额增长15%", evidenceRefs: ["query-1"], chartRefs: [], interpretationType: "supported" },
      ],
      scope: "数据范围：sales_daily 表",
      limitations: [],
    });
    const result = runQualityGate(draft, evidence);
    assert.strictEqual(result.passed, true);
    assert.strictEqual(result.errors.length, 0);
  });
});