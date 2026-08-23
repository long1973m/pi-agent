/**
 * S2.4 transform-data — 写操作（CTAS/INSERT/UPDATE/DELETE）
 *
 * 流程：SQL 安全检查 → 用户确认 → 执行 → 返回影响行数 + 新表概览
 */

import type { ToolDefinition, AgentToolResult, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import type { ToolContext, ToolRegisterParams } from "./tool-context.js";
import { executeWithRecovery, recoveryResultToToolResult } from "../error-recovery.js";

const TransformDataParams = Type.Object({
  sql: Type.String({
    description: "写操作 SQL（CREATE TABLE AS SELECT / INSERT / UPDATE / DELETE / DROP）",
  }),
  output_table: Type.Optional(Type.String({
    description: "输出表名（CTAS 时），用于返回新表概览",
  })),
});

export function createTransformDataTool(params: ToolRegisterParams): ToolDefinition {
  return {
    name: "transform_data",
    label: "Transform Data",
    description:
      "Execute a write SQL operation (CREATE TABLE AS, INSERT, UPDATE, DELETE, DROP). " +
      "Requires user confirmation for safety.",
    parameters: TransformDataParams,
    execute: async (
      toolCallId: string,
      args: { sql: string; output_table?: string },
      signal: AbortSignal | undefined,
      onUpdate: ((partialResult: AgentToolResult<unknown>) => void) | undefined,
      ctx: ExtensionContext
    ): Promise<AgentToolResult<unknown>> => {
      const rt = params.getRuntime();
      if (!rt?.engine) {
        return {
          content: [{ type: "text", text: "Error: DuckDB engine not available." }],
          details: { toolName: "transform_data", error: "engine not available" },
        };
      }

      // 1. SQL 安全检查
      const sqlCheck = rt.security.checkSql(args.sql);
      if (sqlCheck.action === "block") {
        return {
          content: [{ type: "text", text: `Security blocked: ${sqlCheck.reason}` }],
          details: { toolName: "transform_data", blocked: true, reason: sqlCheck.reason },
        };
      }

      // 2. 强制确认（写操作），autoConfirmWrite=true 时跳过
      if (!rt.config.autoConfirmWrite && ctx.ui) {
        const msg = sqlCheck.confirmMessage
          ?? `Write operation: "${args.sql.slice(0, 80)}${args.sql.length > 80 ? "..." : ""}". Proceed?`;
        const confirmed = await ctx.ui.confirm("Transform Data", msg, { timeout: 30000 });
        if (!confirmed) {
          return {
            content: [{ type: "text", text: "Operation cancelled by user." }],
            details: { toolName: "transform_data", cancelled: true },
          };
        }
      }

      // 3. 执行（带错误恢复）
      const recovery = await executeWithRecovery(
        async () => {
          const { rowCount } = await rt.engine!.exec(args.sql);

          // 返回新表概览（如果有 output_table）
          let tableInfo: string | undefined;
          let detailsExtra: Record<string, unknown> = {};
          if (args.output_table) {
            try {
              const overview = await rt.engine!.getTableOverview(args.output_table);
              tableInfo = `New table "${overview.name}": ${overview.rowCount} rows, ${overview.columnCount} columns`;
              detailsExtra = {
                outputTable: overview.name,
                outputRowCount: overview.rowCount,
                outputColumnCount: overview.columnCount,
                outputColumns: overview.columns,
              };
            } catch {
              // output_table 可能未创建成功
            }
          }

          const text = [
            `Transform executed successfully.`,
            `Affected rows: ${rowCount}`,
            tableInfo ?? "",
          ].filter(Boolean).join("\n");

          return {
            content: [{ type: "text", text }],
            details: {
              toolName: "transform_data",
              sql: args.sql,
              rowCount,
              ...detailsExtra,
            },
          };
        },
        {},
        {
          sql: args.sql,
          tableName: args.output_table,
          engine: rt.engine,
          toolName: "transform_data",
        },
        onUpdate ? (msg: string) => onUpdate({ content: [{ type: "text", text: msg }], details: { recoveryUpdate: true } }) : undefined
      );

      return recoveryResultToToolResult(recovery, "transform_data");
    },
  };
}
