/**
 * S2.5 list-datasets — 列出所有已加载表（含 attached 数据库来源）
 *
 * 流程：查询 DuckDB information_schema.tables → 按 schema 分组 → 返回表名、行数、列数、来源
 * v0.3 改进：显示 attached SQLite 数据库来源（alias.schema）
 */

import type { ToolDefinition, AgentToolResult, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ToolRegisterParams } from "./tool-context.js";

export function createListDatasetsTool(params: ToolRegisterParams): ToolDefinition {
  return {
    name: "list_datasets",
    label: "List Datasets",
    description:
      "List all loaded tables in DuckDB with row counts, column counts, and source information. " +
      "Shows both local tables (main schema) and attached SQLite databases (with alias prefix).",
    parameters: {} as never, // 无参数
    execute: async (
      toolCallId: string,
      args: Record<string, never>,
      signal: AbortSignal | undefined,
      onUpdate: ((partialResult: AgentToolResult<unknown>) => void) | undefined,
      ctx: ExtensionContext
    ): Promise<AgentToolResult<unknown>> => {
      const rt = params.getRuntime();
      if (!rt?.engine) {
        return {
          content: [{ type: "text", text: "Error: DuckDB engine not available." }],
          details: { toolName: "list_datasets", error: "engine not available" },
        };
      }

      try {
        // 查询所有 schema 的表（包括 main 和 attached）
        const allTablesReader = await rt.engine.query(
          `SELECT table_catalog, table_schema, table_name
           FROM information_schema.tables
           WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
           ORDER BY table_schema, table_name`
        );

        const tableEntries: Array<{
          catalog: string;
          schema: string;
          name: string;
          source: string;
          rowCount?: number;
          columnCount?: number;
          columns?: Array<{ name: string; type: string }>;
        }> = [];

        for (const row of allTablesReader.rows) {
          const catalog = String(row[0] ?? "");
          const schema = String(row[1] ?? "");
          const name = String(row[2] ?? "");
          const source = schema === "main" ? "local" : `attached:${schema}`;

          // 获取表概览
          const fullTableName = schema === "main" ? name : `${schema}.${name}`;
          let overview = null;
          try {
            overview = await rt.engine.getTableOverview(fullTableName);
          } catch {
            // 某些系统表或视图可能无法获取概览，忽略
          }

          tableEntries.push({
            catalog,
            schema,
            name,
            source,
            rowCount: overview?.rowCount,
            columnCount: overview?.columnCount,
            columns: overview?.columns.map((c) => ({ name: c.name, type: c.type })),
          });
        }

        if (tableEntries.length === 0) {
          return {
            content: [{ type: "text", text: "No datasets loaded. Use load_data to add data or connect_database to attach a SQLite database." }],
            details: { toolName: "list_datasets", count: 0 },
          };
        }

        // 按来源分组展示
        const localTables = tableEntries.filter((t) => t.source === "local");
        const attachedTables = tableEntries.filter((t) => t.source.startsWith("attached:"));

        const parts: string[] = [];
        parts.push(`Loaded datasets (${tableEntries.length}):\n`);

        if (localTables.length > 0) {
          parts.push("\n## Local Tables (main schema)\n");
          for (const t of localTables) {
            const cols = t.columns?.slice(0, 5).map((c) => c.name).join(", ") ?? "";
            const colSuffix = (t.columns?.length ?? 0) > 5 ? ` +${t.columns!.length - 5} more` : "";
            parts.push(`- ${t.name}: ${t.rowCount ?? "?"} rows, ${t.columnCount ?? "?"} cols [${cols}${colSuffix}]`);
          }
        }

        if (attachedTables.length > 0) {
          parts.push("\n## Attached Databases\n");
          // 按 schema 分组
          const bySchema = new Map<string, typeof attachedTables>();
          for (const t of attachedTables) {
            const schema = t.schema;
            if (!bySchema.has(schema)) bySchema.set(schema, []);
            bySchema.get(schema)!.push(t);
          }

          for (const [schema, tables] of bySchema) {
            parts.push(`\n[${schema}]`);
            for (const t of tables) {
              const cols = t.columns?.slice(0, 5).map((c) => c.name).join(", ") ?? "";
              const colSuffix = (t.columns?.length ?? 0) > 5 ? ` +${t.columns!.length - 5} more` : "";
              parts.push(`  - ${t.name}: ${t.rowCount ?? "?"} rows, ${t.columnCount ?? "?"} cols [${cols}${colSuffix}]`);
            }
          }
        }

        // 跨库查询提示
        if (attachedTables.length > 0) {
          parts.push("\n\n💡 Cross-database queries: Use `alias.table_name` syntax, e.g. `SELECT * FROM attached_alias.users LIMIT 10`");
        }

        return {
          content: [{ type: "text", text: parts.join("\n") }],
          details: {
            toolName: "list_datasets",
            count: tableEntries.length,
            localCount: localTables.length,
            attachedCount: attachedTables.length,
            tables: tableEntries,
          },
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Error listing datasets: ${err}` }],
          details: { toolName: "list_datasets", error: String(err) },
        };
      }
    },
  };
}
