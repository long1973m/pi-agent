/**
 * Task 4 — generate_session_report 工具
 *
 * 独立工具，不修改 v0.3 的 generate_report（数据报告）。
 *
 * 执行流程：
 * 1. ctx.sessionManager.getBranch() → entries
 * 2. getSessionTranscript() → transcript
 * 3. extractChartPaths() + inlineChartAssets() → 图表内联
 * 4. renderReport() → HTML 字符串
 * 5. 写入 <cwd>/reports/session-<timestamp>.html（路径经 security.checkPath 验证）
 * 6. openBrowser() 自动打开
 */

import type { ToolDefinition, AgentToolResult, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { renderReport } from "../report/render-report.js";
import { openBrowser } from "../utils/open-browser.js";
import type { ToolRegisterParams } from "./tool-context.js";

const GenerateSessionReportParams = Type.Object({
  title: Type.Optional(Type.String({
    description: "报告标题（默认: 分析会话报告）",
  })),
  output_path: Type.Optional(Type.String({
    description: "报告输出路径（默认: reports/session-<timestamp>.html）",
  })),
});

export function createGenerateSessionReportTool(params: ToolRegisterParams): ToolDefinition {
  return {
    name: "generate_session_report",
    label: "Generate Session Report",
    description:
      "Generate a self-contained HTML session report with message flow and inline charts. " +
      "The report is offline-capable (all charts are base64 embedded). " +
      "Use after completing a full analysis cycle. " +
      "For data-specific reports (focused on a single query's results), use generate_report instead.",
    parameters: GenerateSessionReportParams,
    execute: async (
      toolCallId: string,
      args: { title?: string; output_path?: string },
      signal: AbortSignal | undefined,
      onUpdate: ((partialResult: AgentToolResult<unknown>) => void) | undefined,
      ctx: ExtensionContext
    ): Promise<AgentToolResult<unknown>> => {
      const rt = params.getRuntime();
      if (!rt) {
        return {
          content: [{ type: "text", text: "Error: Runtime context not available." }],
          details: { toolName: "generate_session_report", error: "runtime not available" },
        };
      }

      try {
        // 1. 读取 session entries
        const entries = ctx.sessionManager.getBranch();
        if (entries.length === 0) {
          return {
            content: [{ type: "text", text: "当前会话没有消息，无法生成报告。" }],
            details: { toolName: "generate_session_report", error: "empty_session" },
          };
        }

        // 2. 确定输出路径
        const title = args.title ?? "分析会话报告";
        const reportsDir = join(rt.config.cwd, "reports");
        const defaultOutputPath = join(reportsDir, `session-${Date.now()}.html`);
        const outputPath = args.output_path ?? defaultOutputPath;

        // 3. 路径白名单检查
        const pathCheck = rt.security.checkPath(outputPath);
        if (pathCheck.action === "block") {
          return {
            content: [{ type: "text", text: `Security blocked: ${pathCheck.reason}` }],
            details: { toolName: "generate_session_report", blocked: true, reason: pathCheck.reason },
          };
        }

        // 4. 确保输出目录存在
        const outputDir = dirname(outputPath);
        mkdirSync(outputDir, { recursive: true });

        // 5. 读取数据字典（v0.5 新增）
        const dictionaryEntries = rt.persistence
          ? rt.persistence.loadMergedDataDictionary()
          : new Map();
        const dictArray = Array.from(dictionaryEntries.values());

        // 6. 提取摘要 — 取第一条用户消息的文本前 100 字符
        const metaSummary = extractFirstUserQuery(entries);

        // 7. 渲染报告
        const result = renderReport({
          entries: entries as Array<{ type: string; id: string; parentId: string | null; timestamp: string; message?: unknown }>,
          title,
          generatedAt: new Date().toLocaleString("zh-CN"),
          dictionaryEntries: dictArray.length > 0 ? dictArray : undefined,
          metaSummary,
          reportsDir,
        });

        // 6. 写入文件
        writeFileSync(outputPath, result.html, "utf-8");

        // 7. 自动打开浏览器
        const opened = await openBrowser(outputPath);
        const browserNote = opened
          ? "已在浏览器中打开。"
          : `无法自动打开浏览器，请手动打开: ${outputPath}`;

        // 8. 返回结果
        const summary =
          `会话报告已生成。\n` +
          `路径: ${outputPath}\n` +
          `消息数: ${result.messageCount}\n` +
          `图表数: ${result.inlinedChartCount}/${result.chartCount}（内联/总计）\n` +
          `文件大小: ${(result.htmlSizeBytes / 1024).toFixed(1)} KB\n` +
          browserNote;

        return {
          content: [{ type: "text", text: summary }],
          details: {
            toolName: "generate_session_report",
            reportPath: outputPath,
            messageCount: result.messageCount,
            chartCount: result.chartCount,
            inlinedChartCount: result.inlinedChartCount,
            fileSizeBytes: result.htmlSizeBytes,
            browserOpened: opened,
          },
        };
      } catch (err) {
        const errorMsg = `Error generating session report: ${err instanceof Error ? err.message : String(err)}`;
        return {
          content: [{ type: "text", text: errorMsg }],
          details: { toolName: "generate_session_report", error: errorMsg },
        };
      }
    },
  };
}

/**
 * 从 session entries 中提取第一条用户消息作为摘要
 */
function extractFirstUserQuery(entries: unknown[]): string {
  try {
    for (const entry of entries) {
      const e = entry as { type?: string; message?: { role?: string; content?: unknown } };
      if (e.type === "message" && e.message?.role === "user") {
        const content = e.message.content;
        let text = "";
        if (typeof content === "string") {
          text = content;
        } else if (Array.isArray(content)) {
          text = content
            .filter((c: unknown) => (c as { type?: string }).type === "text")
            .map((c: unknown) => (c as { text?: string }).text)
            .join(" ");
        }
        return text.slice(0, 100).trim() || "分析会话";
      }
    }
  } catch {
    // 提取失败不影响报告生成
  }
  return "分析会话";
}