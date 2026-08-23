/**
 * S2.3 query-data — SQL 查询（含安全检查 + 大结果处理 + 字典不确定性提示）
 *
 * 流程：SQL 安全检查 → 大结果处理 → 返回预览 + 总行数 + 落盘路径 + 不确定性警告
 * 关键：结果通过 details 元数据传递，content 只放摘要文本
 */

import type { ToolDefinition, AgentToolResult, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import type { ToolContext, ToolRegisterParams } from "./tool-context.js";
import { formatQueryResult } from "./tool-context.js";
import { executeWithRecovery, recoveryResultToToolResult } from "../error-recovery.js";
import { resolveConfirmGate } from "../security.js";

const QueryDataParams = Type.Object({
  sql: Type.String({ description: "要执行的 SQL 查询语句（SELECT/DESCRIBE/SHOW）" }),
  user_intent: Type.String({
    description: "用户原始自然语言问题，必须传入，不得为空。用于判断用户意图是否明确。如果用户是开放式分析请求（如'分析一下'、'看看数据'），应优先调用 ask_clarification，而不是直接 query_data。",
  }),
  assumptions: Type.Optional(Type.String({
    description: "模型生成 SQL 时的隐含假设说明，可选。用于追溯 SQL 与原始意图之间的差异。",
  })),
  table_name: Type.Optional(Type.String({
    description: "关联的表名（用于查询记忆匹配），可选",
  })),
});

export function createQueryDataTool(params: ToolRegisterParams): ToolDefinition {
  return {
    name: "query_data",
    label: "Query Data",
    description:
      "Execute a read-only SQL query against loaded data. " +
      "Every call MUST include both `sql` and `user_intent`. " +
      "`user_intent` must contain the user's original natural language question. " +
      "For open-ended analysis requests (e.g., 'analyze these data', 'take a look'), prefer calling ask_clarification FIRST instead of query_data. " +
      "Large results are automatically truncated with a preview + CSV export path. " +
      "If columns with 'uncertain' status are used, a warning will be included. " +
      "Use table_name for query memory association.",
    parameters: QueryDataParams,
    execute: async (
      toolCallId: string,
      args: { sql: string; user_intent: string; assumptions?: string; table_name?: string },
      signal: AbortSignal | undefined,
      onUpdate: ((partialResult: AgentToolResult<unknown>) => void) | undefined,
      ctx: ExtensionContext
    ): Promise<AgentToolResult<unknown>> => {
      const rt = params.getRuntime();
      if (!rt?.engine) {
        return {
          content: [{ type: "text", text: "Error: DuckDB engine not available." }],
          details: { toolName: "query_data", error: "engine not available" },
        };
      }

      // 0. user_intent 不能为空
      if (!args.user_intent || args.user_intent.trim().length === 0) {
        return {
          content: [{ type: "text", text: "Error: user_intent is required and cannot be empty. Please provide the user's original natural language question." }],
          details: { toolName: "query_data", error: "missing_user_intent" },
        };
      }

      // 1. SQL 安全检查
      const sqlCheck = rt.security.checkSql(args.sql);
      if (sqlCheck.action === "block") {
        return {
          content: [{ type: "text", text: `Security blocked: ${sqlCheck.reason}` }],
          details: { toolName: "query_data", blocked: true, reason: sqlCheck.reason },
        };
      }

      // 2. 写操作确认门（fail-closed：无 UI 且未显式配置 autoConfirmWrite 时直接拒绝）
      let autoConfirmedWrite = false;
      if (sqlCheck.action === "confirm") {
        const gate = resolveConfirmGate(sqlCheck.confirmMessage!, {
          autoConfirmWrite: rt.config.autoConfirmWrite,
          hasUi: Boolean(ctx.ui),
        });
        if (gate.action === "block") {
          return {
            content: [{ type: "text", text: `Security blocked: ${gate.reason}` }],
            details: { toolName: "query_data", blocked: true, reason: gate.reason },
          };
        }
        if (gate.action === "confirm") {
          const confirmed = await ctx.ui.confirm("Query Data", gate.confirmMessage, { timeout: 30000 });
          if (!confirmed) {
            return {
              content: [{ type: "text", text: "Operation cancelled by user." }],
              details: { toolName: "query_data", cancelled: true },
            };
          }
        } else {
          autoConfirmedWrite = true;
        }
      }

      // 3. 执行查询（带错误恢复）
      const recovery = await executeWithRecovery(
        async () => {
          const result = await rt.engine!.executeQueryWithLimit(args.sql);
          const text = formatQueryResult(result);

          // 4. 字典口径提示 + 不确定性警告
          let dictWarning = "";
          let dictStatus: string | null = null;
          const uncertaintyWarnings: string[] = [];
          const involvedColumns: Array<{ name: string; inferredMeaning: string; userMeaning?: string; status: string }> = [];

          if (args.table_name) {
            const dict = rt.dataDictionary.getDictionary(args.table_name);
            dictStatus = dict?.status ?? null;

            if (dict && dict.columns.length > 0) {
              const sqlLower = args.sql.toLowerCase();

              // 收集涉及的列信息（含 userMeaning 优先）
              for (const col of dict.columns) {
                if (sqlLower.includes(col.name.toLowerCase())) {
                  involvedColumns.push({
                    name: col.name,
                    inferredMeaning: col.inferredMeaning,
                    userMeaning: col.userMeaning,
                    status: col.status,
                  });

                  // uncertain 字段 → 添加不确定性警告
                  if (col.status === "uncertain") {
                    uncertaintyWarnings.push(
                      `字段 "${col.name}" 语义未确认（标记为不确定），当前推断含义：${col.inferredMeaning}。分析结果可能不准确。`
                    );
                  }
                }
              }

              // AI-guessed 状态的常规提示
              if (dict.status === "ai-guessed" && involvedColumns.length > 0) {
                const colLines = involvedColumns
                  .map((c) => {
                    const meaning = c.userMeaning ?? c.inferredMeaning;
                    const statusTag = c.status === "user-corrected" ? "[已修正]" : "[AI推断]";
                    return `  - ${c.name}: ${meaning} ${statusTag}`;
                  })
                  .join("\n");
                dictWarning =
                  `\n\n⚠ Dictionary status: ai-guessed (not yet confirmed)\n` +
                  `Field semantics below are AI-inferred. Run describe_data to review.\n` +
                  `Involved columns in this query:\n${colLines}`;
              }

              // 如果有 user-corrected 字段被使用，展示确认信息
              const correctedCols = involvedColumns.filter((c) => c.status === "user-corrected");
              if (correctedCols.length > 0 && dict.status !== "ai-guessed") {
                const correctedLines = correctedCols
                  .map((c) => `  - ${c.name}: ${c.userMeaning} (原: ${c.inferredMeaning})`)
                  .join("\n");
                dictWarning +=
                  `\n\n✏️ Using user-corrected semantics:\n${correctedLines}`;
              }
            }
          }

          // 5. 记录成功查询到 query memory
          if (rt.queryMemory) {
            const datasetFingerprint = rt.queryMemory.getCurrentDatasetFingerprint() ?? "";
            rt.queryMemory.recordQuery({
              naturalLanguageQuery: args.user_intent,
              sql: args.sql,
              datasetFingerprint,
              resultSummary: `Rows: ${result.totalRowCount}, Columns: ${result.columns.length}`,
            });
          }

          // 6. 组装不确定性警告文本
          let uncertaintyText = "";
          if (uncertaintyWarnings.length > 0) {
            uncertaintyText =
              `\n\n⚠️ 不确定性警告：\n` +
              uncertaintyWarnings.map((w) => `  • ${w}`).join("\n") +
              `\n\n建议：运行 describe_data("${args.table_name}") 确认字段含义后再分析。`;
          }

          return {
            content: [{ type: "text", text: text + dictWarning + uncertaintyText }],
            details: {
              toolName: "query_data",
              sql: args.sql,
              userIntent: args.user_intent,
              assumptions: args.assumptions ?? null,
              autoConfirmedWrite,
              totalRowCount: result.totalRowCount,
              returnedRowCount: result.returnedRowCount,
              truncated: result.truncated,
              csvPath: result.csvPath,
              executionTimeMs: result.executionTimeMs,
              columns: result.columns.map((c) => ({ name: c.name, type: c.type })),
              associatedTable: args.table_name ?? null,
              dictionaryStatus: dictStatus,
              dictWarningProvided: dictWarning.length > 0,
              uncertaintyWarnings: uncertaintyWarnings.length > 0 ? uncertaintyWarnings : undefined,
              involvedColumns: involvedColumns.length > 0 ? involvedColumns : undefined,
            },
          };
        },
        {},
        {
          sql: args.sql,
          tableName: args.table_name,
          engine: rt.engine,
          toolName: "query_data",
        },
        onUpdate ? (msg: string) => onUpdate({ content: [{ type: "text", text: msg }], details: { recoveryUpdate: true } }) : undefined
      );

      // 6. 失败时记录到 failed query store（不影响主结果返回）
      if (!recovery.result && recovery.error && rt.queryMemory) {
        rt.queryMemory.recordFailedQuery({
          naturalLanguageQuery: args.user_intent,
          sql: args.sql,
          errorMessage: recovery.error,
        });
      }

      return recoveryResultToToolResult(recovery, "query_data");
    },
  };
}
