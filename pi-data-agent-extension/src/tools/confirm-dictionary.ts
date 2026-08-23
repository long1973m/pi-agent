/**
 * S2.x confirm-dictionary — 数据字典列级确认工具
 *
 * 触发方式：
 * 1. 用户自然语言（"确认全部字段"、"把 amount 改成实付金额"）
 * 2. Agent 直接调用本工具
 *
 * 3 类动作：
 * - confirm_all: 确认全部字段 → user-confirmed
 * - update_fields: 修改字段含义 → user-corrected
 * - mark_uncertain: 标记字段不确定
 */

import type { ToolDefinition, AgentToolResult, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import type { ToolRegisterParams } from "./tool-context.js";

const ConfirmDictionaryParams = Type.Object({
  table_name: Type.String({ description: "要操作的表名" }),
  action: Type.String({
    description: "操作类型：confirm_all | update_fields | mark_uncertain",
    enum: ["confirm_all", "update_fields", "mark_uncertain"],
  }),
  fields: Type.Optional(
    Type.Array(
      Type.Object({
        column_name: Type.String({ description: "字段名" }),
        user_meaning: Type.Optional(Type.String({ description: "用户修正后的语义含义（update_fields 时必填）" })),
      }),
      { description: "目标字段列表（update_fields / mark_uncertain 时必填）" }
    )
  ),
});

export function createConfirmDictionaryTool(params: ToolRegisterParams): ToolDefinition {
  return {
    name: "confirm_dictionary",
    label: "Confirm Dictionary",
    description:
      "Confirm, correct, or mark uncertain field semantics in the data dictionary. " +
      "Actions: 'confirm_all' marks all columns as user-confirmed; " +
      "'update_fields' updates column meanings to user-corrected; " +
      "'mark_uncertain' marks columns as uncertain. " +
      "Persisted across restarts.",
    parameters: ConfirmDictionaryParams,
    execute: async (
      toolCallId: string,
      args: {
        table_name: string;
        action: "confirm_all" | "update_fields" | "mark_uncertain";
        fields?: Array<{ column_name: string; user_meaning?: string }>;
      },
      signal: AbortSignal | undefined,
      onUpdate: ((partialResult: AgentToolResult<unknown>) => void) | undefined,
      ctx: ExtensionContext
    ): Promise<AgentToolResult<unknown>> => {
      const rt = params.getRuntime();
      if (!rt?.dataDictionary) {
        return {
          content: [{ type: "text", text: "Error: DataDictionary manager not available." }],
          details: { toolName: "confirm_dictionary", error: "dataDictionary not available" },
        };
      }

      const dd = rt.dataDictionary;

      // 检查表是否存在字典
      if (!dd.hasDictionary(args.table_name)) {
        return {
          content: [
            {
              type: "text",
              text: `Error: No data dictionary found for table '${args.table_name}'. Run describe_data first.`,
            },
          ],
          details: { toolName: "confirm_dictionary", error: "dictionary_not_found", tableName: args.table_name },
        };
      }

      try {
        switch (args.action) {
          case "confirm_all": {
            const ok = dd.confirmAllColumns(args.table_name);
            if (!ok) {
              return {
                content: [{ type: "text", text: `Failed to confirm dictionary for '${args.table_name}'.` }],
                details: { toolName: "confirm_dictionary", error: "confirm_failed", tableName: args.table_name },
              };
            }
            const entry = dd.getDictionary(args.table_name)!;
            return {
              content: [
                {
                  type: "text",
                  text: `✅ 已确认 '${args.table_name}' 的全部 ${entry.columns.length} 个字段。`,
                },
              ],
              details: {
                toolName: "confirm_dictionary",
                action: "confirm_all",
                tableName: args.table_name,
                confirmedColumns: entry.columns.map((c) => c.name),
                persisted: true,
              },
            };
          }

          case "update_fields": {
            if (!args.fields || args.fields.length === 0) {
              return {
                content: [
                  { type: "text", text: "Error: 'fields' is required for update_fields action." },
                ],
                details: { toolName: "confirm_dictionary", error: "missing_fields", action: "update_fields" },
              };
            }

            const updates = args.fields
              .filter((f) => f.user_meaning && f.user_meaning.trim().length > 0)
              .map((f) => ({ columnName: f.column_name, userMeaning: f.user_meaning!.trim() }));

            if (updates.length === 0) {
              return {
                content: [
                  { type: "text", text: "Error: No valid field updates provided. Each field must have a user_meaning." },
                ],
                details: { toolName: "confirm_dictionary", error: "invalid_updates", action: "update_fields" },
              };
            }

            const ok = dd.updateColumnMeanings(args.table_name, updates);
            if (!ok) {
              return {
                content: [{ type: "text", text: `Failed to update field meanings for '${args.table_name}'.` }],
                details: { toolName: "confirm_dictionary", error: "update_failed", tableName: args.table_name },
              };
            }

            return {
              content: [
                {
                  type: "text",
                  text: `✏️ 已修正 ${updates.length} 个字段含义：\n${updates
                    .map((u) => `  - ${u.columnName}: ${u.userMeaning}`)
                    .join("\n")}`,
                },
              ],
              details: {
                toolName: "confirm_dictionary",
                action: "update_fields",
                tableName: args.table_name,
                updatedFields: updates,
                persisted: true,
              },
            };
          }

          case "mark_uncertain": {
            if (!args.fields || args.fields.length === 0) {
              return {
                content: [
                  { type: "text", text: "Error: 'fields' is required for mark_uncertain action." },
                ],
                details: { toolName: "confirm_dictionary", error: "missing_fields", action: "mark_uncertain" },
              };
            }

            const columnNames = args.fields.map((f) => f.column_name);
            const ok = dd.markColumnsUncertain(args.table_name, columnNames);
            if (!ok) {
              return {
                content: [{ type: "text", text: `Failed to mark fields as uncertain for '${args.table_name}'.` }],
                details: { toolName: "confirm_dictionary", error: "mark_failed", tableName: args.table_name },
              };
            }

            return {
              content: [
                {
                  type: "text",
                  text: `❓ 已将 ${columnNames.length} 个字段标记为不确定：${columnNames.join(", ")}`,
                },
              ],
              details: {
                toolName: "confirm_dictionary",
                action: "mark_uncertain",
                tableName: args.table_name,
                uncertainColumns: columnNames,
                persisted: true,
              },
            };
          }

          default:
            return {
              content: [
                {
                  type: "text",
                  text: `Error: Unknown action '${args.action}'. Supported: confirm_all, update_fields, mark_uncertain.`,
                },
              ],
              details: {
                toolName: "confirm_dictionary",
                error: "unknown_action",
                action: args.action,
              },
            };
        }
      } catch (err) {
        return {
          content: [{ type: "text", text: `Error confirming dictionary: ${err}` }],
          details: { toolName: "confirm_dictionary", error: String(err), tableName: args.table_name },
        };
      }
    },
  };
}
