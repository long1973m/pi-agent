/**
 * S2.6 export-result — 导出查询结果到文件
 *
 * 支持 CSV 导出，走安全层路径检查。
 * 利用 DuckDB COPY TO 原生导出能力，高效可靠。
 *
 * 流程：
 * 1. 安全层检查 SQL 和输出路径
 * 2. 用户确认写操作（autoConfirmWrite=false 时）
 * 3. 执行 COPY (subquery) TO 输出路径
 * 4. 返回导出路径、行数、文件大小
 */

import type { ToolDefinition, AgentToolResult, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { basename, join, resolve, normalize } from "node:path";
import { statSync } from "node:fs";
import type { ToolContext, ToolRegisterParams } from "./tool-context.js";
import { executeWithRecovery, recoveryResultToToolResult } from "../error-recovery.js";

/** export-result 参数 */
const ExportResultParams = Type.Object({
  sql: Type.String({
    description: "要导出的 SQL 查询语句（SELECT），结果将被导出到文件",
  }),
  output_path: Type.Optional(Type.String({
    description: "导出文件路径（默认: .pi-data-agent/output/export_<timestamp>.csv）",
  })),
  format: Type.Optional(Type.String({
    description: "导出格式：csv / json / parquet（默认: csv）",
    enum: ["csv", "json", "parquet"],
  })),
  table_name: Type.Optional(Type.String({
    description: "关联的表名（用于安全检查上下文），可选",
  })),
});

/** 格式化文件大小 */
function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function createExportResultTool(params: ToolRegisterParams): ToolDefinition {
  return {
    name: "export_result",
    label: "Export Result",
    description:
      "Export query results to a file (CSV / JSON / Parquet). " +
      "Uses DuckDB COPY TO for efficient native export. " +
      "Returns the exported file path, row count, and file size. " +
      "CSV is the default; JSON and Parquet are available for structured/binary export.",
    parameters: ExportResultParams,
    execute: async (
      toolCallId: string,
      args: {
        sql: string;
        output_path?: string;
        format?: string;
        table_name?: string;
      },
      signal: AbortSignal | undefined,
      onUpdate: ((partialResult: AgentToolResult<unknown>) => void) | undefined,
      ctx: ExtensionContext
    ): Promise<AgentToolResult<unknown>> => {
      const rt = params.getRuntime();
      if (!rt?.engine) {
        return {
          content: [{ type: "text", text: "Error: DuckDB engine not available." }],
          details: { toolName: "export_result", error: "engine not available" },
        };
      }

      // 1. SQL 安全检查
      const sqlCheck = rt.security.checkSql(args.sql);
      if (sqlCheck.action === "block") {
        return {
          content: [{ type: "text", text: `Security blocked: ${sqlCheck.reason}` }],
          details: { toolName: "export_result", blocked: true, reason: sqlCheck.reason },
        };
      }

      // 2. 确保 SQL 是只读查询（不允许导出写操作的结果）
      if (!rt.security.isReadOnly(args.sql)) {
        return {
          content: [{ type: "text", text: "Security blocked: Only SELECT queries can be exported." }],
          details: { toolName: "export_result", blocked: true, reason: "write_sql_in_export" },
        };
      }

      // 3. 确定输出路径和格式
      const format = (args.format ?? "csv").toLowerCase() as "csv" | "json" | "parquet";
      const validFormats = ["csv", "json", "parquet"];
      if (!validFormats.includes(format)) {
        return {
          content: [{ type: "text", text: `Error: Unsupported format "${format}". Supported: csv, json, parquet.` }],
          details: { toolName: "export_result", error: "unsupported_format", supportedFormats: validFormats },
        };
      }

      const defaultExt = format === "parquet" ? "parquet" : format;
      const outputPath = args.output_path
        ? resolve(args.output_path)
        : join(rt.config.outputDir, `export_${Date.now()}.${defaultExt}`);

      // 确保输出目录存在
      const outputDir = outputPath.substring(0, outputPath.lastIndexOf("/"));
      const { mkdirSync } = await import("node:fs");
      mkdirSync(outputDir, { recursive: true });

      // 4. 路径安全检查
      const pathCheck = rt.security.checkPath(outputPath);
      if (pathCheck.action === "block") {
        return {
          content: [{ type: "text", text: `Security blocked: ${pathCheck.reason}` }],
          details: { toolName: "export_result", blocked: true, reason: pathCheck.reason },
        };
      }

      // 5. 确认写操作（autoConfirmWrite=false 时）
      if (!rt.config.autoConfirmWrite && ctx.ui) {
        const confirmed = await ctx.ui.confirm(
          "Export Result",
          `Export query results to: ${outputPath}`,
          { timeout: 30000 }
        );
        if (!confirmed) {
          return {
            content: [{ type: "text", text: "Operation cancelled by user." }],
            details: { toolName: "export_result", cancelled: true },
          };
        }
      }

      // 6. 构建 COPY TO SQL（根据格式调整语法）
      const escapedPath = outputPath.replace(/'/g, "''");
      let exportSql: string;
      switch (format) {
        case "json":
          exportSql = `COPY (${args.sql}) TO '${escapedPath}' (FORMAT JSON, ARRAY true)`;
          break;
        case "parquet":
          exportSql = `COPY (${args.sql}) TO '${escapedPath}' (FORMAT PARQUET)`;
          break;
        case "csv":
        default:
          exportSql = `COPY (${args.sql}) TO '${escapedPath}' (HEADER, DELIMITER ',')`;
          break;
      }

      const recovery = await executeWithRecovery(
        async () => {
          await rt.engine!.exec(exportSql);

          // 获取行数
          const countSql = `SELECT COUNT(*) FROM (${args.sql}) AS _count_sub`;
          const countResult = await rt.engine!.query(countSql);
          const rowCount = Number(countResult.rows[0]?.[0] ?? 0);

          // 获取文件大小
          let fileSize = 0;
          try {
            const stat = statSync(outputPath);
            fileSize = stat.size;
          } catch {
            fileSize = 0;
          }

          const text = [
            `Exported ${rowCount} rows to ${outputPath}`,
            `File size: ${formatFileSize(fileSize)}`,
          ].join("\n");

          return {
            content: [{ type: "text", text }],
            details: {
              toolName: "export_result",
              sql: args.sql,
              outputPath,
              rowCount,
              fileSize,
              fileSizeFormatted: formatFileSize(fileSize),
              format,
            },
          };
        },
        {},
        {
          sql: exportSql,
          tableName: args.table_name,
          engine: rt.engine,
          toolName: "export_result",
        },
        onUpdate ? (msg: string) => onUpdate({ content: [{ type: "text", text: msg }], details: { recoveryUpdate: true } }) : undefined
      );

      return recoveryResultToToolResult(recovery, "export_result");
    },
  };
}
