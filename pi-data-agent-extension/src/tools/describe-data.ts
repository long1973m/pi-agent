/**
 * S2.2 describe-data — 表结构 + 统计摘要 + 数据字典状态展示
 *
 * 流程：表存在性检查 → DESCRIBE 列信息 → SUMMARIZE 统计 → 展示字典状态
 * 返回：列名、类型、null 比例、唯一值、分布、高频值 + 字典确认状态 + 操作提示
 */

import type { ToolDefinition, AgentToolResult, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import type { ToolContext, ToolRegisterParams } from "./tool-context.js";

const DescribeDataParams = Type.Object({
  table_name: Type.String({ description: "要描述的表名" }),
});

export function createDescribeDataTool(params: ToolRegisterParams): ToolDefinition {
  return {
    name: "describe_data",
    label: "Describe Data",
    description:
      "Describe a table's schema and statistical summary. " +
      "Returns column types, null ratios, unique counts, distributions, and top values. " +
      "Also shows data dictionary status (ai-guessed / user-confirmed / user-corrected / uncertain) for each column. " +
      "Users can confirm/correct field semantics through natural language or the confirm_dictionary tool.",
    parameters: DescribeDataParams,
    execute: async (
      toolCallId: string,
      args: { table_name: string },
      signal: AbortSignal | undefined,
      onUpdate: ((partialResult: AgentToolResult<unknown>) => void) | undefined,
      ctx: ExtensionContext
    ): Promise<AgentToolResult<unknown>> => {
      const rt = params.getRuntime();
      if (!rt?.engine) {
        return {
          content: [{ type: "text", text: "Error: DuckDB engine not available." }],
          details: { toolName: "describe_data", error: "engine not available" },
        };
      }

      try {
        // 1. 确保数据字典已生成
        const { entry: dictEntry, isNew: isNewDict } = await rt.dataDictionary.ensureDictionary(
          args.table_name,
          rt.engine
        );

        // 1.5 静默刷新 schema fingerprint（describe 时可能表结构已变化）
        await rt.dataDictionary.refreshFingerprint(args.table_name, rt.engine);

        // 2. 表概览
        const overview = await rt.engine.getTableOverview(args.table_name);

        // 3. 列级统计（用 SUMMARIZE）
        const safeTable = rt.engine.quoteIdentifier(args.table_name);
        const summaryReader = await rt.engine.query(
          `SELECT * FROM (SUMMARIZE SELECT * FROM ${safeTable}) ORDER BY column_name`
        );

        // 4. 组织输出
        const parts: string[] = [];
        parts.push(`Table: ${overview.name}`);
        parts.push(`Rows: ${overview.rowCount}`);
        parts.push(`\n## Columns (${overview.columnCount})\n`);

        // 列信息（带语义推断 + 状态标注）
        for (const col of overview.columns) {
          const semantic = dictEntry.columns.find((c) => c.name === col.name);
          const status = semantic?.status ?? "ai-guessed";
          const statusLabel = {
            "ai-guessed": "[AI推断]",
            "user-confirmed": "[已确认]",
            "user-corrected": "[已修正]",
            uncertain: "[不确定]",
          }[status];

          const meaning = semantic
            ? (semantic.userMeaning ?? semantic.inferredMeaning)
            : "";
          const meaningText = meaning ? ` — ${meaning} ${statusLabel}` : "";
          parts.push(`- ${col.name}: ${col.type}${col.nullable ? " (nullable)" : ""}${meaningText}`);
        }

        // 统计信息（动态列索引映射，避免版本差异）
        const cols = summaryReader.columns.map((c) => c.name);
        const idxName = cols.indexOf("column_name");

        if (summaryReader.rows.length > 0 && idxName >= 0) {
          parts.push(`\n## Statistics\n`);
          for (const row of summaryReader.rows) {
            const colName = String(row[idxName]);
            const stats: string[] = [];
            // 收集所有非空统计值
            cols.forEach((col, i) => {
              if (col !== "column_name" && row[i] !== null && row[i] !== undefined) {
                stats.push(`${col}=${row[i]}`);
              }
            });
            parts.push(`- ${colName}: ${stats.join(", ")}`);
          }
        }

        // 5. 数据字典状态摘要
        parts.push(`\n## Data Dictionary Status\n`);
        const confirmedCount = dictEntry.columns.filter(
          (c) => c.status === "user-confirmed" || c.status === "user-corrected"
        ).length;
        const uncertainCount = dictEntry.columns.filter((c) => c.status === "uncertain").length;
        const aiGuessedCount = dictEntry.columns.filter((c) => c.status === "ai-guessed").length;

        parts.push(`- 已确认: ${confirmedCount} / ${dictEntry.columns.length}`);
        parts.push(`- AI推断: ${aiGuessedCount} / ${dictEntry.columns.length}`);
        if (uncertainCount > 0) {
          parts.push(`- 不确定: ${uncertainCount} / ${dictEntry.columns.length}`);
        }

        // 6. 操作提示（v0.3 新增）
        const actionHints = rt.dataDictionary.formatDictionaryActions(args.table_name);
        if (actionHints) {
          parts.push(actionHints);
        }

        // 7. 新字典 → 提示用户确认（v0.3 改为提示而非阻塞确认）
        if (isNewDict) {
          parts.push(
            `\n\n⚠️ 数据字典刚生成（AI 推断），建议检查并确认字段含义。` +
            `你可以说"确认全部字段"，或逐个修正。`
          );
        }

        return {
          content: [{ type: "text", text: parts.join("\n") }],
          details: {
            toolName: "describe_data",
            tableName: overview.name,
            rowCount: overview.rowCount,
            columnCount: overview.columnCount,
            columns: overview.columns,
            summaryRows: summaryReader.rows.length,
            dictionaryStatus: dictEntry.status,
            dictionaryColumnStatus: dictEntry.columns.map((c) => ({
              name: c.name,
              status: c.status,
              meaning: c.userMeaning ?? c.inferredMeaning,
            })),
            isNewDictionary: isNewDict,
          },
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Error describing data: ${err}` }],
          details: { toolName: "describe_data", error: String(err) },
        };
      }
    },
  };
}
