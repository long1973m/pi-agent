/**
 * S2.x generate-report — 生成 Markdown 分析报告
 *
 * 触发方式：用户主动请求（"生成报告"/"导出报告"/"整理分析结果"）
 * 不自动触发，避免打扰用户。
 *
 * 报告内容：
 * - 分析目标/问题
 * - 数据范围（表名、行数、时间范围）
 * - 字段口径（字典状态、已确认含义）
 * - 使用的 SQL
 * - 结果摘要
 * - 图表路径
 * - 不确定性声明（假设、采样、未确认字段）
 */

import type { ToolDefinition, AgentToolResult, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ToolRegisterParams } from "./tool-context.js";

const GenerateReportParams = Type.Object({
  title: Type.String({ description: "报告标题" }),
  question: Type.String({ description: "用户的分析问题/目标" }),
  data_scope: Type.Object({
    tables: Type.Array(Type.String(), { description: "涉及的表名" }),
    time_range: Type.Optional(Type.String({ description: "时间范围" })),
    total_rows: Type.Optional(Type.Number({ description: "总数据行数" })),
  }, { description: "数据范围信息" }),
  field_semantics: Type.Optional(Type.Array(Type.Any(), { description: "字段口径列表（{table, column, meaning, status}）" })),
  sql_queries: Type.Optional(Type.Array(Type.Any(), { description: "SQL 查询列表（{description, sql, result_summary?}）" })),
  charts: Type.Optional(Type.Array(Type.Any(), { description: "图表列表（{description, path}）" })),
  uncertainties: Type.Optional(Type.Array(Type.String(), { description: "不确定性声明列表" })),
  output_path: Type.Optional(Type.String({ description: "报告输出路径（默认: .pi-data-agent/output/report_<timestamp>.md）" })),
});

export function createGenerateReportTool(params: ToolRegisterParams): ToolDefinition {
  return {
    name: "generate_report",
    label: "Generate Report",
    description:
      "Generate a Markdown analysis report summarizing the user's data analysis session. " +
      "Triggered by user request only (e.g., 'generate report', 'export findings'). " +
      "Includes: analysis goal, data scope, field semantics, SQL queries, result summaries, chart references, and uncertainty declarations. " +
      "Returns the generated Markdown file path.",
    parameters: GenerateReportParams,
    execute: async (
      toolCallId: string,
      args: {
        title: string;
        question: string;
        data_scope: { tables: string[]; time_range?: string; total_rows?: number };
        field_semantics?: Array<{ table: string; column: string; meaning: string; status: string }>;
        sql_queries?: Array<{ description: string; sql: string; result_summary?: string }>;
        charts?: Array<{ description: string; path: string }>;
        uncertainties?: string[];
        output_path?: string;
      },
      signal: AbortSignal | undefined,
      onUpdate: ((partialResult: AgentToolResult<unknown>) => void) | undefined,
      ctx: ExtensionContext
    ): Promise<AgentToolResult<unknown>> => {
      const rt = params.getRuntime();
      if (!rt) {
        return {
          content: [{ type: "text", text: "Error: Runtime context not available." }],
          details: { toolName: "generate_report", error: "runtime not available" },
        };
      }

      try {
        const outputPath = args.output_path
          ? args.output_path
          : join(rt.config.outputDir, `report_${Date.now()}.md`);

        // 构建 Markdown 报告
        const lines: string[] = [];
        lines.push(`# ${args.title}`);
        lines.push("");
        lines.push(`> 生成时间：${new Date().toLocaleString("zh-CN")}`);
        lines.push("");

        // 1. 分析目标
        lines.push("## 分析目标");
        lines.push("");
        lines.push(args.question);
        lines.push("");

        // 2. 数据范围
        lines.push("## 数据范围");
        lines.push("");
        lines.push(`- **涉及表**：${args.data_scope.tables.join(", ")}`);
        if (args.data_scope.time_range) {
          lines.push(`- **时间范围**：${args.data_scope.time_range}`);
        }
        if (args.data_scope.total_rows !== undefined) {
          lines.push(`- **数据行数**：${args.data_scope.total_rows.toLocaleString("zh-CN")} 行`);
        }
        lines.push("");

        // 3. 字段口径
        if (args.field_semantics && args.field_semantics.length > 0) {
          lines.push("## 字段口径");
          lines.push("");
          lines.push("| 表 | 字段 | 语义 | 状态 |");
          lines.push("|---|---|---|---|");
          for (const f of args.field_semantics) {
            const statusEmoji: Record<string, string> = {
              "ai-guessed": "🤖",
              "user-confirmed": "✅",
              "user-corrected": "✏️",
              uncertain: "❓",
            };
            const emoji = statusEmoji[f.status] ?? "🤖";
            lines.push(`| ${f.table} | ${f.column} | ${f.meaning} | ${emoji} ${f.status} |`);
          }
          lines.push("");
        }

        // 4. SQL 查询
        if (args.sql_queries && args.sql_queries.length > 0) {
          lines.push("## 分析过程");
          lines.push("");
          for (let i = 0; i < args.sql_queries.length; i++) {
            const q = args.sql_queries[i];
            lines.push(`### 查询 ${i + 1}：${q.description}`);
            lines.push("");
            lines.push("```sql");
            lines.push(q.sql);
            lines.push("```");
            lines.push("");
            if (q.result_summary) {
              lines.push(`**结果摘要**：${q.result_summary}`);
              lines.push("");
            }
          }
        }

        // 5. 图表
        if (args.charts && args.charts.length > 0) {
          lines.push("## 可视化图表");
          lines.push("");
          for (const c of args.charts) {
            lines.push(`- ${c.description}：\`${c.path}\``);
          }
          lines.push("");
        }

        // 6. 不确定性声明
        if (args.uncertainties && args.uncertainties.length > 0) {
          lines.push("## ⚠️ 不确定性声明");
          lines.push("");
          lines.push("以下假设或限制可能影响分析结论的可靠性：");
          lines.push("");
          for (const u of args.uncertainties) {
            lines.push(`- ${u}`);
          }
          lines.push("");
        }

        // 7. 页脚
        lines.push("---");
        lines.push("");
        lines.push("*本报告由 Pi Data Agent 自动生成。分析结论基于当前数据集，建议结合业务背景审慎使用。*");
        lines.push("");

        const markdown = lines.join("\n");
        writeFileSync(outputPath, markdown, "utf-8");

        return {
          content: [
            {
              type: "text",
              text: `报告已生成：${outputPath}\n\n${args.title}\n共 ${lines.length} 行 Markdown 内容。`,
            },
          ],
          details: {
            toolName: "generate_report",
            outputPath,
            title: args.title,
            lineCount: lines.length,
            tables: args.data_scope.tables,
            queryCount: args.sql_queries?.length ?? 0,
            chartCount: args.charts?.length ?? 0,
            hasUncertainties: (args.uncertainties?.length ?? 0) > 0,
          },
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Error generating report: ${err}` }],
          details: { toolName: "generate_report", error: String(err) },
        };
      }
    },
  };
}
