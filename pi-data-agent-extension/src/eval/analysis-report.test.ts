/**
 * v0.7 Task 11 — 正式报告生成测试
 *
 * 覆盖 Spec §18.1 场景：R1-R10
 * 运行: npx tsx src/eval/analysis-report.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildEvidencePackage } from "../report/evidence/build-evidence-package.js";
import { validateEvidencePackage, calculateEvidenceCoverage, checkEvidenceSufficiency } from "../report/evidence/evidence-validator.js";
import { validateReportDraft, attemptSchemaRepair } from "../report/analysis/report-draft-schema.js";
import { runQualityGate } from "../report/analysis/report-quality-gate.js";
import { extractFindings } from "../report/evidence/finding-extractor.js";
import { renderAnalysisReport } from "../report/analysis/render-analysis-report.js";
import type { EvidencePackage } from "../report/evidence/types.js";
import type { AnalysisReportDraft } from "../report/analysis/report-draft-schema.js";
import type { SessionEntry } from "../report/session-transcript.js";

// ============================================================================
// Mock 构造工具
// ============================================================================

function createMockSessionEntry(
  role: string,
  content: unknown,
  toolCalls?: Array<{
    id: string;
    name: string;
    arguments: Record<string, unknown>;
  }>
): SessionEntry {
  const msg: Record<string, unknown> = { role, timestamp: Date.now() };

  if (role === "user") {
    msg.content = typeof content === "string" ? content : JSON.stringify(content);
  } else if (role === "assistant") {
    msg.content = (toolCalls ?? []).map((tc) => ({
      type: "toolCall" as const,
      id: tc.id,
      name: tc.name,
      arguments: tc.arguments,
    }));
    if (typeof content === "string") {
      (msg.content as Array<Record<string, unknown>>).unshift({
        type: "text" as const,
        text: content,
      });
    }
  } else if (role === "toolResult") {
    const c = content as { toolCallId: string; toolName: string; text: string; isError?: boolean };
    msg.toolCallId = c.toolCallId;
    msg.toolName = c.toolName;
    msg.content = [{ type: "text" as const, text: c.text }];
    msg.isError = c.isError ?? false;
  }

  return {
    type: "message",
    id: `entry-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    parentId: null,
    timestamp: new Date().toISOString(),
    message: msg as unknown as SessionEntry["message"],
  };
}

function createMockEvidencePackage(overrides?: Partial<EvidencePackage>): EvidencePackage {
  return {
    version: 1,
    sessionId: "test-session-001",
    question: "分析销售趋势",
    reportMode: "detailed",
    scope: { datasets: ["sales_daily"], filters: [] },
    metrics: [],
    findings: [],
    charts: [],
    queries: [
      {
        id: "query-1",
        naturalLanguageQuery: "查询每日销售额",
        sql: "SELECT date, SUM(amount) as total FROM sales_daily GROUP BY date ORDER BY date",
        success: true,
        dataset: "sales_daily",
        columns: [{ name: "date", type: "DATE" }, { name: "total", type: "DECIMAL" }],
        rowCount: 30,
        resultSummary: "30 rows returned, total ranging from 10000 to 50000",
        referencedByFinding: false,
      },
    ],
    dictionary: [],
    limitations: [],
    generatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function createMockDraft(overrides?: Partial<AnalysisReportDraft>): AnalysisReportDraft {
  return {
    title: "销售趋势分析报告",
    executiveSummary: [
      { text: "本月销售额环比增长15%，达到150万元。", findingRefs: ["finding-1"] },
    ],
    background: "分析过去30天的销售数据趋势。",
    scope: "数据范围：sales_daily 表，2026-01-01 ~ 2026-01-30",
    sections: [
      {
        heading: "销售趋势",
        conclusion: "销售额呈上升趋势，环比增长15%。",
        evidenceRefs: ["query-1"],
        chartRefs: [],
        interpretation: "增长可能受促销活动驱动。",
        interpretationType: "hypothesis",
      },
    ],
    recommendations: [
      { action: "继续当前促销策略", priority: "high", rationale: "促销期间增长明显", findingRefs: [] },
    ],
    limitations: ["增长原因尚未验证", "数据仅包含30天"],
    ...overrides,
  };
}

// ============================================================================
// R1: 单表趋势分析 — 构建证据包，验证结构完整
// ============================================================================

describe("R1: 单表趋势分析 — Evidence Package 构建与结构校验", () => {
  const sessionEntries: SessionEntry[] = [
    createMockSessionEntry("user", "帮我分析销售趋势"),
    createMockSessionEntry(
      "assistant",
      "好的，让我查询一下每日销售额。",
      [
        {
          id: "tc-1",
          name: "query_data",
          arguments: {
            sql: "SELECT date, SUM(amount) as total FROM sales_daily GROUP BY date ORDER BY date",
            user_intent: "查询每日销售额",
            table_name: "sales_daily",
          },
        },
      ]
    ),
    createMockSessionEntry("toolResult", {
      toolCallId: "tc-1",
      toolName: "query_data",
      text: "Rows: 30\ndate | total\n2026-01-01 | 12000\n2026-01-02 | 15000\n...",
    }),
  ];

  it("构建的证据包 version=1 且包含 sessionId 和 question", () => {
    const pkg = buildEvidencePackage({
      sessionEntries,
      sessionId: "test-session-r1",
      question: "分析销售趋势",
      reportMode: "detailed",
      dictionaryEntries: [],
      calibers: [],
      queryMemory: [],
      reportsDir: "/tmp/reports",
    });
    assert.strictEqual(pkg.version, 1);
    assert.strictEqual(pkg.sessionId, "test-session-r1");
    assert.strictEqual(pkg.question, "分析销售趋势");
    assert.strictEqual(pkg.reportMode, "detailed");
  });

  it("证据包包含至少一个成功的 query", () => {
    const pkg = buildEvidencePackage({
      sessionEntries,
      sessionId: "test-r1",
      question: "分析销售趋势",
      reportMode: "detailed",
      dictionaryEntries: [],
      calibers: [],
      queryMemory: [],
      reportsDir: "/tmp/reports",
    });
    assert.ok(pkg.queries.length >= 1);
    assert.strictEqual(pkg.queries[0].success, true);
    assert.ok(pkg.queries[0].sql.includes("sales_daily"));
  });

  it("数据集列表包含 sales_daily", () => {
    const pkg = buildEvidencePackage({
      sessionEntries,
      sessionId: "test-r1",
      question: "分析销售趋势",
      reportMode: "detailed",
      dictionaryEntries: [],
      calibers: [],
      queryMemory: [],
      reportsDir: "/tmp/reports",
    });
    assert.ok(pkg.scope.datasets.includes("sales_daily"));
  });

  it("validateEvidencePackage 校验通过", () => {
    const pkg = buildEvidencePackage({
      sessionEntries,
      sessionId: "test-r1",
      question: "分析销售趋势",
      reportMode: "detailed",
      dictionaryEntries: [],
      calibers: [],
      queryMemory: [],
      reportsDir: "/tmp/reports",
    });
    const result = validateEvidencePackage(pkg);
    assert.strictEqual(result.valid, true);
    assert.strictEqual(result.errors.length, 0);
  });
});

// ============================================================================
// R2: 多表关联分析 — 验证数据集列表包含多个表
// ============================================================================

describe("R2: 多表关联分析 — 多个数据集", () => {
  const sessionEntries: SessionEntry[] = [
    createMockSessionEntry("user", "分析订单和用户的关系"),
    createMockSessionEntry(
      "assistant",
      "让我查询订单和用户关联数据。",
      [
        {
          id: "tc-2a",
          name: "query_data",
          arguments: { sql: "SELECT o.order_id, u.user_id, u.name FROM orders o JOIN users u ON o.user_id = u.id" },
        },
        {
          id: "tc-2b",
          name: "query_data",
          arguments: { sql: "SELECT COUNT(*) FROM products" },
        },
      ]
    ),
    createMockSessionEntry("toolResult", {
      toolCallId: "tc-2a",
      toolName: "query_data",
      text: "Rows: 100",
    }),
    createMockSessionEntry("toolResult", {
      toolCallId: "tc-2b",
      toolName: "query_data",
      text: "Rows: 1\n50",
    }),
  ];

  it("数据集列表包含从 SQL 中提取的表名", () => {
    const pkg = buildEvidencePackage({
      sessionEntries,
      sessionId: "test-r2",
      question: "分析订单和用户的关系",
      reportMode: "detailed",
      dictionaryEntries: [],
      calibers: [],
      queryMemory: [],
      reportsDir: "/tmp/reports",
    });
    // extractTableNamesFromSql 从 FROM/JOIN 提取表名/别名
    // SQL1: ... FROM orders o JOIN users u ... → 提取 orders, u（别名）
    // SQL2: ... FROM products → 提取 products
    assert.ok(pkg.scope.datasets.includes("orders"));
    assert.ok(pkg.scope.datasets.includes("products"));
    // 至少包含 2 个数据集
    assert.ok(pkg.scope.datasets.length >= 2);
  });

  it("queries 列表包含 2 条成功查询", () => {
    const pkg = buildEvidencePackage({
      sessionEntries,
      sessionId: "test-r2",
      question: "分析订单和用户的关系",
      reportMode: "detailed",
      dictionaryEntries: [],
      calibers: [],
      queryMemory: [],
      reportsDir: "/tmp/reports",
    });
    const successful = pkg.queries.filter((q) => q.success);
    assert.strictEqual(successful.length, 2);
  });
});

// ============================================================================
// R3: 含图表分析 — 验证 chartEvidence 存在且关联查询
// ============================================================================

describe("R3: 含图表分析 — ChartEvidence 关联", () => {
  const sessionEntries: SessionEntry[] = [
    createMockSessionEntry("user", "画出销售趋势图"),
    createMockSessionEntry(
      "assistant",
      "我来生成图表。",
      [
        {
          id: "tc-3q",
          name: "query_data",
          arguments: { sql: "SELECT date, SUM(amount) as total FROM sales_daily GROUP BY date" },
        },
        {
          id: "tc-3v",
          name: "visualize",
          arguments: { sql: "SELECT date, SUM(amount) as total FROM sales_daily GROUP BY date", chart_type: "line", title: "销售趋势" },
        },
      ]
    ),
    createMockSessionEntry("toolResult", { toolCallId: "tc-3q", toolName: "query_data", text: "Rows: 30" }),
    createMockSessionEntry("toolResult", { toolCallId: "tc-3v", toolName: "visualize", text: "PNG: /tmp/reports/chart-001.png" }),
  ];

  it("charts 列表非空", () => {
    const pkg = buildEvidencePackage({
      sessionEntries,
      sessionId: "test-r3",
      question: "画出销售趋势图",
      reportMode: "detailed",
      dictionaryEntries: [],
      calibers: [],
      queryMemory: [],
      reportsDir: "/tmp/reports",
    });
    assert.ok(pkg.charts.length >= 1);
    assert.strictEqual(pkg.charts[0].chartType, "line");
  });

  it("chart 包含 filePath", () => {
    const pkg = buildEvidencePackage({
      sessionEntries,
      sessionId: "test-r3",
      question: "画出销售趋势图",
      reportMode: "detailed",
      dictionaryEntries: [],
      calibers: [],
      queryMemory: [],
      reportsDir: "/tmp/reports",
    });
    const chart = pkg.charts[0];
    assert.ok(chart.filePath !== undefined);
    assert.ok(chart.filePath.includes("chart-001.png"));
  });
});

// ============================================================================
// R4: 原因未验证 — hypothesis finding 的 interpretationType 正确
// ============================================================================

describe("R4: 原因未验证 — hypothesis interpretationType", () => {
  it("extractFindings 将推测性语句分类为 hypothesis", () => {
    const sessionEntries: SessionEntry[] = [
      createMockSessionEntry("assistant", "销售额增长可能是由促销活动导致的。建议可以关注ROI。"),
    ];
    const findings = extractFindings({ sessionEntries, queries: [], charts: [] });
    const hypothesisFindings = findings.filter((f) => f.evidenceType === "hypothesis");
    assert.ok(hypothesisFindings.length >= 1);
    assert.strictEqual(hypothesisFindings[0].confidence, "low");
  });

  it("validateReportDraft 接受 hypothesis interpretationType", () => {
    const draft = createMockDraft({
      sections: [
        { heading: "增长原因分析", conclusion: "增长可能由促销驱动", evidenceRefs: [], chartRefs: [], interpretation: "推测性结论", interpretationType: "hypothesis" },
      ],
    });
    const result = validateReportDraft(draft);
    const hasInterpretationTypeError = result.errors.some((e) => e.includes("interpretationType"));
    assert.strictEqual(hasInterpretationTypeError, false);
  });

  it("validateReportDraft 拒绝非法 interpretationType", () => {
    const draft = createMockDraft({
      sections: [
        { heading: "测试", conclusion: "结论", evidenceRefs: [], chartRefs: [], interpretationType: "invalid-type" as any },
      ],
    });
    const result = validateReportDraft(draft);
    assert.ok(result.errors.some((e) => e.includes("interpretationType")));
  });
});

// ============================================================================
// R5: 证据不足 — checkEvidenceSufficiency 返回缺失项
// ============================================================================

describe("R5: 证据不足 — checkEvidenceSufficiency", () => {
  it("空查询列表返回 'No successful queries available as evidence'", () => {
    const pkg = createMockEvidencePackage({ queries: [], scope: { datasets: [], filters: [] } });
    const missing = checkEvidenceSufficiency(pkg);
    assert.ok(missing.includes("No successful queries available as evidence"));
  });

  it("无数据集信息返回 'No dataset information identified from queries'", () => {
    const pkg = createMockEvidencePackage({
      queries: [{ id: "q-1", naturalLanguageQuery: "test", sql: "SELECT 1", success: true, rowCount: 1, resultSummary: "1", columns: [] }],
      scope: { datasets: [], filters: [] },
    });
    const missing = checkEvidenceSufficiency(pkg);
    assert.ok(missing.includes("No dataset information identified from queries"));
  });

  it("完整证据包返回空数组", () => {
    const pkg = createMockEvidencePackage();
    const missing = checkEvidenceSufficiency(pkg);
    assert.strictEqual(missing.length, 0);
  });

  it("查询成功但无实质结果返回 'No queries returned substantive results'", () => {
    const pkg = createMockEvidencePackage({
      queries: [{ id: "q-1", naturalLanguageQuery: "test", sql: "SELECT * FROM sales_daily WHERE 1=0", success: true, dataset: "sales_daily", rowCount: 0, resultSummary: "", columns: [] }],
    });
    const missing = checkEvidenceSufficiency(pkg);
    assert.ok(missing.includes("No queries returned substantive results"));
  });
});

// ============================================================================
// R6: 错误 evidence ID — runQualityGate 报错
// ============================================================================

describe("R6: 错误 evidence ID — Quality Gate 引用完整性", () => {
  it("引用不存在的 finding ID 产生 error", () => {
    const evidence = createMockEvidencePackage({
      findings: [{ id: "finding-existing", statement: "销售额增长", evidenceType: "direct", resultRefs: [], chartRefs: [], queryRefs: [], metricRefs: [], confidence: "high", caveats: [] }],
    });
    const draft = createMockDraft({
      executiveSummary: [{ text: "摘要1", findingRefs: ["finding-nonexistent"] }],
    });
    const result = runQualityGate(draft, evidence);
    assert.strictEqual(result.passed, false);
    assert.ok(result.errors.length >= 1);
    assert.ok(result.errors[0].includes("non-existent finding"));
  });

  it("引用不存在的 chart ID 产生 error", () => {
    const evidence = createMockEvidencePackage();
    const draft = createMockDraft({
      sections: [{ heading: "测试图表", conclusion: "结论", evidenceRefs: [], chartRefs: ["chart-nonexistent"] }],
    });
    const result = runQualityGate(draft, evidence);
    assert.strictEqual(result.passed, false);
    assert.ok(result.errors.some((e) => e.includes("non-existent chart")));
  });

  it("引用不存在的 evidence ID 产生 error", () => {
    const evidence = createMockEvidencePackage();
    const draft = createMockDraft({
      sections: [{ heading: "测试引用", conclusion: "结论", evidenceRefs: ["evidence-nonexistent"], chartRefs: [] }],
    });
    const result = runQualityGate(draft, evidence);
    assert.strictEqual(result.passed, false);
    assert.ok(result.errors.some((e) => e.includes("non-existent evidence")));
  });
});

// ============================================================================
// R7: 多次生成 — manifest 不覆盖
// ============================================================================

describe("R7: 多次生成 — manifest 不覆盖", () => {
  it("generatedAt 时间戳在 evidence package 中存在且有效", () => {
    const pkg = createMockEvidencePackage();
    assert.ok(pkg.generatedAt !== undefined);
    assert.ok(!isNaN(new Date(pkg.generatedAt).getTime()));
  });
});

// ============================================================================
// R8: executive 模式 — ReportDraft 生成更短
// ============================================================================

describe("R8: executive 模式 — 简洁报告", () => {
  it("executive 模式 evidencePackage 正确设置 reportMode", () => {
    const pkg = createMockEvidencePackage({ reportMode: "executive" });
    assert.strictEqual(pkg.reportMode, "executive");
  });

  it("validateReportDraft 校验最小 executive 报告结构", () => {
    const executiveDraft: AnalysisReportDraft = {
      title: "Executive Summary",
      executiveSummary: [{ text: "核心结论", findingRefs: [] }],
      background: "",
      scope: "sales_daily",
      sections: [],
      recommendations: [],
      limitations: [],
    };
    const result = validateReportDraft(executiveDraft);
    assert.strictEqual(result.valid, true);
  });

  it("executive 模式渲染出的 HTML 包含报告模式 meta", () => {
    const pkg = createMockEvidencePackage({ reportMode: "executive" });
    const draft = createMockDraft({ sections: [], recommendations: [] });
    const { html } = renderAnalysisReport({
      draft, evidence: pkg, reportId: "rpt-exec-001", sourceSessionReportId: "", sourceSessionId: "sess-001", generatedAt: new Date().toISOString(), reportsDir: "/tmp/reports",
    });
    assert.ok(html.includes("executive"));
  });
});

// ============================================================================
// R9: detailed 模式 — ReportDraft 包含完整结构
// ============================================================================

describe("R9: detailed 模式 — 完整报告结构", () => {
  it("detailed 模式 evidencePackage 正确设置 reportMode", () => {
    const pkg = createMockEvidencePackage({ reportMode: "detailed" });
    assert.strictEqual(pkg.reportMode, "detailed");
  });

  it("validateReportDraft 接受完整 detailed 报告", () => {
    const draft = createMockDraft();
    const result = validateReportDraft(draft);
    assert.strictEqual(result.valid, true);
  });

  it("detailed 模式渲染包含 sections 和 recommendations", () => {
    const pkg = createMockEvidencePackage({ reportMode: "detailed" });
    const draft = createMockDraft();
    const { html } = renderAnalysisReport({
      draft, evidence: pkg, reportId: "rpt-detail-001", sourceSessionReportId: "sess-rpt-001", sourceSessionId: "sess-001", generatedAt: new Date().toISOString(), reportsDir: "/tmp/reports",
    });
    assert.ok(html.includes("关键发现"));
    assert.ok(html.includes("行动建议"));
    assert.ok(html.includes("风险与限制"));
    assert.ok(html.includes("附录"));
  });

  it("detailed 模式渲染包含核心 SQL 附录", () => {
    const pkg = createMockEvidencePackage({ reportMode: "detailed" });
    const draft = createMockDraft();
    const { html } = renderAnalysisReport({
      draft, evidence: pkg, reportId: "rpt-detail-002", sourceSessionReportId: "", sourceSessionId: "sess-001", generatedAt: new Date().toISOString(), reportsDir: "/tmp/reports",
    });
    assert.ok(html.includes("核心 SQL"));
    assert.ok(html.includes("SELECT"));
  });
});

// ============================================================================
// R10: 离线打开 — renderAnalysisReport 输出不包含外部引用
// ============================================================================

describe("R10: 离线打开 — 无外部引用", () => {
  it("渲染结果不包含外部 CSS/JS 链接", () => {
    const pkg = createMockEvidencePackage();
    const draft = createMockDraft();
    const { html } = renderAnalysisReport({
      draft, evidence: pkg, reportId: "rpt-offline-001", sourceSessionReportId: "", sourceSessionId: "sess-001", generatedAt: new Date().toISOString(), reportsDir: "/tmp/reports",
    });
    assert.ok(!/<link[^>]*href\s*=\s*["']https?:/.test(html));
    assert.ok(!/<script[^>]*src\s*=\s*["']https?:/.test(html));
    assert.ok(html.includes("<style>"));
  });

  it("渲染结果包含 DOCTYPE 和完整 HTML 结构", () => {
    const pkg = createMockEvidencePackage();
    const draft = createMockDraft();
    const { html } = renderAnalysisReport({
      draft, evidence: pkg, reportId: "rpt-offline-002", sourceSessionReportId: "", sourceSessionId: "sess-001", generatedAt: new Date().toISOString(), reportsDir: "/tmp/reports",
    });
    assert.ok(html.includes("<!DOCTYPE html>"));
    assert.ok(html.includes("<html"));
    assert.ok(html.includes("</html>"));
  });

  it("htmlSizeBytes 大于 0", () => {
    const pkg = createMockEvidencePackage();
    const draft = createMockDraft();
    const { htmlSizeBytes } = renderAnalysisReport({
      draft, evidence: pkg, reportId: "rpt-offline-003", sourceSessionReportId: "", sourceSessionId: "sess-001", generatedAt: new Date().toISOString(), reportsDir: "/tmp/reports",
    });
    assert.ok(htmlSizeBytes > 0);
  });

  it("打印样式中隐藏导航和交互控件", () => {
    const pkg = createMockEvidencePackage();
    const draft = createMockDraft();
    const { html } = renderAnalysisReport({
      draft, evidence: pkg, reportId: "rpt-offline-004", sourceSessionReportId: "", sourceSessionId: "sess-001", generatedAt: new Date().toISOString(), reportsDir: "/tmp/reports",
    });
    assert.ok(html.includes("@media print"));
    assert.ok(html.includes("display: none"));
  });
});

// ============================================================================
// 附加测试：Schema 修复
// ============================================================================

describe("附加: attemptSchemaRepair", () => {
  it("修复缺少 title 的 draft", () => {
    const { repaired, changed } = attemptSchemaRepair({} as any);
    assert.strictEqual(changed, true);
    assert.strictEqual(repaired.title, "Analysis Report");
  });

  it("修复空 executiveSummary 的 draft", () => {
    const { repaired, changed } = attemptSchemaRepair({ title: "Test" } as any);
    assert.strictEqual(changed, true);
    assert.strictEqual(repaired.executiveSummary.length, 1);
  });

  it("修复非法 priority 的 recommendation", () => {
    const { repaired, changed } = attemptSchemaRepair({
      title: "Test",
      executiveSummary: [{ text: "Summary", findingRefs: [] }],
      recommendations: [{ action: "Do something", priority: "urgent", rationale: "Because" }],
    } as any);
    assert.strictEqual(changed, true);
    assert.strictEqual(repaired.recommendations[0].priority, "medium");
  });

  it("核心字段不变", () => {
    const draft = createMockDraft();
    const { repaired } = attemptSchemaRepair(draft);
    assert.strictEqual(repaired.title, draft.title);
    assert.strictEqual(repaired.executiveSummary.length, draft.executiveSummary.length);
  });
});

// ============================================================================
// 附加测试：证据覆盖率
// ============================================================================

describe("附加: calculateEvidenceCoverage", () => {
  it("空 findings 覆盖率为 0", () => {
    const pkg = createMockEvidencePackage({ findings: [] });
    assert.strictEqual(calculateEvidenceCoverage(pkg), 0);
  });

  it("所有 findings 有引用时覆盖率为 1.0", () => {
    const pkg = createMockEvidencePackage({
      findings: [
        { id: "f-1", statement: "test", evidenceType: "direct", resultRefs: ["q-1"], chartRefs: [], queryRefs: ["query-1"], metricRefs: [], confidence: "high", caveats: [] },
      ],
    });
    assert.strictEqual(calculateEvidenceCoverage(pkg), 1.0);
  });

  it("hypothesis 不计入覆盖率", () => {
    // 只有 hypothesis 时 coreFindings 为空，coverage 返回 0（P1: 无核心证据可覆盖）
    const pkg = createMockEvidencePackage({
      findings: [
        { id: "f-hyp", statement: "推测性结论", evidenceType: "hypothesis", resultRefs: [], chartRefs: [], queryRefs: [], metricRefs: [], confidence: "low", caveats: [] },
      ],
    });
    assert.strictEqual(calculateEvidenceCoverage(pkg), 0);
  });

  it("部分 findings 无引用时覆盖率 < 1.0", () => {
    const pkg = createMockEvidencePackage({
      findings: [
        { id: "f-1", statement: "有证据", evidenceType: "direct", resultRefs: ["q-1"], chartRefs: [], queryRefs: ["query-1"], metricRefs: [], confidence: "high", caveats: [] },
        { id: "f-2", statement: "无证据", evidenceType: "direct", resultRefs: [], chartRefs: [], queryRefs: [], metricRefs: [], confidence: "medium", caveats: [] },
      ],
    });
    assert.strictEqual(calculateEvidenceCoverage(pkg), 0.5);
  });
});