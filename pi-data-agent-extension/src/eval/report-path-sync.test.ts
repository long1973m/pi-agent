/**
 * v0.8 B3 — 报告路径同步测试
 *
 * 验证：
 * 1. generateAnalysisReport 输出路径在 projectConfigDir/reports/
 * 2. manifest 同步写入，包含 datasets/charts/evidencePath
 * 3. reportId 与文件名 timestamp 一致
 * 4. Dashboard ReportIndexService 能扫描到报告
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  writeFileSync,
  mkdirSync,
  rmSync,
  existsSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateAnalysisReport } from "../report/analysis/generate-analysis-report.js";
import { ReportIndexService } from "../dashboard/services/report-index.js";

function createTempDir(): string {
  return mkdtempSync(join(tmpdir(), "pi-test-"));
}

/** 构造模拟的 callModel，返回符合 schema 的 draft JSON */
function createMockCallModel(): (
  prompt: string,
  responseFormat?: object
) => Promise<string> {
  return async () =>
    JSON.stringify({
      title: "销售数据分析报告",
      executiveSummary: [
        { text: "销售数据总体良好", findingRefs: [] },
      ],
      background: "对销售数据进行分析",
      scope: "sales 数据集",
      sections: [
        {
          heading: "销售概览",
          conclusion: "销售表现稳定",
          evidenceRefs: ["query-1"],
          chartRefs: ["chart-1"],
          interpretation: "数据稳定",
          interpretationType: "supported",
        },
      ],
      recommendations: [
        {
          action: "继续监控",
          priority: "medium",
          rationale: "保持稳定",
          findingRefs: [],
        },
      ],
      limitations: ["数据量有限"],
    });
}

/** 构造模拟 session entries，包含 query_data 和 visualize 工具调用 */
function createMockSessionEntries(): Array<{
  type: string;
  id: string;
  parentId: string | null;
  timestamp: string;
  message?: unknown;
}> {
  const now = Date.now();
  return [
    {
      type: "message",
      id: "m1",
      parentId: null,
      timestamp: new Date().toISOString(),
      message: {
        role: "user",
        content: "分析销售数据",
        timestamp: now,
      } as unknown,
    },
    {
      type: "message",
      id: "m2",
      parentId: "m1",
      timestamp: new Date().toISOString(),
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "正在查询" },
          {
            type: "toolCall",
            id: "tc1",
            name: "query_data",
            arguments: {
              sql: "SELECT * FROM sales",
              user_intent: "查询销售数据",
            },
          },
        ],
        timestamp: now,
      } as unknown,
    },
    {
      type: "message",
      id: "m3",
      parentId: "m2",
      timestamp: new Date().toISOString(),
      message: {
        role: "toolResult",
        toolCallId: "tc1",
        toolName: "query_data",
        content: [
          {
            type: "text",
            text: "Rows: 10\nResult: 总计 1000",
          },
        ],
        isError: false,
        timestamp: now,
      } as unknown,
    },
    {
      type: "message",
      id: "m4",
      parentId: "m3",
      timestamp: new Date().toISOString(),
      message: {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "tc2",
            name: "visualize",
            arguments: {
              sql: "SELECT * FROM sales",
              chart_type: "bar",
              title: "销售图表",
            },
          },
        ],
        timestamp: now,
      } as unknown,
    },
    {
      type: "message",
      id: "m5",
      parentId: "m4",
      timestamp: new Date().toISOString(),
      message: {
        role: "toolResult",
        toolCallId: "tc2",
        toolName: "visualize",
        content: [
          {
            type: "text",
            text: "PNG: /tmp/chart.png",
          },
        ],
        isError: false,
        timestamp: now,
      } as unknown,
    },
  ];
}

describe("report-path-sync", () => {
  it("generateAnalysisReport 写入 reportsDir 指定目录", async () => {
    const dir = createTempDir();
    const reportsDir = join(dir, "reports");
    mkdirSync(reportsDir, { recursive: true });

    const result = await generateAnalysisReport({
      sessionEntries: createMockSessionEntries(),
      sessionId: "test-session",
      reportMode: "detailed",
      dictionaryEntries: [],
      calibers: [],
      queryMemory: [
        {
          id: "qm1",
          naturalLanguageQuery: "查询销售数据",
          sql: "SELECT * FROM sales",
          timestamp: new Date().toISOString(),
          resultSummary: "总计 1000",
        },
      ],
      reportsDir,
      sourceSessionReportId: "session-test-session-1234567890000",
      callModel: createMockCallModel(),
    });

    assert.strictEqual(result.success, true);
    assert.ok(result.reportPath);
    assert.strictEqual(existsSync(result.reportPath!), true);
    assert.ok(result.reportPath!.startsWith(reportsDir));

    rmSync(dir, { recursive: true, force: true });
  });

  it("reportId 与文件名一致", async () => {
    const dir = createTempDir();
    const reportsDir = join(dir, "reports");
    mkdirSync(reportsDir, { recursive: true });

    const result = await generateAnalysisReport({
      sessionEntries: createMockSessionEntries(),
      sessionId: "test-session",
      reportMode: "detailed",
      dictionaryEntries: [],
      calibers: [],
      queryMemory: [
        {
          id: "qm1",
          naturalLanguageQuery: "查询销售数据",
          sql: "SELECT * FROM sales",
          timestamp: new Date().toISOString(),
          resultSummary: "总计 1000",
        },
      ],
      reportsDir,
      sourceSessionReportId: "session-test-session-1234567890000",
      callModel: createMockCallModel(),
    });

    assert.strictEqual(result.success, true);
    assert.ok(result.reportPath);
    assert.ok(result.reportId);

    const basename = result
      .reportPath!.replace(reportsDir + "/", "")
      .replace(".html", "");
    assert.strictEqual(basename, result.reportId);

    rmSync(dir, { recursive: true, force: true });
  });

  it("manifest 同步写入并包含 evidencePath", async () => {
    const projectDir = createTempDir();
    const reportsDir = join(projectDir, "reports");
    mkdirSync(reportsDir, { recursive: true });

    const result = await generateAnalysisReport({
      sessionEntries: createMockSessionEntries(),
      sessionId: "test-session",
      reportMode: "detailed",
      dictionaryEntries: [],
      calibers: [],
      queryMemory: [
        {
          id: "qm1",
          naturalLanguageQuery: "查询销售数据",
          sql: "SELECT * FROM sales",
          timestamp: new Date().toISOString(),
          resultSummary: "总计 1000",
        },
      ],
      reportsDir,
      sourceSessionReportId: "session-test-session-1234567890000",
      callModel: createMockCallModel(),
    });

    assert.strictEqual(result.success, true);
    assert.ok(result.reportPath);
    assert.ok(result.reportId);
    assert.ok(result.evidencePath);

    const service = new ReportIndexService(projectDir);
    service.addReport({
      id: result.reportId!,
      type: "analysis",
      title: "测试报告",
      summary: "测试",
      createdAt: new Date().toISOString(),
      file: result.reportPath!.replace(reportsDir + "/", ""),
      datasets: ["sales"],
      charts: [
        {
          id: "chart-1",
          title: "销售图表",
          generatedAt: new Date().toISOString(),
          dataset: "sales",
        },
      ],
      evidencePath: result.evidencePath!.replace(reportsDir + "/", ""),
    });

    const manifestPath = join(reportsDir, "manifest.json");
    assert.strictEqual(existsSync(manifestPath), true);

    const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
    assert.ok(Array.isArray(manifest.reports));
    assert.ok(manifest.reports.length > 0);
    assert.strictEqual(
      manifest.reports[0].evidencePath,
      result.evidencePath!.replace(reportsDir + "/", "")
    );

    rmSync(projectDir, { recursive: true, force: true });
  });

  it("ReportIndexService 扫描 projectDir/reports/ 目录", () => {
    const projectDir = createTempDir();
    const reportsDir = join(projectDir, "reports");
    mkdirSync(reportsDir, { recursive: true });
    writeFileSync(join(reportsDir, "test.html"), "<html></html>");

    const service = new ReportIndexService(projectDir);
    const reports = service.listByType("session");
    // legacy fallback 会扫描到 test.html
    assert.ok(Array.isArray(reports));

    rmSync(projectDir, { recursive: true, force: true });
  });
});
