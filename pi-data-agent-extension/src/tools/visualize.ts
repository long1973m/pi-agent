/**
 * S1.1 visualize — SQL 查询结果可视化（生成 PNG）
 *
 * 流程：
 * 1. SQL 安全检查（仅允许 SELECT）
 * 2. 行数检查 → 超过 visualizeMaxRows 自动采样
 * 3. DuckDB 执行查询 → 结果写入临时 CSV
 * 4. Python 无状态调用生成 PNG
 * 5. 返回路径 + 类型 + 字段 + 行数 + 大小 + 采样声明
 * 6. 失败 fallback：返回 CSV 路径 + 错误原因
 *
 * v0.3 改进：超阈值自动采样 + 声明采样信息
 */

import type { ToolDefinition, AgentToolResult, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync } from "node:fs";
import type { ToolContext, ToolRegisterParams } from "./tool-context.js";
import { PythonStatelessEngine, type ChartConfig } from "../engine/python-stateless.js";
import { generateEChartsHtml } from "../utils/echarts-template.js";
import { withPythonInstallHint } from "../utils/env-check.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** visualize 参数 */
const VisualizeParams = Type.Object({
  sql: Type.String({
    description: "要可视化的 SQL 查询语句（仅允许 SELECT）",
  }),
  chart_type: Type.String({
    description: "图表类型：bar, line, scatter, histogram, pie, box, heatmap",
  }),
  x_column: Type.Optional(Type.String({
    description: "X 轴列名（bar/line/scatter/pie 必填）",
  })),
  y_column: Type.Optional(Type.String({
    description: "Y 轴列名（bar/line/scatter/pie 可选）",
  })),
  columns: Type.Optional(Type.Array(Type.String(), {
    description: "多列名（histogram/box/heatmap 用）",
  })),
  title: Type.Optional(Type.String({
    description: "图表标题",
  })),
  output_path: Type.Optional(Type.String({
    description: "输出 PNG 路径（默认: .pi-data-agent/output/chart_<timestamp>.png）",
  })),
  options: Type.Optional(Type.Object({}, {
    description: "额外选项（如 bins, figsize, color 等）",
  })),
  interactive: Type.Optional(Type.Boolean({
    description: "如果为 true，生成交互式 HTML 图表（ECharts），支持缩放、悬停、导出。默认 false（生成 PNG）",
  })),
});

export function createVisualizeTool(params: ToolRegisterParams): ToolDefinition {
  return {
    name: "visualize",
    label: "Visualize Data",
    description:
      "Generate a chart (PNG) from a SQL query result. " +
      "Only SELECT queries are allowed. " +
      "Supported chart types: bar, line, scatter, histogram, pie, box, heatmap. " +
      "If result exceeds visualizeMaxRows (default 5000), automatic sampling is applied (random by default). " +
      "Sampling info is always declared in the output. " +
      "On failure, returns the CSV export path as fallback.",
    parameters: VisualizeParams,
    execute: async (
      toolCallId: string,
      args: {
        sql: string;
        chart_type: string;
        x_column?: string;
        y_column?: string;
        columns?: string[];
        title?: string;
        output_path?: string;
        options?: Record<string, unknown>;
        interactive?: boolean;
      },
      signal: AbortSignal | undefined,
      onUpdate: ((partialResult: AgentToolResult<unknown>) => void) | undefined,
      ctx: ExtensionContext
    ): Promise<AgentToolResult<unknown>> => {
      const rt = params.getRuntime();
      if (!rt?.engine) {
        return {
          content: [{ type: "text", text: "Error: DuckDB engine not available." }],
          details: { toolName: "visualize", error: "engine not available" },
        };
      }

      const engine = rt.engine;
      const security = rt.security;
      const config = rt.config;

      // ======================================================================
      // 1. SQL 安全检查（仅允许 SELECT）
      // ======================================================================

      const normalizedSql = args.sql.trim();
      const sqlCheck = security.checkSql(normalizedSql);

      if (sqlCheck.action === "block") {
        return {
          content: [{ type: "text", text: `Security blocked: ${sqlCheck.reason}` }],
          details: { toolName: "visualize", blocked: true, reason: sqlCheck.reason },
        };
      }

      if (!security.isReadOnly(normalizedSql)) {
        return {
          content: [{ type: "text", text: "Error: visualize only supports read-only SELECT queries." }],
          details: { toolName: "visualize", error: "non_select_sql" },
        };
      }

      // ======================================================================
      // 2. 行数检查 → 自动采样（v0.3 新增）
      // ======================================================================

      const maxRows = config.visualizeMaxRows ?? 5000;
      const strategy = config.samplingStrategy ?? "random";
      let effectiveSql = normalizedSql;
      let samplingInfo = "";
      let totalRowCount = 0;
      let sampled = false;

      try {
        // 先 COUNT 总行数
        const countSql = `SELECT COUNT(*) FROM (${normalizedSql}) AS _viz_count`;
        const countResult = await engine.query(countSql);
        totalRowCount = Number(countResult.rows[0]?.[0] ?? 0);

        if (totalRowCount > maxRows) {
          sampled = true;
          if (strategy === "random") {
            // DuckDB USING SAMPLE 语法：随机采样
            effectiveSql = `SELECT * FROM (${normalizedSql}) AS _viz_sample USING SAMPLE ${maxRows}`;
            samplingInfo = `\n⚠️ Sampling applied: random sampling ${maxRows} rows from ${totalRowCount} total rows.`;
          } else {
            // limit 策略：直接截断
            effectiveSql = `${normalizedSql} LIMIT ${maxRows}`;
            samplingInfo = `\n⚠️ Sampling applied: LIMIT ${maxRows} rows from ${totalRowCount} total rows (truncation).`;
          }
        }
      } catch (countErr) {
        // COUNT 失败不影响主流程，继续执行原始 SQL
        console.warn(`[Visualize] Failed to count rows: ${countErr}`);
      }

      // ======================================================================
      // 3. 执行查询并导出临时 CSV
      // ======================================================================

      const timestamp = Date.now();
      const outputDir = config.outputDir;
      mkdirSync(outputDir, { recursive: true });

      const csvPath = join(outputDir, `chart_data_${timestamp}.csv`);
      const isInteractive = args.interactive ?? false;
      const pngPath = args.output_path ?? join(outputDir, `chart_${timestamp}.${isInteractive ? "html" : "png"}`);

      try {
        // 先执行查询获取列信息（验证 SQL 有效性）
        const previewResult = await engine.query(effectiveSql);
        const availableColumns = previewResult.columns.map((c) => c.name);
        const actualRowCount = previewResult.rows.length;

        // 导出结果到 CSV
        const exportSql = `COPY (${effectiveSql}) TO '${csvPath}' (HEADER, DELIMITER ',');`;
        await engine.exec(exportSql);

        // ======================================================================
        // 4. 验证列名有效性
        // ======================================================================

        const validateColumn = (col?: string): boolean => {
          if (!col) return true;
          return availableColumns.includes(col);
        };

        if (args.x_column && !validateColumn(args.x_column)) {
          return {
            content: [{ type: "text", text: `Error: x_column "${args.x_column}" not found in query result. Available: ${availableColumns.join(", ")}` }],
            details: { toolName: "visualize", error: "invalid_x_column", availableColumns },
          };
        }
        if (args.y_column && !validateColumn(args.y_column)) {
          return {
            content: [{ type: "text", text: `Error: y_column "${args.y_column}" not found in query result. Available: ${availableColumns.join(", ")}` }],
            details: { toolName: "visualize", error: "invalid_y_column", availableColumns },
          };
        }
        if (args.columns) {
          const invalid = args.columns.filter((c) => !validateColumn(c));
          if (invalid.length > 0) {
            return {
              content: [{ type: "text", text: `Error: columns not found: ${invalid.join(", ")}. Available: ${availableColumns.join(", ")}` }],
              details: { toolName: "visualize", error: "invalid_columns", availableColumns },
            };
          }
        }

        // ======================================================================
        // 5. 生成图表（交互式 HTML 或静态 PNG）
        // ======================================================================

        if (isInteractive) {
          // 交互式 HTML 图表（ECharts）
          const echartsResult = generateEChartsHtml(csvPath, pngPath, {
            chartType: args.chart_type,
            xColumn: args.x_column,
            yColumn: args.y_column,
            columns: args.columns,
            title: args.title,
          });

          if (!echartsResult.success) {
            const fallbackMsg =
              `Interactive chart generation failed: ${echartsResult.error}\n\n` +
              `Fallback: query result exported to CSV.\n` +
              `CSV path: ${csvPath}\n` +
              `Rows: ${actualRowCount}${samplingInfo}`;

            return {
              content: [{ type: "text", text: fallbackMsg }],
              details: {
                toolName: "visualize",
                success: false,
                error: echartsResult.error,
                csvPath,
                rowCount: actualRowCount,
                totalRowCount,
                sampled,
                columns: availableColumns,
              },
            };
          }

          const successMsg =
            `Interactive chart generated successfully.\n` +
            `Type: ${args.chart_type} (interactive)\n` +
            `HTML: ${echartsResult.outputPath}\n` +
            `Data rows used: ${actualRowCount}` +
            (totalRowCount > 0 ? ` / Total: ${totalRowCount}` : "") +
            samplingInfo + "\n" +
            `Columns used: ${availableColumns.join(", ")}\n` +
            `Open the HTML file in a browser for interactive features (zoom, hover, export).`;

          return {
            content: [{ type: "text", text: successMsg }],
            details: {
              toolName: "visualize",
              success: true,
              htmlPath: echartsResult.outputPath,
              chartType: args.chart_type,
              interactive: true,
              rowCount: actualRowCount,
              totalRowCount: totalRowCount > 0 ? totalRowCount : undefined,
              sampled,
              samplingStrategy: sampled ? strategy : undefined,
              columns: availableColumns,
              csvPath,
            },
          };
        }

        // 静态 PNG 图表（Python matplotlib）
        const scriptPath = join(__dirname, "..", "..", "scripts", "generate_chart.py");
        const pythonEngine = new PythonStatelessEngine({ scriptPath });

        const chartConfig: ChartConfig = {
          chartType: args.chart_type as ChartConfig["chartType"],
          dataPath: csvPath,
          outputPath: pngPath,
          xColumn: args.x_column,
          yColumn: args.y_column,
          columns: args.columns,
          title: args.title,
          options: args.options,
        };

        const chartResult = await pythonEngine.generateChart(chartConfig);

        if (!chartResult.success) {
          // Fallback: 返回 CSV 路径 + 错误原因（Python 不可用时附带安装命令）
          const friendlyError = withPythonInstallHint(chartResult.error ?? "unknown error");
          const fallbackMsg =
            `Chart generation failed: ${friendlyError}\n\n` +
            `Fallback: query result exported to CSV.\n` +
            `CSV path: ${csvPath}\n` +
            `Rows: ${actualRowCount}${samplingInfo}\n` +
            `Columns: ${availableColumns.join(", ")}`;

          return {
            content: [{ type: "text", text: fallbackMsg }],
            details: {
              toolName: "visualize",
              success: false,
              error: chartResult.error,
              csvPath,
              rowCount: actualRowCount,
              totalRowCount,
              sampled,
              columns: availableColumns,
            },
          };
        }

        // ======================================================================
        // 6. 返回成功结果（含采样声明）
        // ======================================================================

        const fileSizeKb = chartResult.fileSizeBytes
          ? (chartResult.fileSizeBytes / 1024).toFixed(1)
          : "unknown";

        const successMsg =
          `Chart generated successfully.\n` +
          `Type: ${chartResult.chartType}\n` +
          `PNG: ${chartResult.outputPath}\n` +
          `Size: ${fileSizeKb} KB\n` +
          `Data rows used: ${actualRowCount}` +
          (totalRowCount > 0 ? ` / Total: ${totalRowCount}` : "") +
          samplingInfo + "\n" +
          `Columns used: ${(chartResult.columns ?? []).join(", ")}`;

        return {
          content: [{ type: "text", text: successMsg }],
          details: {
            toolName: "visualize",
            success: true,
            pngPath: chartResult.outputPath,
            chartType: chartResult.chartType,
            rowCount: actualRowCount,
            totalRowCount: totalRowCount > 0 ? totalRowCount : undefined,
            sampled,
            samplingStrategy: sampled ? strategy : undefined,
            columns: chartResult.columns,
            fileSizeBytes: chartResult.fileSizeBytes,
            csvPath,
          },
        };

      } catch (err) {
        const errorMsg = `Visualization failed: ${err instanceof Error ? err.message : String(err)}`;
        return {
          content: [{ type: "text", text: errorMsg }],
          details: { toolName: "visualize", error: errorMsg },
        };
      }
    },
  };
}
